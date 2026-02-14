import { useEffect, useState } from "react";
import {
  externalApiCache,
  externalApiInFlight,
  EXTERNAL_API_CACHE_TTL_MS,
  setExternalApiCacheEntry,
  subscribeExternalApiCacheUpdates,
} from "./externalApis";

export function useExternalApis(projectPathsKey: string) {
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    return subscribeExternalApiCacheUpdates(() => {
      setVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.getExternalApis) {
      setLoaded(true);
      return;
    }
    if (!projectPathsKey) {
      setLoaded(true);
      return;
    }

    const projectPaths = projectPathsKey.split(",").filter(Boolean);
    if (projectPaths.length === 0) {
      setLoaded(true);
      return;
    }

    setLoaded(false);
    let cancelled = false;

    const uncachedPaths = projectPaths.filter((projectPath) => {
      const cached = externalApiCache.get(projectPath);
      if (cached && Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS) return false;
      if (externalApiInFlight.has(projectPath)) return false;
      return true;
    });

    if (uncachedPaths.length === 0) {
      setLoaded(true);
      return;
    }

    uncachedPaths.forEach((p) => externalApiInFlight.add(p));

    Promise.all(
      uncachedPaths.map(async (projectPath) => {
        try {
          const apis = await window.electronAPI.getExternalApis(projectPath);
          if (cancelled) return;
          setExternalApiCacheEntry(projectPath, apis);
        } catch {
          // Scan failed for this project — skip
        } finally {
          externalApiInFlight.delete(projectPath);
        }
      }),
    ).then(() => {
      if (!cancelled) setLoaded(true);
    });

    return () => {
      cancelled = true;
      // Remove in-flight markers so a StrictMode re-invocation (or a
      // re-run after projectPathsKey changes) can retry these paths
      // instead of skipping them as "already in-flight".
      uncachedPaths.forEach((p) => externalApiInFlight.delete(p));
    };
  }, [projectPathsKey]);

  return { loaded, version };
}
