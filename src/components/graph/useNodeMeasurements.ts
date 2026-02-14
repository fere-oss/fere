import { useCallback, useEffect, useRef, useState } from "react";

export function useNodeMeasurements(nodeIds: string[], minHeight: number) {
  const nodeHeightsRef = useRef<Map<string, number>>(new Map());
  const measuredIdsRef = useRef<Set<string>>(new Set());
  const minHeightRef = useRef(minHeight);
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    if (minHeightRef.current === minHeight) return;
    minHeightRef.current = minHeight;
    nodeHeightsRef.current.clear();
    measuredIdsRef.current.clear();
    setLayoutVersion((version) => version + 1);
  }, [minHeight]);

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
      const normalized = Math.max(rounded, minHeightRef.current);
      const next = normalized;
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
