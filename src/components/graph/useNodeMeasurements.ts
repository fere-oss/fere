import { useCallback, useEffect, useRef, useState } from "react";

export function useNodeMeasurements(nodeIds: string[], minHeight: number) {
  const nodeHeightsRef = useRef<Map<string, number>>(new Map());
  const measuredIdsRef = useRef<Set<string>>(new Set());
  const minHeightRef = useRef(minHeight);
  const rafRef = useRef<number | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);

  const bumpLayoutVersion = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setLayoutVersion((version) => version + 1);
    });
  }, []);

  useEffect(() => {
    if (minHeightRef.current === minHeight) return;
    minHeightRef.current = minHeight;
    nodeHeightsRef.current.clear();
    measuredIdsRef.current.clear();
    bumpLayoutVersion();
  }, [minHeight, bumpLayoutVersion]);

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
      bumpLayoutVersion();
    }
  }, [nodeIds, bumpLayoutVersion]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const handleNodeMeasure = useCallback(
    (id: string, height: number) => {
      const rounded = Math.round(height);
      const current = nodeHeightsRef.current.get(id);
      if (rounded <= 1) return; // Ignore transient hidden/unmounted measurements.
      const normalized = Math.max(rounded, minHeightRef.current);
      // Only allow growth during the current node lifecycle to prevent
      // jitter/overlap from intermediate shrinking while async content settles.
      if (current !== undefined && normalized <= current) return;
      nodeHeightsRef.current.set(id, normalized);
      measuredIdsRef.current.add(id);
      bumpLayoutVersion();
    },
    [bumpLayoutVersion],
  );

  return { nodeHeightsRef, layoutVersion, handleNodeMeasure };
}
