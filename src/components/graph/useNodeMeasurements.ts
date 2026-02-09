import { useCallback, useEffect, useRef, useState } from "react";
import { FLOW_LAYOUT } from "./flowLayout";

export function useNodeMeasurements(nodesKey: string, nodeCount: number) {
  const nodeHeightsRef = useRef<Map<string, number>>(new Map());
  const measuredIdsRef = useRef<Set<string>>(new Set());
  const layoutLockedRef = useRef(false);
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    measuredIdsRef.current.clear();
    nodeHeightsRef.current.clear();
    layoutLockedRef.current = false;
    setLayoutVersion((version) => version + 1);
  }, [nodesKey]);

  const handleNodeMeasure = useCallback(
    (id: string, height: number) => {
      const rounded = Math.round(height);
      const current = nodeHeightsRef.current.get(id);
      if (current === rounded) return;
      nodeHeightsRef.current.set(
        id,
        Math.max(rounded, FLOW_LAYOUT.NODE_MIN_HEIGHT),
      );
      measuredIdsRef.current.add(id);
      if (layoutLockedRef.current) {
        // React 19 auto-batches all state updates, so rapid calls
        // from multiple ResizeObserver callbacks are merged into one re-render
        setLayoutVersion((version) => version + 1);
      } else if (measuredIdsRef.current.size >= nodeCount) {
        // Initial batch complete
        layoutLockedRef.current = true;
        setLayoutVersion((version) => version + 1);
      }
    },
    [nodeCount],
  );

  return { nodeHeightsRef, layoutVersion, handleNodeMeasure };
}
