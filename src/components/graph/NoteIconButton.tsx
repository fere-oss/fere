import { useSyncExternalStore } from "react";
import type { GraphNode } from "../../types/electron";
import {
  getNoteForNode,
  noteProjectPath,
  subscribeServiceNoteUpdates,
} from "./serviceNotes";
import {
  getOpenNoteNodeId,
  subscribeOpenNoteNodeId,
  toggleOpenNoteNodeId,
} from "./notePopoverState";

// Small clickable note icon that lives in a service node's header. Clicking
// it opens the sticky-note popover (rendered separately as a sibling of the
// node card so it can extend outside the card's overflow:hidden box).
export function NoteIconButton({ node }: { node: GraphNode }) {
  const projectPath = noteProjectPath(node);

  const note = useSyncExternalStore(
    subscribeServiceNoteUpdates,
    () => getNoteForNode(node),
    () => getNoteForNode(node),
  );

  const openNodeId = useSyncExternalStore(
    subscribeOpenNoteNodeId,
    getOpenNoteNodeId,
    getOpenNoteNodeId,
  );

  if (!projectPath) return null;

  const hasNote = !!note?.body && note.body.trim().length > 0;
  const isOpen = openNodeId === node.id;

  return (
    <button
      type="button"
      className={[
        "service-note-icon-btn",
        hasNote && "service-note-icon-btn-active",
        isOpen && "service-note-icon-btn-open",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={(e) => {
        e.stopPropagation();
        toggleOpenNoteNodeId(node.id);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title={hasNote ? note!.body : "Add note"}
      aria-label={hasNote ? "Edit note" : "Add note"}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill={hasNote ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      >
        <path d="M3 2.5h6.5L13 6v7.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
        <path d="M9.5 2.5V6H13" fill="none" />
      </svg>
    </button>
  );
}
