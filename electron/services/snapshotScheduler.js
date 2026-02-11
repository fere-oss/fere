const EventEmitter = require('events');
const { getDevProcesses, getProcessCacheInfo, getProcessPids } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections, getPortCacheInfo, getListeningPortNumbers } = require('./portMonitor');
const { buildConnectionGraph } = require('./connectionGraph');

/**
 * SnapshotScheduler — event-driven collection pipeline.
 *
 * Replaces renderer-side polling with a main-process-driven push model:
 *   - Fast probe (1.5s): lightweight PID/port enumeration, triggers reconcile on change
 *   - Full reconcile (5s): ps aux + lsof, diff engine, graph build with backpressure gate
 *
 * Emits 'snapshot' events with { type: 'full' | 'delta', ... } payloads.
 */
class SnapshotScheduler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.reconciliationInterval = options.reconciliationInterval || 5000;
    this.fastProbeInterval = options.fastProbeInterval || 1500;

    this.reconcileTimer = null;
    this.fastProbeTimer = null;
    this.running = false;

    // Previous state for diff engine
    this.previousSnapshot = null;
    this.previousProcessPids = new Set();
    this.previousPortNumbers = new Set();
    this.seq = 0;

    // Backpressure
    this.graphBuildInFlight = false;
    this.pendingRawData = null;

    // Prevent overlapping reconciliations
    this.reconcileInFlight = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Initial full reconciliation
    this.reconcile();

    // Schedule recurring timers
    this.reconcileTimer = setInterval(() => this.reconcile(), this.reconciliationInterval);
    this.fastProbeTimer = setInterval(() => this.fastProbe(), this.fastProbeInterval);
  }

  stop() {
    this.running = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.fastProbeTimer) {
      clearInterval(this.fastProbeTimer);
      this.fastProbeTimer = null;
    }
  }

  /**
   * Fast probe — lightweight PID and port enumeration.
   * If the set changed since last check, triggers an early reconciliation.
   */
  async fastProbe() {
    if (this.graphBuildInFlight || this.reconcileInFlight) return;

    try {
      const [currentPids, currentPorts] = await Promise.all([
        getProcessPids(),
        getListeningPortNumbers(),
      ]);

      const pidsChanged = !setsEqual(currentPids, this.previousProcessPids);
      const portsChanged = !setsEqual(currentPorts, this.previousPortNumbers);

      this.previousProcessPids = currentPids;
      this.previousPortNumbers = currentPorts;

      if (pidsChanged || portsChanged) {
        // Topology change detected — trigger early reconciliation
        this.reconcile();
      }
    } catch (error) {
      console.error('[SnapshotScheduler] Fast probe error:', error);
    }
  }

  /**
   * Full reconciliation — collects all data, builds graph, computes delta, emits.
   */
  async reconcile() {
    if (this.reconcileInFlight) return;
    this.reconcileInFlight = true;

    try {
      const [processes, ports, connections] = await Promise.all([
        getDevProcesses(),
        getListeningPorts(),
        getEstablishedConnections(),
      ]);

      // Update PID/port sets for fast probe comparison
      this.previousProcessPids = new Set(processes.map(p => p.pid));
      this.previousPortNumbers = new Set(ports.map(p => p.port));

      await this.processSnapshot({ processes, ports, connections });
    } catch (error) {
      console.error('[SnapshotScheduler] Reconciliation error:', error);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  /**
   * Process a raw data collection through the graph builder with backpressure.
   * If a build is already in flight, buffers the latest data (latest-wins).
   */
  async processSnapshot(rawData) {
    if (this.graphBuildInFlight) {
      // Drop any previously buffered snapshot, keep only the latest
      this.pendingRawData = rawData;
      return;
    }

    this.graphBuildInFlight = true;
    try {
      const graphResult = await buildConnectionGraph(rawData);
      const { nodes, edges, dockerSnapshot } = graphResult;

      const collectedAt = Date.now();
      const processCacheInfo = getProcessCacheInfo();
      const portCacheInfo = getPortCacheInfo();

      const snapshot = {
        processes: rawData.processes,
        ports: rawData.ports,
        connections: rawData.connections,
        graph: { nodes, edges },
        docker: dockerSnapshot || null,
        meta: {
          collectedAt,
          processesAgeMs: processCacheInfo.timestamp ? collectedAt - processCacheInfo.timestamp : null,
          portsAgeMs: portCacheInfo.listeningTimestamp ? collectedAt - portCacheInfo.listeningTimestamp : null,
          connectionsAgeMs: portCacheInfo.connectionsTimestamp ? collectedAt - portCacheInfo.connectionsTimestamp : null,
        },
      };

      const delta = this.computeDelta(snapshot);
      this.previousSnapshot = snapshot;

      if (delta) {
        this.emit('snapshot', delta);
      }
    } catch (error) {
      console.error('[SnapshotScheduler] Graph build error:', error);
    } finally {
      this.graphBuildInFlight = false;

      // Process buffered snapshot if one arrived during build
      if (this.pendingRawData) {
        const pending = this.pendingRawData;
        this.pendingRawData = null;
        setImmediate(() => this.processSnapshot(pending));
      }
    }
  }

  /**
   * Diff engine — computes a delta between current and previous snapshot.
   * Returns null if there are no topology changes worth emitting.
   */
  computeDelta(currentSnapshot) {
    if (!this.previousSnapshot) {
      // First snapshot — send full
      return {
        type: 'full',
        seq: this.seq++,
        timestamp: Date.now(),
        ...currentSnapshot,
      };
    }

    const prev = this.previousSnapshot;
    const delta = {
      type: 'delta',
      seq: this.seq++,
      timestamp: Date.now(),
    };

    let hasTopologyChange = false;

    // --- Process diff (keyed by PID) ---
    const prevPids = new Map(prev.processes.map(p => [p.pid, p]));
    const currPids = new Map(currentSnapshot.processes.map(p => [p.pid, p]));

    const addedProcesses = currentSnapshot.processes.filter(p => !prevPids.has(p.pid));
    const removedProcessPids = [...prevPids.keys()].filter(pid => !currPids.has(pid));
    const modifiedProcesses = currentSnapshot.processes.filter(p => {
      const prev = prevPids.get(p.pid);
      return prev && (prev.cpu !== p.cpu || prev.memory !== p.memory || prev.status !== p.status);
    });

    if (addedProcesses.length || removedProcessPids.length || modifiedProcesses.length) {
      delta.processes = { added: addedProcesses, removed: removedProcessPids, modified: modifiedProcesses };
      if (addedProcesses.length || removedProcessPids.length) hasTopologyChange = true;
    }

    // --- Port diff (keyed by "port-pid") ---
    const portKey = (p) => `${p.port}-${p.pid}`;
    const prevPortKeys = new Map(prev.ports.map(p => [portKey(p), p]));
    const currPortKeys = new Map(currentSnapshot.ports.map(p => [portKey(p), p]));

    const addedPorts = currentSnapshot.ports.filter(p => !prevPortKeys.has(portKey(p)));
    const removedPortKeys = [...prevPortKeys.keys()].filter(k => !currPortKeys.has(k));

    if (addedPorts.length || removedPortKeys.length) {
      delta.ports = { added: addedPorts, removed: removedPortKeys };
      hasTopologyChange = true;
    }

    // --- Connection diff (keyed by composite key) ---
    const connKey = (c) => `${c.pid}-${c.localPort}-${c.remoteHost}-${c.remotePort}`;
    const prevConnKeys = new Map(prev.connections.map(c => [connKey(c), c]));
    const currConnKeys = new Map(currentSnapshot.connections.map(c => [connKey(c), c]));

    const addedConns = currentSnapshot.connections.filter(c => !prevConnKeys.has(connKey(c)));
    const removedConnKeys = [...prevConnKeys.keys()].filter(k => !currConnKeys.has(k));

    if (addedConns.length || removedConnKeys.length) {
      delta.connections = { added: addedConns, removed: removedConnKeys };
      hasTopologyChange = true;
    }

    // --- Graph node diff (keyed by node.id) ---
    const prevNodes = new Map(prev.graph.nodes.map(n => [n.id, n]));
    const currNodes = new Map(currentSnapshot.graph.nodes.map(n => [n.id, n]));

    const addedNodes = currentSnapshot.graph.nodes.filter(n => !prevNodes.has(n.id));
    const removedNodeIds = [...prevNodes.keys()].filter(id => !currNodes.has(id));
    const modifiedNodes = currentSnapshot.graph.nodes.filter(n => {
      const p = prevNodes.get(n.id);
      if (!p) return false;
      return p.type !== n.type || p.name !== n.name || p.healthStatus !== n.healthStatus ||
        p.cpu !== n.cpu || p.memory !== n.memory ||
        JSON.stringify(p.ports) !== JSON.stringify(n.ports) ||
        p.containerState !== n.containerState;
    }).map(n => {
      const p = prevNodes.get(n.id);
      const patch = { id: n.id };
      if (p.type !== n.type) patch.type = n.type;
      if (p.name !== n.name) patch.name = n.name;
      if (p.healthStatus !== n.healthStatus) patch.healthStatus = n.healthStatus;
      if (p.cpu !== n.cpu) patch.cpu = n.cpu;
      if (p.memory !== n.memory) patch.memory = n.memory;
      if (JSON.stringify(p.ports) !== JSON.stringify(n.ports)) patch.ports = n.ports;
      if (p.containerState !== n.containerState) patch.containerState = n.containerState;
      return patch;
    });

    if (addedNodes.length || removedNodeIds.length || modifiedNodes.length) {
      delta.graph = delta.graph || {};
      delta.graph.nodes = { added: addedNodes, removed: removedNodeIds, modified: modifiedNodes };
      if (addedNodes.length || removedNodeIds.length) hasTopologyChange = true;
    }

    // --- Graph edge diff (keyed by edge.id) ---
    const prevEdges = new Map(prev.graph.edges.map(e => [e.id, e]));
    const currEdges = new Map(currentSnapshot.graph.edges.map(e => [e.id, e]));

    const addedEdges = currentSnapshot.graph.edges.filter(e => !prevEdges.has(e.id));
    const removedEdgeIds = [...prevEdges.keys()].filter(id => !currEdges.has(id));

    if (addedEdges.length || removedEdgeIds.length) {
      delta.graph = delta.graph || {};
      delta.graph.edges = { added: addedEdges, removed: removedEdgeIds };
      hasTopologyChange = true;
    }

    // --- Docker + meta (always include for full state) ---
    delta.docker = currentSnapshot.docker;
    delta.meta = currentSnapshot.meta;

    // Skip emitting if no topology changes (metric-only updates are filtered by the renderer anyway)
    if (!hasTopologyChange) return null;

    return delta;
  }
}

/**
 * Compare two Sets for equality.
 */
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

module.exports = { SnapshotScheduler };
