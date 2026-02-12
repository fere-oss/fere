const path = require('path');
const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const { getDevProcesses, getProcessCacheInfo, getProcessPids } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections, getPortCacheInfo, getListeningPortNumbers } = require('./portMonitor');
const { getDockerSnapshot } = require('./dockerMonitor');
const { batchGetProcessCwds, collectHealthByPid, collectRoutes } = require('./connectionGraph');
const { hasTopologyChanged, buildGraphStructure } = require('./graphFunctions');

/**
 * SnapshotScheduler — event-driven collection pipeline with Worker offload.
 *
 * Architecture:
 *   Main thread: collects raw data (ps, lsof, Docker), computes health, collects CWDs/routes
 *   Worker thread: runs CPU-heavy graph structure building and metrics overlay
 *
 * Tiered refresh:
 *   - Structure path (every 10s or on topology change): full graph rebuild in worker
 *   - Metrics path (every 5s when topology unchanged): lightweight metrics overlay in worker
 *   - Fast probe (every 1.5s): PID/port enumeration, triggers reconcile on change
 *
 * Emits 'snapshot' events with { type: 'full' | 'delta' | 'metrics', ... } payloads.
 */
class SnapshotScheduler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.reconciliationInterval = options.reconciliationInterval || 5000;
    this.fastProbeInterval = options.fastProbeInterval || 1500;
    this.structureInterval = options.structureInterval || 10000; // 10s forced structure rebuild

    this.reconcileTimer = null;
    this.fastProbeTimer = null;
    this.running = false;

    // Previous state for diff engine
    this.previousSnapshot = null;
    this.previousProcessPids = new Set();
    this.previousPortNumbers = new Set();
    this.previousRawData = null;
    this.seq = 0;

    // Backpressure
    this.workerBusy = false;
    this.pendingRawData = null;

    // Tiered refresh tracking
    this.lastStructureTime = 0;
    this.cachedResult = null;

    // Prevent overlapping reconciliations
    this.reconcileInFlight = false;

    // Worker thread
    this.worker = null;
    this.workerReady = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Spawn the Worker
    try {
      this.worker = new Worker(path.join(__dirname, '../workers/graphBuilder.worker.js'));
      this.worker.on('message', (msg) => this._handleWorkerMessage(msg));
      this.worker.on('error', (err) => {
        console.error('[SnapshotScheduler] Worker error:', err);
        this.workerReady = false;
        this._restartWorker();
      });
      this.worker.on('exit', (code) => {
        if (code !== 0 && this.running) {
          console.error(`[SnapshotScheduler] Worker exited with code ${code}, restarting...`);
          this._restartWorker();
        }
      });
      this.workerReady = true;
    } catch (error) {
      console.error('[SnapshotScheduler] Failed to create Worker, falling back to main thread:', error);
      this.workerReady = false;
    }

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
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
    }
  }

  _restartWorker() {
    if (!this.running) return;
    try {
      this.worker = new Worker(path.join(__dirname, '../workers/graphBuilder.worker.js'));
      this.worker.on('message', (msg) => this._handleWorkerMessage(msg));
      this.worker.on('error', (err) => {
        console.error('[SnapshotScheduler] Worker error after restart:', err);
        this.workerReady = false;
        this._restartWorker();
      });
      this.worker.on('exit', (code) => {
        if (code !== 0 && this.running) {
          console.error(`[SnapshotScheduler] Worker exited with code ${code}, restarting...`);
          this._restartWorker();
        }
      });
      this.workerReady = true;
      this.workerBusy = false;
    } catch (error) {
      console.error('[SnapshotScheduler] Failed to restart Worker:', error);
      this.workerReady = false;
      this.workerBusy = false;
    }
  }

  /**
   * Fast probe — lightweight PID and port enumeration.
   * If the set changed since last check, triggers an early reconciliation.
   */
  async fastProbe() {
    if (this.workerBusy || this.reconcileInFlight) return;

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
        this.reconcile();
      }
    } catch (error) {
      console.error('[SnapshotScheduler] Fast probe error:', error);
    }
  }

  /**
   * Full reconciliation — collects all data, routes to structure or metrics path.
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

      this.previousProcessPids = new Set(processes.map(p => p.pid));
      this.previousPortNumbers = new Set(ports.map(p => p.port));

      const rawData = { processes, ports, connections };
      await this.processSnapshot(rawData);
    } catch (error) {
      console.error('[SnapshotScheduler] Reconciliation error:', error);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  /**
   * Process a raw data collection with tiered refresh and Worker offload.
   * Structure path: topology changed or stale → full rebuild
   * Metrics path: topology unchanged → lightweight overlay
   */
  async processSnapshot(rawData) {
    if (this.workerBusy) {
      this.pendingRawData = rawData;
      return;
    }

    // Compute health on main thread (uses module-level state in healthTracker)
    const healthByPid = collectHealthByPid(rawData.processes, rawData.ports, rawData.connections);

    const topologyChanged = hasTopologyChanged(this.previousRawData, rawData);
    const structureStale = Date.now() - this.lastStructureTime > this.structureInterval;
    const needsStructure = topologyChanged || structureStale || !this.cachedResult;

    if (needsStructure) {
      // STRUCTURE PATH: collect I/O data on main thread, send to worker
      const pids = rawData.processes.filter(p => p.pid > 0).map(p => p.pid);

      const [cwdMap, dockerSnapshot] = await Promise.all([
        batchGetProcessCwds(pids),
        getDockerSnapshot(),
      ]);

      // Build a preliminary graph to discover project paths, then scan routes
      const prelimResult = buildGraphStructure({
        processes: rawData.processes,
        ports: rawData.ports,
        connections: rawData.connections,
        cwdMap: Object.fromEntries(cwdMap),
        dockerSnapshot: null,
        routesByProject: {},
        healthByPid,
        containerHealthToGraphHealth: () => 'yellow',
      });
      const routesByProject = await collectRoutes(prelimResult.nodes);

      const workerData = {
        processes: rawData.processes,
        ports: rawData.ports,
        connections: rawData.connections,
        cwdMap: Object.fromEntries(cwdMap),
        dockerSnapshot,
        routesByProject,
        healthByPid,
      };

      if (this.workerReady) {
        this.workerBusy = true;
        this._pendingRawForResult = rawData;
        this.worker.postMessage({ type: 'build-structure', seq: this.seq, data: workerData });
      } else {
        // Fallback: run on main thread
        await this._buildOnMainThread(rawData, workerData, healthByPid);
      }
    } else {
      // METRICS PATH: just update metrics on cached structure
      if (this.workerReady) {
        this.workerBusy = true;
        this._pendingRawForResult = rawData;
        this.worker.postMessage({
          type: 'overlay-metrics',
          seq: this.seq,
          data: { processes: rawData.processes, healthByPid },
        });
      } else {
        // Fallback: run on main thread with buildGraphStructure
        await this._buildOnMainThread(rawData, null, healthByPid);
      }
    }

    this.previousRawData = rawData;
  }

  /**
   * Handle messages from the Worker thread.
   */
  _handleWorkerMessage(msg) {
    this.workerBusy = false;

    switch (msg.type) {
      case 'structure-result': {
        this.lastStructureTime = Date.now();
        this.cachedResult = msg.data;
        this._emitSnapshot(msg.data, this._pendingRawForResult);
        break;
      }

      case 'metrics-result': {
        this.cachedResult = msg.data;
        this._emitSnapshot(msg.data, this._pendingRawForResult);
        break;
      }

      case 'needs-structure': {
        // Worker lost its cache — trigger a full structure build
        this.lastStructureTime = 0;
        if (this._pendingRawForResult) {
          setImmediate(() => this.processSnapshot(this._pendingRawForResult));
        }
        return; // Don't process pending below
      }

      case 'error': {
        console.error('[SnapshotScheduler] Worker reported error:', msg.error);
        break;
      }
    }

    // Process buffered snapshot if one arrived during build
    if (this.pendingRawData) {
      const pending = this.pendingRawData;
      this.pendingRawData = null;
      setImmediate(() => this.processSnapshot(pending));
    }
  }

  /**
   * Build and emit a snapshot from worker results.
   */
  _emitSnapshot(graphResult, rawData) {
    if (!rawData) return;

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
  }

  /**
   * Fallback: build graph on main thread when Worker is unavailable.
   */
  async _buildOnMainThread(rawData, workerData, healthByPid) {
    try {
      const { containerHealthToGraphHealth } = require('./dockerMonitor');
      let result;

      if (workerData) {
        result = buildGraphStructure({
          ...workerData,
          containerHealthToGraphHealth,
        });
      } else {
        // Metrics-only fallback: rebuild fully (no cached structure on main thread)
        const pids = rawData.processes.filter(p => p.pid > 0).map(p => p.pid);
        const [cwdMap, dockerSnapshot] = await Promise.all([
          batchGetProcessCwds(pids),
          getDockerSnapshot(),
        ]);
        result = buildGraphStructure({
          processes: rawData.processes,
          ports: rawData.ports,
          connections: rawData.connections,
          cwdMap: Object.fromEntries(cwdMap),
          dockerSnapshot,
          routesByProject: {},
          healthByPid,
          containerHealthToGraphHealth,
        });
      }

      this.lastStructureTime = Date.now();
      this.cachedResult = result;
      this._emitSnapshot(result, rawData);
    } catch (error) {
      console.error('[SnapshotScheduler] Main thread build error:', error);
    }
  }

  /**
   * Diff engine — computes a delta between current and previous snapshot.
   * Returns null if there are no topology changes worth emitting.
   */
  computeDelta(currentSnapshot) {
    if (!this.previousSnapshot) {
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

    delta.docker = currentSnapshot.docker;
    delta.meta = currentSnapshot.meta;

    // Emit on topology changes OR metrics-only changes (cpu/memory/health)
    const hasMetricsChange =
      (delta.processes && delta.processes.modified && delta.processes.modified.length > 0) ||
      (delta.graph && delta.graph.nodes && delta.graph.nodes.modified && delta.graph.nodes.modified.length > 0);

    if (!hasTopologyChange && !hasMetricsChange) return null;

    if (!hasTopologyChange && hasMetricsChange) {
      delta.type = 'metrics';
    }

    return delta;
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

module.exports = { SnapshotScheduler };
