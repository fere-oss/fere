import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { GraphNode } from '../types/electron';
import type { ContainerLogData } from '../types/electron';
import { getTypeBadge } from './graph/constants';

interface ContainerLogsTabProps {
  containers: GraphNode[];
  initialSelectedId?: string;
}

interface UnifiedLogEntry {
  id: string;
  containerId: string;
  containerName: string;
  containerColor: string;
  line: string;
  timestamp: string | null;
  stream: 'stdout' | 'stderr';
  level: 'error' | 'warn' | 'info' | 'debug' | 'unknown';
  formattedTime: string;
}

// Color palette for containers - visually distinct colors
const CONTAINER_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#ef4444', // red
  '#84cc16', // lime
  '#f97316', // orange
  '#6366f1', // indigo
];

// Detect log level from log line
function detectLogLevel(line: string): UnifiedLogEntry['level'] {
  const lowerLine = line.toLowerCase();
  if (lowerLine.match(/\b(error|err|fatal|critical|exception)\b/)) return 'error';
  if (lowerLine.match(/\b(warn|warning)\b/)) return 'warn';
  if (lowerLine.match(/\b(debug|trace)\b/)) return 'debug';
  if (lowerLine.match(/\b(info)\b/)) return 'info';
  return 'unknown';
}

export function ContainerLogsTab({ containers, initialSelectedId }: ContainerLogsTabProps) {
  // Track which containers are selected for logging
  const [selectedContainerIds, setSelectedContainerIds] = useState<Set<string>>(new Set());
  // Track if initial selection has been applied
  const initialSelectionAppliedRef = useRef(false);
  // Track which containers are actively streaming
  const [activeStreams, setActiveStreams] = useState<Map<string, string>>(new Map()); // containerId -> streamId
  // Unified log entries from all containers
  const [logs, setLogs] = useState<UnifiedLogEntry[]>([]);
  // UI state
  const [isPaused, setIsPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [filterLevel, setFilterLevel] = useState<'all' | 'error' | 'warn' | 'info' | 'debug'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchRegex, setSearchRegex] = useState<RegExp | null>(null);

  const logsContainerRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef<UnifiedLogEntry[]>([]);

  // Assign colors to containers
  const containerColorMap = useMemo(() => {
    const map = new Map<string, string>();
    containers.forEach((container, idx) => {
      if (container.containerId) {
        map.set(container.containerId, CONTAINER_COLORS[idx % CONTAINER_COLORS.length]);
      }
    });
    return map;
  }, [containers]);

  // Container lookup by ID
  const containerMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    containers.forEach(c => {
      if (c.containerId) map.set(c.containerId, c);
    });
    return map;
  }, [containers]);

  // Process search query into regex
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchRegex(null);
      return;
    }
    try {
      setSearchRegex(new RegExp(searchQuery, 'gi'));
    } catch {
      setSearchRegex(null);
    }
  }, [searchQuery]);

  // Auto-scroll when follow is enabled
  useEffect(() => {
    if (follow && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, follow]);

  // Flush buffer to logs every 100ms
  useEffect(() => {
    const interval = setInterval(() => {
      if (bufferRef.current.length > 0 && !isPaused) {
        setLogs(prev => {
          const newLogs = [...prev, ...bufferRef.current];
          // Keep only last 5000 logs for performance
          return newLogs.slice(-5000);
        });
        bufferRef.current = [];
      }
    }, 100);
    return () => clearInterval(interval);
  }, [isPaused]);

  // Handle incoming log data
  const handleLogData = useCallback((data: ContainerLogData) => {
    const container = containerMap.get(data.containerId);
    if (!container) return;

    const entry: UnifiedLogEntry = {
      id: `${data.containerId}-${Date.now()}-${Math.random()}`,
      containerId: data.containerId,
      containerName: container.name,
      containerColor: containerColorMap.get(data.containerId) || '#6B7280',
      line: data.line,
      timestamp: data.timestamp || null,
      stream: data.stream,
      level: detectLogLevel(data.line),
      formattedTime: data.timestamp
        ? new Date(data.timestamp).toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 })
        : new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 }),
    };

    bufferRef.current.push(entry);
  }, [containerMap, containerColorMap]);

  // Set up event listeners
  useEffect(() => {
    const removeDataListener = window.electronAPI.onContainerLogData(handleLogData);
    const removeErrorListener = window.electronAPI.onContainerLogError((data) => {
      console.error('Log error:', data);
    });
    const removeCloseListener = window.electronAPI.onContainerLogClose((data) => {
      setActiveStreams(prev => {
        const next = new Map(prev);
        next.delete(data.containerId);
        return next;
      });
    });

    return () => {
      removeDataListener();
      removeErrorListener();
      removeCloseListener();
    };
  }, [handleLogData]);

  // Start streaming for a container
  const startStream = useCallback(async (containerId: string) => {
    if (activeStreams.has(containerId)) return;

    try {
      const result = await window.electronAPI.startContainerLogs(containerId, {
        tail: 50,
        timestamps: true,
        follow: true,
      });

      if (result.success && result.streamId) {
        const streamId = result.streamId;
        setActiveStreams(prev => new Map(prev).set(containerId, streamId));
      }
    } catch (err) {
      console.error('Failed to start stream:', err);
    }
  }, [activeStreams]);

  // Stop streaming for a container
  const stopStream = useCallback(async (containerId: string) => {
    const streamId = activeStreams.get(containerId);
    if (!streamId) return;

    try {
      await window.electronAPI.stopContainerLogs(streamId);
      setActiveStreams(prev => {
        const next = new Map(prev);
        next.delete(containerId);
        return next;
      });
    } catch (err) {
      console.error('Failed to stop stream:', err);
    }
  }, [activeStreams]);

  // Toggle container selection
  const toggleContainer = useCallback((containerId: string) => {
    setSelectedContainerIds(prev => {
      const next = new Set(prev);
      if (next.has(containerId)) {
        next.delete(containerId);
        stopStream(containerId);
      } else {
        next.add(containerId);
        startStream(containerId);
      }
      return next;
    });
  }, [startStream, stopStream]);

  // Select all containers
  const selectAll = useCallback(() => {
    containers.forEach(c => {
      if (c.containerId && !selectedContainerIds.has(c.containerId)) {
        setSelectedContainerIds(prev => new Set(prev).add(c.containerId!));
        startStream(c.containerId);
      }
    });
  }, [containers, selectedContainerIds, startStream]);

  // Deselect all containers
  const deselectAll = useCallback(() => {
    selectedContainerIds.forEach(id => stopStream(id));
    setSelectedContainerIds(new Set());
  }, [selectedContainerIds, stopStream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      activeStreams.forEach((streamId) => {
        window.electronAPI.stopContainerLogs(streamId).catch(console.error);
      });
    };
  }, []);

  // Handle initial container selection from navigation
  useEffect(() => {
    if (initialSelectedId && !initialSelectionAppliedRef.current) {
      // Find container with matching containerId
      const container = containers.find(c => c.containerId === initialSelectedId);
      if (container?.containerId) {
        initialSelectionAppliedRef.current = true;
        setSelectedContainerIds(new Set([container.containerId]));
        startStream(container.containerId);
      }
    }
  }, [initialSelectedId, containers, startStream]);

  // Filter logs
  const filteredLogs = useMemo(() => {
    let filtered = logs.filter(log => selectedContainerIds.has(log.containerId));

    if (filterLevel !== 'all') {
      filtered = filtered.filter(log => log.level === filterLevel);
    }

    if (searchRegex) {
      filtered = filtered.filter(log => searchRegex.test(log.line));
    }

    return filtered;
  }, [logs, selectedContainerIds, filterLevel, searchRegex]);

  // Clear logs
  const handleClear = useCallback(() => {
    setLogs([]);
    bufferRef.current = [];
  }, []);

  // Copy logs
  const handleCopy = useCallback(() => {
    const text = filteredLogs.map(log =>
      `[${log.formattedTime}] [${log.containerName}] ${log.line}`
    ).join('\n');
    navigator.clipboard.writeText(text).catch(console.error);
  }, [filteredLogs]);

  // Highlight search matches
  const highlightMatches = useCallback((line: string) => {
    if (!searchRegex) return line;

    const parts: { text: string; match: boolean }[] = [];
    let lastIndex = 0;
    let match;
    searchRegex.lastIndex = 0;

    while ((match = searchRegex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: line.substring(lastIndex, match.index), match: false });
      }
      parts.push({ text: match[0], match: true });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
      parts.push({ text: line.substring(lastIndex), match: false });
    }

    return parts.length === 0 ? line : parts;
  }, [searchRegex]);

  if (containers.length === 0) {
    return (
      <div className="logs-tab-empty">
        <div className="logs-tab-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </div>
        <p>No containers available</p>
        <span>Start some Docker containers to view logs</span>
      </div>
    );
  }

  return (
    <div className="unified-logs">
      {/* Container Selection Bar */}
      <div className="unified-logs-containers">
        <div className="unified-logs-containers-header">
          <span className="unified-logs-containers-title">Containers</span>
          <div className="unified-logs-containers-actions">
            <button onClick={selectAll} className="unified-logs-action-btn">All</button>
            <button onClick={deselectAll} className="unified-logs-action-btn">None</button>
          </div>
        </div>
        <div className="unified-logs-container-chips">
          {containers.map(container => {
            if (!container.containerId) return null;
            const isSelected = selectedContainerIds.has(container.containerId);
            const isStreaming = activeStreams.has(container.containerId);
            const color = containerColorMap.get(container.containerId) || '#6B7280';

            return (
              <button
                key={container.containerId}
                className={`unified-logs-chip ${isSelected ? 'unified-logs-chip-selected' : ''}`}
                onClick={() => toggleContainer(container.containerId!)}
                style={{
                  '--chip-color': color,
                  borderColor: isSelected ? color : undefined,
                  backgroundColor: isSelected ? `${color}15` : undefined,
                } as React.CSSProperties}
              >
                <div
                  className="unified-logs-chip-dot"
                  style={{
                    backgroundColor: isSelected ? color : '#9CA3AF',
                    boxShadow: isStreaming ? `0 0 6px ${color}` : undefined,
                  }}
                />
                <span className="unified-logs-chip-name">{container.name}</span>
                <span className="unified-logs-chip-badge">{getTypeBadge(container.type)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Toolbar */}
      <div className="unified-logs-toolbar">
        <div className="unified-logs-toolbar-section">
          <button
            className={`unified-logs-btn ${isPaused ? 'active' : ''}`}
            onClick={() => setIsPaused(!isPaused)}
            title={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            )}
          </button>
          <button
            className={`unified-logs-btn ${follow ? 'active' : ''}`}
            onClick={() => setFollow(!follow)}
            title="Auto-scroll"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12l7 7 7-7"/>
            </svg>
          </button>
          <button className="unified-logs-btn" onClick={handleClear} title="Clear">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
          <button className="unified-logs-btn" onClick={handleCopy} title="Copy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>

        <div className="unified-logs-toolbar-section">
          <label className="unified-logs-checkbox">
            <input
              type="checkbox"
              checked={showTimestamps}
              onChange={(e) => setShowTimestamps(e.target.checked)}
            />
            Time
          </label>

          <select
            className="unified-logs-select"
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
            className="unified-logs-search"
            type="text"
            placeholder="Search (regex)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="unified-logs-toolbar-section">
          <span className="unified-logs-stats">
            {filteredLogs.length} lines from {selectedContainerIds.size} containers
          </span>
        </div>
      </div>

      {/* Logs Output */}
      <div className="unified-logs-output" ref={logsContainerRef}>
        {selectedContainerIds.size === 0 ? (
          <div className="unified-logs-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            <h3>Select containers to stream logs</h3>
            <p>Click on container chips above to start viewing their logs in real-time</p>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="unified-logs-waiting">
            <div className="unified-logs-spinner" />
            <span>Waiting for logs...</span>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const highlighted = highlightMatches(log.line);

            return (
              <div
                key={log.id}
                className={`unified-log-line unified-log-level-${log.level} unified-log-stream-${log.stream}`}
              >
                {showTimestamps && (
                  <span className="unified-log-time">{log.formattedTime}</span>
                )}
                <span
                  className="unified-log-container"
                  style={{ color: log.containerColor }}
                >
                  {log.containerName}
                </span>
                <span className={`unified-log-stream unified-log-stream-${log.stream}`}>
                  {log.stream === 'stderr' ? 'ERR' : 'OUT'}
                </span>
                <span className="unified-log-text">
                  {typeof highlighted === 'string' ? (
                    highlighted
                  ) : (
                    highlighted.map((part, i) => (
                      part.match ? (
                        <mark key={i} className="unified-log-highlight">{part.text}</mark>
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
