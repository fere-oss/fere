import React from "react";
import type { GraphNode } from "../../types/electron";
import { getServiceColor } from "../graph/constants";

export function MentionDropdown({
  query,
  nodes,
  onSelect,
}: {
  query: string;
  nodes: GraphNode[];
  onSelect: (node: GraphNode) => void;
}) {
  const filtered = nodes
    .filter((n) => n.type !== "external")
    .filter((n) => n.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  if (filtered.length === 0) return null;

  return (
    <div className="agp-mention-dropdown">
      {filtered.map((node) => {
        const color = getServiceColor(node.type);
        return (
          <button
            key={node.id}
            className="agp-mention-item"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(node);
            }}
          >
            <span className="agp-mention-dot" style={{ background: color }} />
            <span className="agp-mention-name">{node.name}</span>
          </button>
        );
      })}
    </div>
  );
}
