import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { List, useListRef } from 'react-window';
import type { RowComponentProps } from 'react-window';
import type { GraphNode } from '../types/electron';
import type { ContainerLogData } from '../types/electron';

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

const LOG_ROW_HEIGHT = 28;

interface LogRowProps {
  logs: UnifiedLogEntry[];
  showTimestamps: boolean;
  highlightMatches: (line: string) => string | { text: string; match: boolean }[];
}

const LOG_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour12: true,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

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

// Pre-compiled regexes for log level detection — avoids recompilation per log line
const LOG_LEVEL_ERROR_RE = /\b(error|err|fatal|critical|exception)\b/i;
const LOG_LEVEL_WARN_RE = /\b(warn|warning)\b/i;
const LOG_LEVEL_DEBUG_RE = /\b(debug|trace)\b/i;
const LOG_LEVEL_INFO_RE = /\b(info)\b/i;

// Detect log level from log line
function detectLogLevel(line: string): UnifiedLogEntry['level'] {
  if (LOG_LEVEL_ERROR_RE.test(line)) return 'error';
  if (LOG_LEVEL_WARN_RE.test(line)) return 'warn';
  if (LOG_LEVEL_DEBUG_RE.test(line)) return 'debug';
  if (LOG_LEVEL_INFO_RE.test(line)) return 'info';
  return 'unknown';
}

// Hoisted to module level — constant array, no need to memoize per instance
const FILTER_OPTIONS = [
  { value: 'all' as const, label: 'All Levels' },
  { value: 'error' as const, label: 'Errors' },
  { value: 'warn' as const, label: 'Warnings' },
  { value: 'info' as const, label: 'Info' },
  { value: 'debug' as const, label: 'Debug' },
];

