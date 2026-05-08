import { useSyncExternalStore } from "react";
import type { GraphNode } from "../../types/electron";
import { getNoteForNode, subscribeServiceNoteUpdates } from "./serviceNotes";

// Tiny indicator placed inside a node's header when a note exists. Reading
// from the cache via useSyncExternalStore keeps each node's render scoped to
// its own note, so editing one node's note doesn't re-render every node.
export function NoteIndicator({ node }: { node: GraphNode }) {
  const note = useSyncExternalStore(
    subscribeServiceNoteUpdates,
    () => getNoteForNode(node),
    () => getNoteForNode(node),
  );
  if (!note || !note.body || !note.body.trim()) return null;
  return (
    <span
      className="service-node-note-dot"
      title={note.body}
      aria-label="Has note"
    />
  );
}
