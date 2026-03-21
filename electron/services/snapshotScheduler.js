const path = require('path');
const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const { getDevProcesses, getProcessCacheInfo, getProcessPids } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections, getPortCacheInfo, getListeningPortNumbers } = require('./portMonitor');
const { getDockerSnapshot, getLastDockerStatus } = require('./dockerMonitor');
const { batchGetProcessCwds, collectHealthByPid, collectRoutes } = require('./connectionGraph');
const { hasTopologyChanged, buildGraphStructure, collectProjectPaths } = require('./graphFunctions');

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
    this._workerRestartCount = 0;
    this._workerRestartTimer = null;
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
    if (this._workerRestartTimer) {
      clearTimeout(this._workerRestartTimer);
      this._workerRestartTimer = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
    }
  }

  _restartWorker() {
    if (!this.running) return;

    const MAX_RESTART_ATTEMPTS = 5;
    this._workerRestartCount++;

    if (this._workerRestartCount > MAX_RESTART_ATTEMPTS) {
      console.error(`[SnapshotScheduler] Worker failed ${MAX_RESTART_ATTEMPTS} times, giving up. Falling back to main thread.`);
      this.workerReady = false;
      this.workerBusy = false;
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.min(1000 * Math.pow(2, this._workerRestartCount - 1), 16000);
    console.warn(`[SnapshotScheduler] Restarting worker in ${delay}ms (attempt ${this._workerRestartCount}/${MAX_RESTART_ATTEMPTS})...`);

    this._workerRestartTimer = setTimeout(() => {
      this._workerRestartTimer = null;
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
        this._workerRestartCount = 0; // Reset on successful start
      } catch (error) {
        console.error('[SnapshotScheduler] Failed to restart Worker:', error);
        this.workerReady = false;
        this.workerBusy = false;
      }
    }, delay);
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
      // Emit a status-only update so the renderer knows collection is broken
      const collectedAt = Date.now();
      const processCacheInfo = getProcessCacheInfo();
      const portCacheInfo = getPortCacheInfo();
      this.emit('snapshot', {
        type: 'full',
        seq: this.seq++,
        timestamp: collectedAt,
        processes: [],
        ports: [],
        connections: [],
        graph: { nodes: [], edges: [] },
        docker: null,
        meta: {
          collectedAt,
          processesAgeMs: processCacheInfo.timestamp ? collectedAt - processCacheInfo.timestamp : null,
          portsAgeMs: portCacheInfo.listeningTimestamp ? collectedAt - portCacheInfo.listeningTimestamp : null,
          connectionsAgeMs: portCacheInfo.connectionsTimestamp ? collectedAt - portCacheInfo.connectionsTimestamp : null,
          status: {
            ports: portCacheInfo.status,
            processes: processCacheInfo.status,
            docker: getLastDockerStatus(),
          },
        },
      });
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

      // Convert once and reuse — avoid redundant Object.fromEntries()
      const cwdMapObj = Object.fromEntries(cwdMap);

      // Lightweight project-path discovery (no full graph build)
      const projectPaths = collectProjectPaths({
        processes: rawData.processes,
        ports: rawData.ports,
        cwdMap: cwdMapObj,
        dockerSnapshot,
      });
      const routesByProject = await collectRoutes(projectPaths);

      const workerData = {
        processes: rawData.processes,
        ports: rawData.ports,
        connections: rawData.connections,
        cwdMap: cwdMapObj,
        dockerSnapshot,
        routesByProject,
        healthByPid,
      };

      if (this.workerReady) {
        this.workerBusy = true;
        this._pendingRawForResult = rawData;
        try {
          this.worker.postMessage({ type: 'build-structure', seq: this.seq, data: workerData });
        } catch (err) {
          // Worker died between readiness check and postMessage — reset and
          // fall back to main thread so snapshot processing isn't permanently
          // blocked.
          console.error('[SnapshotScheduler] postMessage failed, falling back to main thread:', err);
          this.workerBusy = false;
          this.workerReady = false;
          this._restartWorker();
          await this._buildOnMainThread(rawData, workerData, healthByPid);
        }
      } else {
        // Fallback: run on main thread
        await this._buildOnMainThread(rawData, workerData, healthByPid);
      }
    } else {
      // METRICS PATH: just update metrics on cached structure
      if (this.workerReady) {
        this.workerBusy = true;
        this._pendingRawForResult = rawData;
        try {
          this.worker.postMessage({
            type: 'overlay-metrics',
            seq: this.seq,
            data: { processes: rawData.processes, healthByPid },
          });
        } catch (err) {
          console.error('[SnapshotScheduler] postMessage failed, falling back to main thread:', err);
          this.workerBusy = false;
          this.workerReady = false;
          this._restartWorker();
          await this._buildOnMainThread(rawData, null, healthByPid);
        }
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
        status: {
          ports: portCacheInfo.status,
          processes: processCacheInfo.status,
          docker: getLastDockerStatus(),
        },
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
    // Use a Map only for prev (need object lookup); Set for curr (presence-only)
    const prevPids = new Map(prev.processes.map(p => [p.pid, p]));
    const currPidSet = new Set(currentSnapshot.processes.map(p => p.pid));

    const addedProcesses = currentSnapshot.processes.filter(p => !prevPids.has(p.pid));
    const removedProcessPids = [];
    for (const pid of prevPids.keys()) {
      if (!currPidSet.has(pid)) removedProcessPids.push(pid);
    }
    const modifiedProcesses = currentSnapshot.processes.filter(p => {
      const prev = prevPids.get(p.pid);
      return prev && (prev.cpu !== p.cpu || prev.memory !== p.memory || prev.status !== p.status);
    });

    if (addedProcesses.length || removedProcessPids.length || modifiedProcesses.length) {
      delta.processes = { added: addedProcesses, removed: removedProcessPids, modified: modifiedProcesses };
      if (addedProcesses.length || removedProcessPids.length) hasTopologyChange = true;
    }

    // --- Port diff (keyed by "port-pid") ---
    // Use Sets for both sides — only need presence checking
    const prevPortKeySet = new Set(prev.ports.map(p => `${p.port}-${p.pid}`));
    const currPortKeySet = new Set(currentSnapshot.ports.map(p => `${p.port}-${p.pid}`));

    const addedPorts = currentSnapshot.ports.filter(p => !prevPortKeySet.has(`${p.port}-${p.pid}`));
    const removedPortKeys = [];
    for (const k of prevPortKeySet) {
      if (!currPortKeySet.has(k)) removedPortKeys.push(k);
    }

    if (addedPorts.length || removedPortKeys.length) {
      delta.ports = { added: addedPorts, removed: removedPortKeys };
      hasTopologyChange = true;
    }

    // --- Connection diff (keyed by composite key) ---
    const prevConnKeySet = new Set(prev.connections.map(c => `${c.pid}-${c.localPort}-${c.remoteHost}-${c.remotePort}`));
    const currConnKeySet = new Set(currentSnapshot.connections.map(c => `${c.pid}-${c.localPort}-${c.remoteHost}-${c.remotePort}`));

    const addedConns = currentSnapshot.connections.filter(c => !prevConnKeySet.has(`${c.pid}-${c.localPort}-${c.remoteHost}-${c.remotePort}`));
    const removedConnKeys = [];
    for (const k of prevConnKeySet) {
      if (!currConnKeySet.has(k)) removedConnKeys.push(k);
    }

    if (addedConns.length || removedConnKeys.length) {
      delta.connections = { added: addedConns, removed: removedConnKeys };
      hasTopologyChange = true;
    }

    // --- Graph node diff (keyed by node.id) ---
    const prevNodes = new Map(prev.graph.nodes.map(n => [n.id, n]));
    const currNodeIdSet = new Set(currentSnapshot.graph.nodes.map(n => n.id));

    const addedNodes = currentSnapshot.graph.nodes.filter(n => !prevNodes.has(n.id));
    const removedNodeIds = [];
    for (const id of prevNodes.keys()) {
      if (!currNodeIdSet.has(id)) removedNodeIds.push(id);
    }

    // Single-pass: detect modified nodes and build patches simultaneously
    const modifiedNodes = [];
    for (const n of currentSnapshot.graph.nodes) {
      const p = prevNodes.get(n.id);
      if (!p) continue;

      // Check primitives first (cheap), then arrays (expensive) only if needed
      const typeChanged = p.type !== n.type;
      const nameChanged = p.name !== n.name;
      const commandChanged = p.command !== n.command;
      const projectChanged = p.project !== n.project;
      const projectPathChanged = p.projectPath !== n.projectPath;
      const repoPathChanged = p.repoPath !== n.repoPath;
      const healthChanged = p.healthStatus !== n.healthStatus;
      const cpuChanged = p.cpu !== n.cpu;
      const memoryChanged = p.memory !== n.memory;
      const containerStateChanged = p.containerState !== n.containerState;

      // Quick exit if no primitives changed — skip expensive array comparison
      const anyPrimitiveChanged = typeChanged || nameChanged || commandChanged ||
        projectChanged || projectPathChanged || repoPathChanged ||
        healthChanged || cpuChanged || memoryChanged || containerStateChanged;

      // Shallow array comparison instead of JSON.stringify
      const portsChanged = !shallowArrayEqual(p.ports, n.ports);
      const routesChanged = !shallowArrayEqual(p.routes, n.routes);

      if (!anyPrimitiveChanged && !portsChanged && !routesChanged) continue;

      // Build patch in same pass — no second iteration needed
      const patch = { id: n.id };
      if (typeChanged) patch.type = n.type;
      if (nameChanged) patch.name = n.name;
      if (commandChanged) patch.command = n.command;
      if (projectChanged) patch.project = n.project;
      if (projectPathChanged) patch.projectPath = n.projectPath;
      if (repoPathChanged) patch.repoPath = n.repoPath;
      if (healthChanged) patch.healthStatus = n.healthStatus;
      if (cpuChanged) patch.cpu = n.cpu;
      if (memoryChanged) patch.memory = n.memory;
      if (portsChanged) patch.ports = n.ports;
      if (routesChanged) patch.routes = n.routes;
      if (containerStateChanged) patch.containerState = n.containerState;
      modifiedNodes.push(patch);
    }

    if (addedNodes.length || removedNodeIds.length || modifiedNodes.length) {
      delta.graph = delta.graph || {};
      delta.graph.nodes = { added: addedNodes, removed: removedNodeIds, modified: modifiedNodes };
      if (addedNodes.length || removedNodeIds.length) hasTopologyChange = true;
    }

    // --- Graph edge diff (keyed by edge.id) ---
    const prevEdgeIdSet = new Set(prev.graph.edges.map(e => e.id));
    const currEdgeIdSet = new Set(currentSnapshot.graph.edges.map(e => e.id));

    const addedEdges = currentSnapshot.graph.edges.filter(e => !prevEdgeIdSet.has(e.id));
    const removedEdgeIds = [];
    for (const id of prevEdgeIdSet) {
      if (!currEdgeIdSet.has(id)) removedEdgeIds.push(id);
    }

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

/**
 * Shallow array equality — avoids JSON.stringify for port/route arrays.
 * Compares by reference first, then length, then element identity.
 * For arrays of objects, falls back to key-count comparison per element.
 */
function shallowArrayEqual(a, b) {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i];
    if (ai === bi) continue;
    // For primitive elements
    if (typeof ai !== 'object' || typeof bi !== 'object' || ai === null || bi === null) return false;
    // Shallow object comparison — sufficient for port/route objects
    const keysA = Object.keys(ai);
    const keysB = Object.keys(bi);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (ai[k] !== bi[k]) return false;
    }
  }
  return true;
}

module.exports = { SnapshotScheduler };
