import type { GraphNode } from "../../types/electron";
import { getHealthInfo, getServiceColor } from "./constants";
import { NoteIndicator } from "./NoteIndicator";

/**
 * Minimal level-of-detail node — rendered when zoomed out below LOD_ZOOM_THRESHOLD.
 * Shows just a colored dot (health) + service name + optional port.
 * Much cheaper to render than the full ServiceNode (no routes, APIs, docker info).
 */
export function MinimalServiceNode({
  node,
  onClick,
  onContextMenu,
}: {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
}) {
  const accentColor = getServiceColor(node.type);
  const healthInfo = getHealthInfo(node.healthStatus);
  const mainPort = node.ports[0]?.port;

  return (
    <div
      className="service-node-minimal"
      style={{ "--node-color": accentColor } as React.CSSProperties}
      onClick={(e) => { e.stopPropagation(); onClick(node); }}
      onContextMenu={(e) => onContextMenu(e, node)}
    >
      <div
        className="service-node-minimal-dot"
        style={{ backgroundColor: healthInfo.color, boxShadow: healthInfo.glow }}
      />
      <span className="service-node-minimal-label">{node.name}</span>
      {mainPort && (
        <span className="service-node-minimal-port" style={{ color: accentColor }}>
          :{mainPort}
        </span>
      )}
      <NoteIndicator node={node} />
    </div>
  );
}
