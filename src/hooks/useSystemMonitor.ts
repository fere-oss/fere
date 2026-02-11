import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConnectionGraph, EnvironmentSummary, Port, Process, SystemSnapshot, SnapshotDelta, GraphNode, GraphEdge } from '../types/electron';

// Helper to create a stable key for comparing snapshots
// Only includes actual topology changes (new/removed services and connections)
// Excludes frequently changing properties (health, state, metrics) to prevent unnecessary re-renders
const createSnapshotKey = (snapshot: SystemSnapshot): string => {
  const nodeKeys = snapshot.graph.nodes
    .map(n => `${n.id}:${n.type}`)
    .sort()
    .join(',');

  const edgeKeys = snapshot.graph.edges
    .map(e => `${e.source}-${e.target}`)
    .sort()
    .join(',');

  return `${nodeKeys}|${edgeKeys}`;
};

// Check if we're running in Electron
const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

/**
 * Apply a delta patch to a running SystemSnapshot.
 * For 'full' deltas, extracts the full snapshot directly.
 * For 'delta' deltas, applies incremental changes.
 */
function applyDelta(current: SystemSnapshot, delta: SnapshotDelta): SystemSnapshot {
  if (delta.type === 'full') {
    // Full snapshot — extract SystemSnapshot shape
    return {
      processes: delta.processes as Process[] || current.processes,
      ports: delta.ports as Port[] || current.ports,
      connections: delta.connections as Connection[] || current.connections,
      graph: delta.graph as ConnectionGraph || current.graph,
      docker: delta.docker ?? current.docker,
      meta: delta.meta ?? current.meta,
    };
  }

  const result: SystemSnapshot = {
    processes: [...current.processes],
    ports: [...current.ports],
    connections: [...current.connections],
    graph: {
      nodes: [...current.graph.nodes],
      edges: [...current.graph.edges],
    },
    docker: delta.docker ?? current.docker,
    meta: delta.meta ?? current.meta,
  };

  // Apply process delta
  if (delta.processes && 'added' in delta.processes) {
    const pd = delta.processes;
    if (pd.removed.length > 0) {
      const removedSet = new Set(pd.removed);
      result.processes = result.processes.filter(p => !removedSet.has(p.pid));
    }
    if (pd.added.length > 0) {
      result.processes.push(...pd.added);
    }
    if (pd.modified.length > 0) {
      const modMap = new Map(pd.modified.map(p => [p.pid, p]));
      result.processes = result.processes.map(p => {
        const mod = modMap.get(p.pid);
        return mod ? { ...p, ...mod } : p;
      });
    }
  }

  // Apply port delta
  if (delta.ports && 'added' in delta.ports) {
    const portd = delta.ports;
    if (portd.removed.length > 0) {
      const removedSet = new Set(portd.removed);
      result.ports = result.ports.filter(p => !removedSet.has(`${p.port}-${p.pid}`));
    }
    if (portd.added.length > 0) {
      result.ports.push(...portd.added);
    }
  }

  // Apply connection delta
  if (delta.connections && 'added' in delta.connections) {
    const cd = delta.connections;
    if (cd.removed.length > 0) {
      const removedSet = new Set(cd.removed);
      result.connections = result.connections.filter(c =>
        !removedSet.has(`${c.pid}-${c.localPort}-${c.remoteHost}-${c.remotePort}`)
      );
    }
    if (cd.added.length > 0) {
      result.connections.push(...cd.added);
    }
  }

  // Apply graph node delta
  if (delta.graph && 'nodes' in delta.graph && delta.graph.nodes) {
    const nd = delta.graph.nodes as { added: GraphNode[]; removed: string[]; modified: (Partial<GraphNode> & { id: string })[] };
    if (nd.removed.length > 0) {
      const removedSet = new Set(nd.removed);
      result.graph.nodes = result.graph.nodes.filter(n => !removedSet.has(n.id));
    }
    if (nd.added.length > 0) {
      result.graph.nodes.push(...nd.added);
    }
    if (nd.modified.length > 0) {
      const modMap = new Map(nd.modified.map(n => [n.id, n]));
      result.graph.nodes = result.graph.nodes.map(n => {
        const mod = modMap.get(n.id);
        return mod ? { ...n, ...mod } as GraphNode : n;
      });
    }
  }

  // Apply graph edge delta
  if (delta.graph && 'edges' in delta.graph && delta.graph.edges) {
    const ed = delta.graph.edges as { added: GraphEdge[]; removed: string[] };
    if (ed.removed.length > 0) {
      const removedSet = new Set(ed.removed);
      result.graph.edges = result.graph.edges.filter(e => !removedSet.has(e.id));
    }
    if (ed.added.length > 0) {
      result.graph.edges.push(...ed.added);
    }
  }

  return result;
}

