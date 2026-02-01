const { spawn } = require('child_process');

// Active log streams: Map<streamId, { process, containerId, onData, onError, onClose }>
const activeStreams = new Map();

// Generate unique stream ID
function generateStreamId() {
  return `stream-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
function startLogStream(containerId, options = {}, onData, onError, onClose) {
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

  // Spawn docker logs process
  const dockerProcess = spawn('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const streamId = generateStreamId();

  // Buffer for partial lines
  let stdoutBuffer = '';
  let stderrBuffer = '';

  // Helper to process buffered data
  const processBuffer = (buffer, stream) => {
    const lines = buffer.split('\n');

    // Keep the last incomplete line in the buffer
    const incompleteLine = lines.pop() || '';

    // Emit each complete line
    lines.forEach(line => {
      if (line.trim()) {
        // Parse timestamp if present
        let timestamp = null;
        let logLine = line;

        if (timestamps) {
          const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/);
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
    });

    return incompleteLine;
  };

  // Handle stdout data
  dockerProcess.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    stdoutBuffer = processBuffer(stdoutBuffer, 'stdout');
  });

  // Handle stderr data
  dockerProcess.stderr.on('data', (data) => {
    stderrBuffer += data.toString();
    stderrBuffer = processBuffer(stderrBuffer, 'stderr');
  });

  // Handle process errors
  dockerProcess.on('error', (error) => {
    onError(new Error(`Docker logs process error: ${error.message}`));
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
    onClose(code);
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
      if (!stream.process.killed) {
        stream.process.kill('SIGKILL');
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
