import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { GraphNode } from "../../types/electron";
import {
  getNoteForNode,
  nodeNoteServiceKey,
  noteProjectPath,
  subscribeServiceNoteUpdates,
  upsertServiceNote,
} from "./serviceNotes";
import {
  getOpenNoteNodeId,
  setOpenNoteNodeId,
  subscribeOpenNoteNodeId,
} from "./notePopoverState";

const MAX_LEN = 500;

// Floating yellow sticky-note popover anchored next to its service node.
// Renders inline via `position: absolute` from the React Flow node wrapper,
// so it pans/zooms with the graph.
export function NotePopover({ node }: { node: GraphNode }) {
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

  const isOpen = openNodeId === node.id;
  const cachedBody = note?.body ?? "";

  const [draft, setDraft] = useState(cachedBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync draft from cache whenever the popover is opened or external edits land.
  useEffect(() => {
    if (isOpen) setDraft(cachedBody);
  }, [isOpen, cachedBody]);

  // Auto-focus + auto-grow on open.
  useEffect(() => {
    if (!isOpen) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.selectionStart = el.value.length;
    el.selectionEnd = el.value.length;
  }, [isOpen]);

  const persist = useCallback(
    async (next: string) => {
      if (!projectPath) return false;
      const trimmed = next.slice(0, MAX_LEN);
      if (trimmed === cachedBody) return true;
      setSaving(true);
      setError(null);
      try {
        const serviceKey = nodeNoteServiceKey(node);
        const res = await window.electronAPI.setServiceNote({
          projectPath,
          serviceKey,
          body: trimmed,
        });
        if (!res.success) {
          setError(res.error || "Could not save note");
          return false;
        }
        upsertServiceNote(projectPath, serviceKey, res.note ?? null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save note");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [projectPath, node, cachedBody],
  );

  const close = useCallback(() => {
    setOpenNoteNodeId(null);
    setError(null);
  }, []);

  const saveAndClose = useCallback(async () => {
    const ok = await persist(draft);
    if (ok) close();
  }, [persist, draft, close]);

  // Click outside to save & close. Only attached while open.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current && containerRef.current.contains(target)) return;
      // Don't close on icon clicks — the icon's own handler toggles state.
      const el = target as HTMLElement;
      if (el.closest && el.closest(".service-note-icon-btn")) return;
      void saveAndClose();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [isOpen, saveAndClose]);

  if (!isOpen || !projectPath) return null;

  const remaining = MAX_LEN - draft.length;

  return (
    <div
      ref={containerRef}
      className="service-note-popover"
      role="dialog"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="service-note-popover-tail" aria-hidden="true" />
      <textarea
        ref={textareaRef}
        className="service-note-popover-textarea"
        value={draft}
        maxLength={MAX_LEN}
        placeholder="Leave a quick reminder…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(cachedBody);
            close();
          } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void saveAndClose();
          }
        }}
      />
      <div className="service-note-popover-footer">
        <span className="service-note-popover-hint">
          {error
            ? error
            : saving
              ? "Saving…"
              : remaining < 60
                ? `${remaining} left`
                : "⌘+Enter saves · Esc cancels"}
        </span>
        <button
          type="button"
          className="service-note-popover-save"
          onClick={() => void saveAndClose()}
          disabled={saving}
        >
          Save
        </button>
      </div>
    </div>
  );
}
