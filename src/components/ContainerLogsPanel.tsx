import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ContainerLogData, ContainerLogError, ContainerLogClose } from '../types/electron';

interface LogEntry extends ContainerLogData {
  id: string;
  level: 'error' | 'warn' | 'info' | 'debug' | 'unknown';
  formattedTime: string;
}

interface ContainerLogsPanelProps {
  containerId: string;
  containerName: string;
}

// Container colors for multi-container support
const CONTAINER_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
];

// Detect log level from log line
function detectLogLevel(line: string): LogEntry['level'] {
  const lowerLine = line.toLowerCase();
  if (lowerLine.match(/\b(error|err|fatal|critical)\b/)) return 'error';
  if (lowerLine.match(/\b(warn|warning)\b/)) return 'warn';
  if (lowerLine.match(/\b(debug|trace)\b/)) return 'debug';
  if (lowerLine.match(/\b(info)\b/)) return 'info';
  return 'unknown';
}

export function ContainerLogsPanel({ containerId, containerName }: ContainerLogsPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [filterLevel, setFilterLevel] = useState<'all' | 'error' | 'warn' | 'info' | 'debug'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchRegex, setSearchRegex] = useState<RegExp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const logsContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef<boolean>(follow);
  const bufferRef = useRef<LogEntry[]>([]);

  // Update autoScrollRef when follow changes
  useEffect(() => {
    autoScrollRef.current = follow;
  }, [follow]);

  // Process search query into regex
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchRegex(null);
      return;
    }

    try {
      const regex = new RegExp(searchQuery, 'gi');
      setSearchRegex(regex);
    } catch (e) {
      // Invalid regex, ignore
      setSearchRegex(null);
    }
  }, [searchQuery]);

  // Auto-scroll to bottom when follow is enabled
  useEffect(() => {
    if (follow && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, follow]);

  // Flush buffer to logs every 100ms (debounced updates for performance)
  useEffect(() => {
    const interval = setInterval(() => {
      if (bufferRef.current.length > 0 && !isPaused) {
        setLogs(prev => [...prev, ...bufferRef.current]);
        bufferRef.current = [];
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isPaused]);

  // Handle incoming log data
  const handleLogData = useCallback((data: ContainerLogData) => {
    // Only process logs for this container
    if (data.containerId !== containerId) return;

    const logEntry: LogEntry = {
      ...data,
      id: `${data.streamId}-${Date.now()}-${Math.random()}`,
      level: detectLogLevel(data.line),
      formattedTime: data.timestamp
        ? new Date(data.timestamp).toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 })
        : new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 }),
    };

    bufferRef.current.push(logEntry);
  }, [containerId]);

  // Handle log errors
  const handleLogError = useCallback((data: ContainerLogError) => {
    if (data.containerId !== containerId) return;
    setError(data.error);
  }, [containerId]);

  // Handle log stream close
  const handleLogClose = useCallback((data: ContainerLogClose) => {
    if (data.containerId !== containerId) return;
    setIsStreaming(false);
    setStreamId(null);
  }, [containerId]);

  // Set up event listeners
  useEffect(() => {
    const removeDataListener = window.electronAPI.onContainerLogData(handleLogData);
    const removeErrorListener = window.electronAPI.onContainerLogError(handleLogError);
    const removeCloseListener = window.electronAPI.onContainerLogClose(handleLogClose);

    return () => {
      removeDataListener();
      removeErrorListener();
      removeCloseListener();
    };
  }, [handleLogData, handleLogError, handleLogClose]);

  // Start streaming logs
  const startStreaming = useCallback(async () => {
    try {
      setError(null);
      const result = await window.electronAPI.startContainerLogs(containerId, {
        tail: 100,
        timestamps: true,
        follow: true,
      });

      if (result.success && result.streamId) {
        setStreamId(result.streamId);
        setIsStreaming(true);
      } else {
        setError(result.error || 'Failed to start log stream');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start log stream');
    }
  }, [containerId]);

  // Stop streaming logs
  const stopStreaming = useCallback(async () => {
    if (!streamId) return;

    try {
      await window.electronAPI.stopContainerLogs(streamId);
      setIsStreaming(false);
      setStreamId(null);
    } catch (err) {
      console.error('Error stopping logs:', err);
    }
  }, [streamId]);

  // Auto-start streaming on mount
  useEffect(() => {
    startStreaming();
    return () => {
      if (streamId) {
        window.electronAPI.stopContainerLogs(streamId).catch(console.error);
      }
    };
  }, []); // Only run on mount

  // Filter logs based on level and search
  const filteredLogs = useMemo(() => {
    let filtered = logs;

    // Filter by level
    if (filterLevel !== 'all') {
      filtered = filtered.filter(log => log.level === filterLevel);
    }

    // Filter by search query
    if (searchRegex) {
      filtered = filtered.filter(log => searchRegex.test(log.line));
    }

    return filtered;
  }, [logs, filterLevel, searchRegex]);

  // Clear logs
  const handleClear = useCallback(() => {
    setLogs([]);
    bufferRef.current = [];
  }, []);

  // Copy logs to clipboard
  const handleCopy = useCallback(() => {
    const text = filteredLogs.map(log =>
      `[${log.formattedTime}] [${log.stream}] ${log.line}`
    ).join('\n');

    navigator.clipboard.writeText(text).catch(console.error);
  }, [filteredLogs]);

  // Export logs to file
  const handleExport = useCallback(() => {
    const text = filteredLogs.map(log =>
      `[${log.formattedTime}] [${log.stream}] ${log.line}`
    ).join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${containerName}-logs-${new Date().toISOString().split('T')[0]}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs, containerName]);

  // Highlight search matches in log line
  const highlightMatches = useCallback((line: string) => {
    if (!searchRegex) return line;

    const parts: { text: string; match: boolean }[] = [];
    let lastIndex = 0;
    let match;

    // Reset regex lastIndex
    searchRegex.lastIndex = 0;

    while ((match = searchRegex.exec(line)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        parts.push({ text: line.substring(lastIndex, match.index), match: false });
      }
      // Add matched text
      parts.push({ text: match[0], match: true });
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < line.length) {
      parts.push({ text: line.substring(lastIndex), match: false });
    }

    return parts.length === 0 ? line : parts;
  }, [searchRegex]);

  return (
    <div className="container-logs-panel">
      {/* Toolbar */}
      <div className="logs-toolbar">
        <div className="logs-toolbar-section">
          <button
            className={`logs-btn ${isStreaming ? 'active' : ''}`}
            onClick={isStreaming ? stopStreaming : startStreaming}
            title={isStreaming ? 'Stop streaming' : 'Start streaming'}
          >
            {isStreaming ? '⏸' : '▶'}
          </button>
          <button
            className={`logs-btn ${isPaused ? 'active' : ''}`}
            onClick={() => setIsPaused(!isPaused)}
            title={isPaused ? 'Resume' : 'Pause'}
            disabled={!isStreaming}
          >
            {isPaused ? '▶' : '⏸'}
          </button>
          <button
            className={`logs-btn ${follow ? 'active' : ''}`}
            onClick={() => setFollow(!follow)}
            title="Auto-scroll to bottom"
          >
            ↓
          </button>
          <button
            className="logs-btn"
            onClick={handleClear}
            title="Clear logs"
          >
            🗑
          </button>
        </div>

        <div className="logs-toolbar-section">
          <label className="logs-checkbox">
            <input
              type="checkbox"
              checked={showTimestamps}
              onChange={(e) => setShowTimestamps(e.target.checked)}
            />
            Timestamps
          </label>

          <select
            className="logs-filter-select"
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value as typeof filterLevel)}
          >
            <option value="all">All Levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>

          <input
            className="logs-search-input"
            type="text"
            placeholder="Search (regex)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="logs-toolbar-section">
          <button className="logs-btn" onClick={handleCopy} title="Copy to clipboard">
            📋
          </button>
          <button className="logs-btn" onClick={handleExport} title="Export to file">
            💾
          </button>
          <span className="logs-count">{filteredLogs.length} lines</span>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="logs-error">
          ⚠️ {error}
        </div>
      )}

      {/* Logs container */}
      <div className="logs-container" ref={logsContainerRef}>
        {filteredLogs.length === 0 ? (
          <div className="logs-empty">
            {isStreaming ? 'Waiting for logs...' : 'No logs to display'}
          </div>
        ) : (
          filteredLogs.map((log) => {
            const highlighted = highlightMatches(log.line);

            return (
              <div
                key={log.id}
                className={`log-line log-level-${log.level} log-stream-${log.stream}`}
              >
                {showTimestamps && (
                  <span className="log-timestamp">{log.formattedTime}</span>
                )}
                <span className={`log-stream-badge log-stream-${log.stream}`}>
                  {log.stream === 'stderr' ? 'ERR' : 'OUT'}
                </span>
                <span className="log-text">
                  {typeof highlighted === 'string' ? (
                    highlighted
                  ) : (
                    highlighted.map((part, i) => (
                      part.match ? (
                        <mark key={i} className="log-highlight">{part.text}</mark>
                      ) : (
                        <span key={i}>{part.text}</span>
                      )
                    ))
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