type Connection = import('../types/electron').Connection;

/**
 * Hook to poll the connection graph at regular intervals
 */
export function useConnectionGraph(pollInterval = 2000) {
  const [graph, setGraph] = useState<ConnectionGraph>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setError('Not running in Electron');
      setLoading(false);
      return;
    }

    try {
      const data = await window.electronAPI.getConnectionGraph();
      setGraph(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch connection graph');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { graph, loading, error, refresh };
}

/**
 * Hook for system snapshot with push-based event-driven updates.
 * Prefers the push channel (onSnapshotDelta) when available,
 * falls back to polling for backward compatibility.
 */
export function useSystemSnapshot(pollInterval = 2000) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot>({
    processes: [],
    ports: [],
    connections: [],
    graph: { nodes: [], edges: [] },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<SystemSnapshot>(snapshot);
  const snapshotKeyRef = useRef<string>('');
  const lastSeqRef = useRef<number>(-1);

  // On-demand full refresh (keeps existing API surface)
  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setError('Not running in Electron');
      setLoading(false);
      return;
    }

    try {
      const data = await window.electronAPI.getSystemSnapshot();
      snapshotRef.current = data;
      snapshotKeyRef.current = createSnapshotKey(data);
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch system snapshot');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isElectron()) {
      setError('Not running in Electron');
      setLoading(false);
      return;
    }

    // Prefer push-based channel when available
    if (window.electronAPI.onSnapshotDelta) {
      window.electronAPI.startSnapshotStream();

      const unsubscribe = window.electronAPI.onSnapshotDelta((delta: SnapshotDelta) => {
        // Sequence gap detection — request full resync if we missed deltas
        if (delta.type === 'delta' && lastSeqRef.current >= 0 && delta.seq !== lastSeqRef.current + 1) {
          refresh();
          return;
        }
        lastSeqRef.current = delta.seq;

        const patched = applyDelta(snapshotRef.current, delta);
        const newKey = createSnapshotKey(patched);
        snapshotRef.current = patched;

        if (newKey !== snapshotKeyRef.current) {
          snapshotKeyRef.current = newKey;
          setSnapshot(patched);
        }

        setLoading(false);
        setError(null);
      });

      return () => {
        unsubscribe();
        window.electronAPI.stopSnapshotStream();
      };
    }

    // Fallback: existing polling mechanism
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { snapshot, loading, error, refresh };
}

/**
 * Hook to poll listening ports
 */
export function useListeningPorts(pollInterval = 2000) {
  const [ports, setPorts] = useState<Port[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setError('Not running in Electron');
      setLoading(false);
      return;
    }

    try {
      const data = await window.electronAPI.getListeningPorts();
      setPorts(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch ports');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { ports, loading, error, refresh };
}

/**
 * Hook to poll dev processes
 */
export function useDevProcesses(pollInterval = 2000) {
  const [processes, setProcesses] = useState<Process[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setError('Not running in Electron');
      setLoading(false);
      return;
    }

    try {
      const data = await window.electronAPI.getDevProcesses();
      setProcesses(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch processes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { processes, loading, error, refresh };
}

/**
 * Hook to get environment summary
 */
export function useEnvironmentSummary(pollInterval = 2000) {
  const [summary, setSummary] = useState<EnvironmentSummary>({
    totalServices: 0,
    totalConnections: 0,
    services: [],
    portRange: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setError('Not running in Electron');
      setLoading(false);
      return;
    }

    try {
      const data = await window.electronAPI.getEnvironmentSummary();
      setSummary(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch summary');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { summary, loading, error, refresh };
}

/**
 * Hook to kill a process
 */
export function useKillProcess() {
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kill = useCallback(async (pid: number) => {
    if (!isElectron()) {
      setError('Not running in Electron');
      return false;
    }

    setKilling(true);
    setError(null);

    try {
      const result = await window.electronAPI.killProcess(pid);
      if (!result.success) {
        setError(result.error || 'Failed to kill process');
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to kill process');
      return false;
    } finally {
      setKilling(false);
    }
  }, []);

  return { kill, killing, error };
}
