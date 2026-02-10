import { useCallback, useEffect, useRef, useState } from "react";
import { FLOW_LAYOUT } from "./flowLayout";

export function useNodeMeasurements(nodesKey: string, nodeCount: number, allowLock: boolean) {
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

  // Unlock measurements while external data is still loading so
  // nodes can be re-measured once their content grows.
  useEffect(() => {
    if (!allowLock && layoutLockedRef.current) {
      layoutLockedRef.current = false;
    }
  }, [allowLock]);

  const handleNodeMeasure = useCallback(
    (id: string, height: number) => {
      if (layoutLockedRef.current) return;
      const rounded = Math.round(height);
      const current = nodeHeightsRef.current.get(id);
      if (current === rounded) return;
      nodeHeightsRef.current.set(
        id,
        Math.max(rounded, FLOW_LAYOUT.NODE_MIN_HEIGHT),
      );
      measuredIdsRef.current.add(id);
      if (measuredIdsRef.current.size >= nodeCount) {
        setLayoutVersion((version) => version + 1);
        if (allowLock) {
          layoutLockedRef.current = true;
        }
      }
    },
    [nodeCount, allowLock],
  );

  return { nodeHeightsRef, layoutVersion, handleNodeMeasure };
}
