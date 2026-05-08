import { useEffect } from "react";
import { seedNotesForProjects } from "../components/graph/serviceNotes";

// Loads .fere/notes.json for every project currently in the graph and seeds
// the renderer-side note cache. Called once at the App level — individual
// nodes / panels read from the cache via subscribeServiceNoteUpdates.
export function useServiceNotes(projectPaths: string[]) {
  // Stable string so the effect only re-runs when the actual set changes.
  const key = [...projectPaths].sort().join("|");

  useEffect(() => {
    let cancelled = false;
    const paths = key.split("|").filter(Boolean);
    if (paths.length === 0) {
      seedNotesForProjects({});
      return;
    }
    void window.electronAPI
      .listServiceNotesForProjects(paths)
      .then((res) => {
        if (cancelled) return;
        if (res.success) seedNotesForProjects(res.byProject);
      })
      .catch(() => {
        // Ignore — notes are non-critical
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
}
