import { useEffect } from "react";
import {
  externalApiCache,
  externalApiInFlight,
  EXTERNAL_API_CACHE_TTL_MS,
  setExternalApiCacheEntry,
} from "./externalApis";

export function useExternalApis(projectPathsKey: string) {
  useEffect(() => {
    if (!window.electronAPI?.getExternalApis) {
      return;
    }
    if (!projectPathsKey) {
      return;
    }

    const projectPaths = projectPathsKey.split(",").filter(Boolean);
    if (projectPaths.length === 0) {
      return;
    }
    let cancelled = false;

    const uncachedPaths = projectPaths.filter((projectPath) => {
      const cached = externalApiCache.get(projectPath);
      if (cached && Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS) return false;
      if (externalApiInFlight.has(projectPath)) return false;
      return true;
    });

    if (uncachedPaths.length === 0) {
      return;
    }

    uncachedPaths.forEach((p) => externalApiInFlight.add(p));

    const runWithConcurrency = async (maxConcurrent = 3) => {
      let index = 0;
      const workers = Array.from({ length: Math.min(maxConcurrent, uncachedPaths.length) }, async () => {
        while (!cancelled) {
          const currentIndex = index;
          index += 1;
          if (currentIndex >= uncachedPaths.length) break;
          const projectPath = uncachedPaths[currentIndex];
          try {
            const apis = await window.electronAPI.getExternalApis(projectPath);
            if (cancelled) return;
            setExternalApiCacheEntry(projectPath, apis);
          } catch {
            // Scan failed for this project — skip
          } finally {
            externalApiInFlight.delete(projectPath);
          }
        }
      });
      await Promise.all(workers);
    };

    void runWithConcurrency();

    return () => {
      cancelled = true;
      // Remove in-flight markers so a StrictMode re-invocation (or a
      // re-run after projectPathsKey changes) can retry these paths
      // instead of skipping them as "already in-flight".
      uncachedPaths.forEach((p) => externalApiInFlight.delete(p));
    };
  }, [projectPathsKey]);
}
