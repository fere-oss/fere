import { useEffect } from "react";
import {
  externalApiCache,
  externalApiInFlight,
  EXTERNAL_API_CACHE_TTL_MS,
} from "./externalApis";

export function useExternalApis(projectPathsKey: string, bumpVersion: () => void) {
  useEffect(() => {
    if (!window.electronAPI?.getExternalApis) return;
    if (!projectPathsKey) return;

    const projectPaths = projectPathsKey.split(",").filter(Boolean);
    if (projectPaths.length === 0) return;

    let cancelled = false;
    const timer = setTimeout(() => {
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
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectPathsKey, bumpVersion]);
}
