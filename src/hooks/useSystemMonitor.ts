import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConnectionGraph, EnvironmentSummary, Port, Process, SystemSnapshot } from '../types/electron';

// Helper to create a stable key for comparing snapshots
// Only includes actual topology changes (new/removed services and connections)
// Excludes frequently changing properties (health, state, metrics) to prevent unnecessary re-renders
const createSnapshotKey = (snapshot: SystemSnapshot): string => {
  // Include only node IDs and types (topology structure)
  // Exclude: healthStatus, containerState, cpu, memory, name changes
  const nodeKeys = snapshot.graph.nodes
    .map(n => `${n.id}:${n.type}`)
    .sort()
    .join(',');

  // Include edges (connections between services)
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
 * Hook to poll the full system snapshot
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
  const snapshotKeyRef = useRef<string>('');

  const refresh = useCallback(async () => {
    if (!isElectron()) {
      setError('Not running in Electron');
      setLoading(false);
      return;
    }

    try {
      const data = await window.electronAPI.getSystemSnapshot();
      const newKey = createSnapshotKey(data);

      // Only update state if the structural content actually changed
      // (new/removed nodes, edges, ports, state changes, health changes)
      // Skip updates for metric-only changes (cpu, memory) to prevent unnecessary re-renders
      if (newKey !== snapshotKeyRef.current) {
        snapshotKeyRef.current = newKey;
        setSnapshot(data);
      }
      // If key is same, don't update state - metrics changed but structure didn't

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch system snapshot');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
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
