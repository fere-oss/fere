import { useCallback, useEffect, useRef, useState } from "react";
import { FLOW_LAYOUT } from "./flowLayout";

export function useNodeMeasurements(nodeIds: string[]) {
  const nodeHeightsRef = useRef<Map<string, number>>(new Map());
  const measuredIdsRef = useRef<Set<string>>(new Set());
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    const validIds = new Set(nodeIds);
    let changed = false;
    const existingIds = Array.from(nodeHeightsRef.current.keys());
    for (const id of existingIds) {
      if (!validIds.has(id)) {
        nodeHeightsRef.current.delete(id);
        measuredIdsRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) {
      setLayoutVersion((version) => version + 1);
    }
  }, [nodeIds]);

  const handleNodeMeasure = useCallback(
    (id: string, height: number) => {
      const rounded = Math.round(height);
      const current = nodeHeightsRef.current.get(id);
      if (rounded <= 1) return; // Ignore transient hidden/unmounted measurements.
      const normalized = Math.max(rounded, FLOW_LAYOUT.NODE_MIN_HEIGHT);
      const next = current ? Math.max(current, normalized) : normalized;
      if (current === next) return;
      nodeHeightsRef.current.set(
        id,
        next,
      );
      measuredIdsRef.current.add(id);
      setLayoutVersion((version) => version + 1);
    },
    [],
  );

  return { nodeHeightsRef, layoutVersion, handleNodeMeasure };
}
