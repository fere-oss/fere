/**
 * Graph Builder Worker — runs CPU-heavy graph computation off the main thread.
 *
 * Receives pre-collected data (processes, ports, connections, CWDs, Docker, routes)
 * from the main thread and returns the computed graph structure or metrics overlay.
 *
 * Messages:
 *   IN:  { type: 'build-structure', seq, data: { processes, ports, connections, cwdMap, dockerSnapshot, routesByProject, healthByPid } }
 *   OUT: { type: 'structure-result', seq, data: { nodes, edges, dockerSnapshot } }
 *
 *   IN:  { type: 'overlay-metrics', seq, data: { processes, healthByPid } }
 *   OUT: { type: 'metrics-result', seq, data: { nodes, edges, dockerSnapshot } }
 */

const { parentPort } = require('worker_threads');
const {
  buildGraphStructure,
  overlayMetrics,
} = require('../services/graphFunctions');

// Persistent cached structure for metrics-only updates
let cachedStructure = null;

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'build-structure': {
        const { processes, ports, connections, cwdMap, dockerSnapshot, routesByProject, healthByPid, containerHealthFn } = msg.data;

        // containerHealthToGraphHealth can't be sent as a function over postMessage,
        // so we use a simple inline implementation matching the dockerMonitor logic
        const containerHealthToGraphHealth = (container) => {
          const status = container.health?.status || container.state;
          switch (status) {
            case 'running': case 'healthy': return 'green';
            case 'starting': case 'paused': case 'restarting': return 'yellow';
            case 'exited': case 'dead': case 'unhealthy': return 'red';
            default: return 'yellow';
          }
        };

        cachedStructure = buildGraphStructure({
          processes,
          ports,
          connections,
          cwdMap: cwdMap || {},
          dockerSnapshot: dockerSnapshot || null,
          routesByProject: routesByProject || {},
          healthByPid: healthByPid || {},
          containerHealthToGraphHealth,
        });

        parentPort.postMessage({
          type: 'structure-result',
          seq: msg.seq,
          data: cachedStructure,
        });
        break;
      }

      case 'overlay-metrics': {
        if (!cachedStructure) {
          // No cached structure yet — request a full build
          parentPort.postMessage({
            type: 'needs-structure',
            seq: msg.seq,
          });
          break;
        }

        const { processes, healthByPid } = msg.data;
        const updatedNodes = overlayMetrics(cachedStructure.nodes, processes, healthByPid || {});

        parentPort.postMessage({
          type: 'metrics-result',
          seq: msg.seq,
          data: {
            nodes: updatedNodes,
            edges: cachedStructure.edges,
            dockerSnapshot: cachedStructure.dockerSnapshot,
          },
        });
        break;
      }

      default:
        console.error(`[GraphBuilder Worker] Unknown message type: ${msg.type}`);
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      seq: msg.seq,
      error: error.message,
    });
  }
});