const LogRow = memo(({ index, style, logs, showTimestamps, highlightMatches }: RowComponentProps<LogRowProps>) => {
  const log = logs[index];
  const highlighted = highlightMatches(log.line);

  return (
    <div
      style={style}
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
      <span className="unified-log-text" title={log.line}>
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
});

export function ContainerLogsTab({ containers, initialSelectedId }: ContainerLogsTabProps) {
  // Track which containers are selected for logging
  const [selectedContainerIds, setSelectedContainerIds] = useState<Set<string>>(new Set());
  // Track if initial selection has been applied
  const initialSelectionAppliedRef = useRef<string | null>(null);
  // Track which containers are actively streaming
  const [activeStreams, setActiveStreams] = useState<Map<string, string>>(new Map()); // containerId -> streamId
  const activeStreamsRef = useRef(activeStreams);
  // Track containers with in-flight start/stop to prevent duplicate spawns
  const pendingStreamsRef = useRef(new Set<string>());
  // Unified log entries from all containers
  const [logs, setLogs] = useState<UnifiedLogEntry[]>([]);
  // UI state
  const [isPaused, setIsPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [filterLevel, setFilterLevel] = useState<'all' | 'error' | 'warn' | 'info' | 'debug'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTestRegex, setSearchTestRegex] = useState<RegExp | null>(null);
  const [searchHighlightRegex, setSearchHighlightRegex] = useState<RegExp | null>(null);
  const [searchRegexError, setSearchRegexError] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const logsContainerRef = useRef<HTMLDivElement>(null);
  const listRef = useListRef(null);
  const bufferRef = useRef<UnifiedLogEntry[]>([]);
  const filterRef = useRef<HTMLDivElement>(null);

  const filterOptions = FILTER_OPTIONS;

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

  // Close custom select on outside click
  useEffect(() => {
    if (!isFilterOpen) return;
    const onClick = (event: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [isFilterOpen]);

  useEffect(() => {
    activeStreamsRef.current = activeStreams;
  }, [activeStreams]);

  // Process search query into regex
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchTestRegex(null);
      setSearchHighlightRegex(null);
      setSearchRegexError(false);
      return;
    }
    try {
      // Filtering must use a non-global regex; global regexes mutate lastIndex
      // on .test() and can cause intermittent false negatives.
      setSearchTestRegex(new RegExp(searchQuery, 'i'));
      setSearchHighlightRegex(new RegExp(searchQuery, 'gi'));
      setSearchRegexError(false);
    } catch {
      setSearchTestRegex(null);
      setSearchHighlightRegex(null);
      setSearchRegexError(true);
    }
  }, [searchQuery]);

  // Keep selection/streams in sync with currently available containers.
  useEffect(() => {
    const availableIds = new Set(
      containers
        .map((c) => c.containerId)
        .filter((id): id is string => Boolean(id)),
    );

    setSelectedContainerIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (availableIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    if (!window.electronAPI?.stopContainerLogs) return;

    const staleStreams: Array<{ containerId: string; streamId: string }> = [];
    activeStreamsRef.current.forEach((streamId, containerId) => {
      if (!availableIds.has(containerId)) {
        staleStreams.push({ containerId, streamId });
      }
    });

    if (staleStreams.length === 0) return;

    staleStreams.forEach(({ streamId }) => {
      window.electronAPI?.stopContainerLogs?.(streamId).catch(console.error);
    });

    setActiveStreams((prev) => {
      const next = new Map(prev);
      staleStreams.forEach(({ containerId }) => next.delete(containerId));
      return next;
    });
  }, [containers]);

  // Flush buffer to logs every 100ms — always flush even when paused so data
  // is never silently discarded.  The 5000-line cap prevents memory issues.
  // Pausing only freezes auto-scroll; the user sees new lines when they resume.
  useEffect(() => {
    const interval = setInterval(() => {
      if (bufferRef.current.length > 0) {
        const batch = bufferRef.current;
        bufferRef.current = [];
        setLogs(prev => {
          const newLogs = [...prev, ...batch];
          return newLogs.slice(-5000);
        });
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

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
      formattedTime: LOG_TIME_FORMATTER.format(
        data.timestamp ? new Date(data.timestamp) : new Date()
      ),
    };

    bufferRef.current.push(entry);
  }, [containerMap, containerColorMap]);

  // Set up event listeners
  useEffect(() => {
    // Guard: only set up listeners if Electron APIs are available
    if (!window.electronAPI?.onContainerLogData) return;

    const removeDataListener = window.electronAPI.onContainerLogData(handleLogData);
    const removeErrorListener = window.electronAPI.onContainerLogError?.((data) => {
      console.error('Log error:', data);
    });
    const removeCloseListener = window.electronAPI.onContainerLogClose?.((data) => {
      setActiveStreams(prev => {
        const next = new Map(prev);
        next.delete(data.containerId);
        return next;
      });
    });

    return () => {
      removeDataListener();
      removeErrorListener?.();
      removeCloseListener?.();
    };
  }, [handleLogData]);

  // Start streaming for a container.
  // Uses refs instead of state to avoid stale-closure races when multiple
  // calls arrive before the first setActiveStreams re-render (Bug 25/28).
  const startStream = useCallback(async (containerId: string) => {
    if (activeStreamsRef.current.has(containerId)) return;
    if (pendingStreamsRef.current.has(containerId)) return;
    if (!window.electronAPI?.startContainerLogs) return;

    pendingStreamsRef.current.add(containerId);
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
    } finally {
      pendingStreamsRef.current.delete(containerId);
    }
  }, []);

  // Stop streaming for a container — reads from ref to avoid stale closure.
  const stopStream = useCallback(async (containerId: string) => {
    pendingStreamsRef.current.delete(containerId);
    const streamId = activeStreamsRef.current.get(containerId);
    if (!streamId) return;
    if (!window.electronAPI?.stopContainerLogs) return;

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
  }, []);

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

  // Select all containers — single batched state update.
  // Use Promise.allSettled so one failed stream doesn't block the rest,
  // and all calls are properly awaited instead of fire-and-forget (Bug 25/28).
  const selectAll = useCallback(() => {
    const toStart: string[] = [];
    setSelectedContainerIds(prev => {
      const next = new Set(prev);
      containers.forEach(c => {
        if (c.containerId && !next.has(c.containerId)) {
          next.add(c.containerId);
          toStart.push(c.containerId);
        }
      });
      return next;
    });
    Promise.allSettled(toStart.map(id => startStream(id)));
  }, [containers, startStream]);

  // Deselect all containers
  const deselectAll = useCallback(() => {
    selectedContainerIds.forEach(id => stopStream(id));
    setSelectedContainerIds(new Set());
  }, [selectedContainerIds, stopStream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (!window.electronAPI?.stopContainerLogs) return;
      activeStreamsRef.current.forEach((streamId) => {
        window.electronAPI.stopContainerLogs(streamId).catch(console.error);
      });
    };
  }, []);

  // Handle initial container selection from navigation
  useEffect(() => {
    if (initialSelectedId && initialSelectionAppliedRef.current !== initialSelectedId) {
      // Find container with matching containerId
      const container = containers.find(c => c.containerId === initialSelectedId);
      if (container?.containerId) {
        initialSelectionAppliedRef.current = initialSelectedId;
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

    if (searchTestRegex) {
      filtered = filtered.filter(log => searchTestRegex.test(log.line));
    }

    return filtered;
  }, [logs, selectedContainerIds, filterLevel, searchTestRegex]);

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
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(text).catch(console.error);
  }, [filteredLogs]);

  // Highlight search matches
  const highlightMatches = useCallback((line: string) => {
    if (!searchHighlightRegex) return line;

    const parts: { text: string; match: boolean }[] = [];
    let lastIndex = 0;
    let match;
    searchHighlightRegex.lastIndex = 0;

    while ((match = searchHighlightRegex.exec(line)) !== null) {
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
  }, [searchHighlightRegex]);

  // Stable row props for react-window row renderer
  const rowProps = useMemo<LogRowProps>(() => ({
    logs: filteredLogs,
    showTimestamps,
    highlightMatches,
  }), [filteredLogs, showTimestamps, highlightMatches]);

  // Auto-scroll when follow is enabled and not paused
  useEffect(() => {
    if (follow && !isPaused && listRef.current && filteredLogs.length > 0) {
      listRef.current.scrollToRow({ index: filteredLogs.length - 1, align: 'end' });
    }
  }, [filteredLogs.length, follow, isPaused, listRef]);

  const getStatusLabel = useCallback((container: GraphNode) => {
    if (container.containerHealth?.status && container.containerHealth.status !== 'unknown') {
      return container.containerHealth.status;
    }
    if (container.containerState) return container.containerState;
    return 'unknown';
  }, []);

  const getPortLabel = useCallback((container: GraphNode) => {
    const ports = container.ports || [];
    const firstPort = ports[0]?.port
      ?? container.containerPorts?.[0]?.hostPort
      ?? container.containerPorts?.[0]?.containerPort;
    if (!firstPort) return '—';
    const count = ports.length || (container.containerPorts?.length ?? 0);
    return count > 1 ? `:${firstPort} +${count - 1}` : `:${firstPort}`;
  }, []);

  const getImageLabel = useCallback((container: GraphNode) => {
    const image = container.containerImage;
    if (!image) return '—';
    const parts = image.split('/');
    return parts[parts.length - 1];
  }, []);

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
      <div className="unified-logs-layout">
        {/* Container Selection Panel */}
        <div className="unified-logs-panel unified-logs-panel-list">
          <div className="unified-logs-containers">
            <div className="unified-logs-containers-header">
              <span className="unified-logs-containers-title">Containers</span>
              <div className="unified-logs-containers-actions">
                <button onClick={selectAll} className="unified-logs-action-btn">All</button>
                <button onClick={deselectAll} className="unified-logs-action-btn">None</button>
              </div>
            </div>
            <div className="unified-logs-container-list">
              <div className="unified-logs-container-list-body">
                {containers.map(container => {
                  if (!container.containerId) return null;
                  const isSelected = selectedContainerIds.has(container.containerId);
                  const status = getStatusLabel(container);
                  const color = containerColorMap.get(container.containerId) || '#6B7280';
                  const imageLabel = getImageLabel(container);
                  const portLabel = getPortLabel(container);

                  return (
                    <button
                      key={container.containerId}
                  className={`unified-logs-container-row ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleContainer(container.containerId!)}
                    >
                      <span className="container-col container-col-check">
                        <span className={`container-check ${isSelected ? 'checked' : ''}`} />
                      </span>
                      <span className="container-col container-col-main">
                        <span className="container-row-top">
                          <span className="container-name" title={container.name}>
                            <span className="container-name-dot" style={{ backgroundColor: color }} />
                            <span className="container-name-code">{container.name}</span>
                          </span>
                          <span className={`container-status-pill status-${status}`}>{status}</span>
                        </span>
                        <span className="container-row-meta">
                          <span className="container-meta container-meta-image">{imageLabel}</span>
                          <span className="container-meta container-meta-port">{portLabel}</span>
                        </span>
                      </span>
                    </button>
                  );
            })}
              </div>
            </div>
          </div>
        </div>

        {/* Logs Panel */}
        <div className="unified-logs-panel unified-logs-panel-output">
          {/* Toolbar */}
          <div className="unified-logs-toolbar">
            <div className="unified-logs-toolbar-section">
              <button
                className={`unified-logs-btn ${isPaused ? 'active' : ''}`}
            onClick={() => {
              const newPaused = !isPaused;
              setIsPaused(newPaused);
              // Pause disables auto-scroll; resume re-enables it
              if (newPaused) setFollow(false);
              else setFollow(true);
            }}
            title={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <path d="M8 5l11 7-11 7z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="7" y1="5" x2="7" y2="19" />
                <line x1="17" y1="5" x2="17" y2="19" />
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

          <div className="unified-logs-select" ref={filterRef}>
            <button
              type="button"
              className="unified-logs-select-trigger"
              onClick={() => setIsFilterOpen((prev) => !prev)}
            >
              <span>{filterOptions.find(o => o.value === filterLevel)?.label}</span>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3.5 6l4.5 4 4.5-4" />
              </svg>
            </button>
            {isFilterOpen && (
              <div className="unified-logs-select-menu">
                {filterOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    className={`unified-logs-select-option ${filterLevel === option.value ? 'selected' : ''}`}
                    onClick={() => {
                      setFilterLevel(option.value as typeof filterLevel);
                      setIsFilterOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <input
            className={`unified-logs-search${searchRegexError ? ' unified-logs-search-error' : ''}`}
            type="text"
            placeholder="Search (regex)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            title={searchRegexError ? 'Invalid regex pattern' : undefined}
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
                <div className="unified-logs-spinner" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : (
              <List
                listRef={listRef}
                rowComponent={LogRow}
                rowProps={rowProps}
                rowCount={filteredLogs.length}
                rowHeight={LOG_ROW_HEIGHT}
                overscanCount={20}
                style={{ height: '100%' }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
