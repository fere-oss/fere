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
  dimmed: boolean;
  highlighted: boolean;
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
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!nodeRef.current) return;
    const element = nodeRef.current;
    let rafId = 0;
    const measure = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const d = dataRef.current;
        d.onMeasure(d.node.id, element.getBoundingClientRect().height);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const wrapperClass = [
    "rf-node-wrapper",
    data.animate && "rf-node-animate",
    data.dimmed && "rf-node-dimmed",
    data.highlighted && "rf-node-highlighted",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={nodeRef}
      className={wrapperClass}
      style={{ animationDelay: `${data.animationIndex * 40}ms` }}
    >
      <Handle type="target" id="target-top" position={Position.Top} className="rf-handle rf-handle-target" />
      <Handle type="target" id="target-bottom" position={Position.Bottom} className="rf-handle rf-handle-target" />
      <Handle type="target" id="target-left" position={Position.Left} className="rf-handle rf-handle-target" />
      <Handle type="target" id="target-right" position={Position.Right} className="rf-handle rf-handle-target" />
      <ServiceNode
        node={data.node}
        onClick={data.onNodeClick}
        onContextMenu={data.onNodeContextMenu}
        animationIndex={0}
      />
      <Handle type="source" id="source-top" position={Position.Top} className="rf-handle rf-handle-source" />
      <Handle type="source" id="source-bottom" position={Position.Bottom} className="rf-handle rf-handle-source" />
      <Handle type="source" id="source-left" position={Position.Left} className="rf-handle rf-handle-source" />
      <Handle type="source" id="source-right" position={Position.Right} className="rf-handle rf-handle-source" />
    </div>
  );
}

export const flowNodeTypes = {
  service: FlowServiceNode,
  tierLabel: TierLabelNode,
  groupLabel: GroupLabelNode,
  groupBox: GroupBoxNode,
} as const;
