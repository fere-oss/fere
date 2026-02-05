import { useEffect, useRef } from "react";
import type { GraphNode } from "../../types/electron";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Handle, Position } from "reactflow";
import { ServiceNode } from "./ServiceNodes";

export type FlowServiceNodeData = {
  node: GraphNode;
  onNodeClick: (node: GraphNode) => void;
  onNodeContextMenu: (e: ReactMouseEvent, node: GraphNode) => void;
  animate: boolean;
  animationIndex: number;
  onMeasure: (id: string, height: number) => void;
};

export function TierLabelNode({ data }: { data: { text: string } }) {
  return <div className="graph-tier-label">{data.text}</div>;
}

export function GroupLabelNode({
  data,
}: {
  data: { text: string; color: string };
}) {
  return (
    <div
      className="graph-group-label"
      style={{ ["--group-color" as string]: data.color }}
    >
      {data.text}
    </div>
  );
}

export function GroupBoxNode({
  data,
}: {
  data: { width: number; height: number; color: string };
}) {
  return (
    <div
      className="graph-group-box"
      style={{
        width: data.width,
        height: data.height,
        ["--group-color" as string]: data.color,
      }}
    />
  );
}

export function FlowServiceNode({ data }: { data: FlowServiceNodeData }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!nodeRef.current) return;
    const element = nodeRef.current;
    const measure = () => {
      data.onMeasure(data.node.id, element.getBoundingClientRect().height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [data]);

  return (
    <div
      ref={nodeRef}
      className={`rf-node-wrapper${data.animate ? " rf-node-animate" : ""}`}
      style={{ animationDelay: `${data.animationIndex * 40}ms` }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="rf-handle rf-handle-target"
      />
      <ServiceNode
        node={data.node}
        onClick={data.onNodeClick}
        onContextMenu={data.onNodeContextMenu}
        animationIndex={0}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="rf-handle rf-handle-source"
      />
    </div>
  );
}

export const flowNodeTypes = {
  service: FlowServiceNode,
  tierLabel: TierLabelNode,
  groupLabel: GroupLabelNode,
  groupBox: GroupBoxNode,
} as const;
