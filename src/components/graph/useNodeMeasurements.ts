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

  // Unlock on window resize so nodes can be re-measured at new sizes.
  useEffect(() => {
    const onResize = () => {
      if (layoutLockedRef.current) {
        layoutLockedRef.current = false;
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      setLayoutVersion((version) => version + 1);
      if (measuredIdsRef.current.size >= nodeCount && allowLock) {
        layoutLockedRef.current = true;
      }
    },
    [nodeCount, allowLock],
  );

  return { nodeHeightsRef, layoutVersion, handleNodeMeasure };
}
