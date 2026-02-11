import { useEffect, useState } from "react";
import {
  externalApiCache,
  externalApiInFlight,
  EXTERNAL_API_CACHE_TTL_MS,
} from "./externalApis";

export function useExternalApis(projectPathsKey: string, bumpVersion: () => void) {
  const [loaded, setLoaded] = useState(false);

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

    (async () => {
      for (const projectPath of projectPaths) {
        if (cancelled) return;
        const cached = externalApiCache.get(projectPath);
        if (
          cached &&
          Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS
        )
          continue;
        if (externalApiInFlight.has(projectPath)) continue;
        externalApiInFlight.add(projectPath);
        try {
          const apis = await window.electronAPI.getExternalApis(projectPath);
          if (cancelled) return;
          externalApiCache.set(projectPath, { timestamp: Date.now(), apis });
          bumpVersion();
        } catch (error) {
          if (cancelled) return;
        } finally {
          externalApiInFlight.delete(projectPath);
        }
      }
      if (!cancelled) setLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPathsKey, bumpVersion]);

  return loaded;
}
