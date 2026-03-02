const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/;
const DOCKER_EXEC_TIMEOUT_MS = 3000;
const DOCKER_BIN_CANDIDATES = [
  process.env.FERE_DOCKER_BIN,
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  'docker',
].filter(Boolean);
let resolvedDockerBin = null;

// Active log streams: Map<streamId, { process, containerId, onData, onError, onClose }>
const activeStreams = new Map();

// Generate unique stream ID
function generateStreamId() {
  return `stream-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function getDockerBinaries() {
  const bins = [];
  for (const bin of DOCKER_BIN_CANDIDATES) {
    if (bin.includes('/') && !fs.existsSync(bin)) continue;
    bins.push(bin);
  }
  return bins.length > 0 ? bins : ['docker'];
}

// Probe all candidates in parallel so worst-case time = one timeout (3s)
// instead of N × timeout (Bug 29).
async function resolveDockerBinary() {
  if (resolvedDockerBin) return resolvedDockerBin;

  const candidates = getDockerBinaries();
  try {
    resolvedDockerBin = await Promise.any(
      candidates.map(async (candidate) => {
        await execFileAsync(candidate, ['version', '--format', '{{.Client.Version}}'], {
          timeout: DOCKER_EXEC_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
        return candidate;
      })
    );
    return resolvedDockerBin;
  } catch {
    resolvedDockerBin = null;
    return null;
  }
}

/**
 * Start streaming logs from a Docker container
 * @param {string} containerId - Docker container ID
 * @param {object} options - Streaming options
 * @param {number} options.tail - Number of lines to show initially (default: 100)
 * @param {boolean} options.timestamps - Include timestamps (default: false)
 * @param {boolean} options.follow - Follow log output (default: true)
 * @param {function} onData - Callback for log data: (data: { line: string, timestamp?: string, stream: 'stdout'|'stderr' }) => void
 * @param {function} onError - Callback for errors: (error: Error) => void
 * @param {function} onClose - Callback when stream closes: (code: number) => void
 * @returns {string} streamId - Unique identifier for this stream
 */
async function startLogStream(containerId, options = {}, onData, onError, onClose) {
  const {
    tail = 100,
    timestamps = false,
    follow = true,
  } = options;

  // Build docker logs command arguments
  const args = ['logs'];

  if (follow) {
    args.push('--follow');
  }

  if (tail > 0) {
    args.push('--tail', tail.toString());
  }

  if (timestamps) {
    args.push('--timestamps');
  }

  // Add container ID
  args.push(containerId);

  const dockerBin = await resolveDockerBinary();
  if (!dockerBin) {
    throw new Error(
      'Docker CLI not found. Tried: ' + getDockerBinaries().join(', ')
    );
  }

  // Spawn docker logs process
  const dockerProcess = spawn(dockerBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const streamId = generateStreamId();

  // Buffer for partial lines
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MB — prevent unbounded growth (Bug 26)

  // Helper to process buffered data
  const processBuffer = (buffer, stream) => {
    const lines = buffer.split('\n');

    // Keep the last incomplete line in the buffer
    const incompleteLine = lines.pop() || '';

    // Emit each complete line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim()) {
        // Parse timestamp if present
        let timestamp = null;
        let logLine = line;

        if (timestamps) {
          const timestampMatch = line.match(TIMESTAMP_RE);
          if (timestampMatch) {
            timestamp = timestampMatch[1];
            logLine = timestampMatch[2];
          }
        }

        onData({
          line: logLine,
          timestamp,
          stream,
          containerId,
          streamId,
        });
      }
    }

    return incompleteLine;
  };

  // Handle stdout data — cap buffer to prevent memory exhaustion (Bug 26)
  dockerProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    if (stdoutBuffer.length > MAX_BUFFER_SIZE) {
      // Flush complete lines and keep the trailing incomplete fragment.
      // The old code discarded the incomplete line on overflow.
      const remaining = processBuffer(stdoutBuffer, 'stdout');
      // If a single line exceeds the cap (no newlines at all), force-emit it
      // truncated rather than letting it grow forever.
      stdoutBuffer = remaining.length > MAX_BUFFER_SIZE
        ? (processBuffer(remaining + '\n', 'stdout'), '')
        : remaining;
    } else {
      stdoutBuffer = processBuffer(stdoutBuffer, 'stdout');
    }
  });

  // Handle stderr data — same overflow strategy as stdout (Bug 26)
  dockerProcess.stderr.on('data', (data) => {
    stderrBuffer += data.toString();
    if (stderrBuffer.length > MAX_BUFFER_SIZE) {
      const remaining = processBuffer(stderrBuffer, 'stderr');
      stderrBuffer = remaining.length > MAX_BUFFER_SIZE
        ? (processBuffer(remaining + '\n', 'stderr'), '')
        : remaining;
    } else {
      stderrBuffer = processBuffer(stderrBuffer, 'stderr');
    }
  });

  // Handle process errors — pass streamId so callers don't rely on a closure
  // that may not yet be assigned (Bug 24).
  dockerProcess.on('error', (error) => {
    onError(new Error(`Docker logs process error: ${error.message}`), streamId);
  });

  // Handle process close
  dockerProcess.on('close', (code) => {
    // Process any remaining buffered data
    if (stdoutBuffer.trim()) {
      processBuffer(stdoutBuffer + '\n', 'stdout');
    }
    if (stderrBuffer.trim()) {
      processBuffer(stderrBuffer + '\n', 'stderr');
    }

    activeStreams.delete(streamId);
    onClose(code, streamId);
  });

  // Store the stream
  activeStreams.set(streamId, {
    process: dockerProcess,
    containerId,
    onData,
    onError,
    onClose,
    startedAt: Date.now(),
  });

  return streamId;
}

/**
 * Stop a log stream
 * @param {string} streamId - Stream ID to stop
 * @returns {boolean} true if stream was stopped, false if not found
 */
function stopLogStream(streamId) {
  const stream = activeStreams.get(streamId);

  if (!stream) {
    return false;
  }

  try {
    // Kill the docker logs process
    stream.process.kill('SIGTERM');

    // Give it a moment to close gracefully
    setTimeout(() => {
      try {
        if (!stream.process.killed) {
          stream.process.kill('SIGKILL');
        }
      } catch {
        // Process already exited
      }
    }, 1000);

    activeStreams.delete(streamId);
    return true;
  } catch (error) {
    console.error(`Error stopping log stream ${streamId}:`, error);
    return false;
  }
}

/**
 * Stop all log streams for a specific container
 * @param {string} containerId - Container ID
 * @returns {number} Number of streams stopped
 */
function stopContainerStreams(containerId) {
  let count = 0;

  for (const [streamId, stream] of activeStreams.entries()) {
    if (stream.containerId === containerId) {
      if (stopLogStream(streamId)) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Stop all active log streams
 */
function stopAllStreams() {
  const streamIds = Array.from(activeStreams.keys());
  streamIds.forEach(stopLogStream);
}

/**
 * Get active stream count
 * @returns {number} Number of active streams
 */
function getActiveStreamCount() {
  return activeStreams.size;
}

/**
 * Get info about active streams
 * @returns {Array} Array of stream info objects
 */
function getActiveStreams() {
  return Array.from(activeStreams.entries()).map(([streamId, stream]) => ({
    streamId,
    containerId: stream.containerId,
    startedAt: stream.startedAt,
  }));
}

module.exports = {
  startLogStream,
  stopLogStream,
  stopContainerStreams,
  stopAllStreams,
  getActiveStreamCount,
  getActiveStreams,
};
