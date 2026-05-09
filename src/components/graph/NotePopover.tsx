import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SyntheticEvent } from "react";
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
  const [side, setSide] = useState<"right" | "left">("right");
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveRequestInFlightRef = useRef(false);

  // Pick the side that doesn't overlap a neighboring service node. Runs in
  // useLayoutEffect (before paint) so the popover is placed correctly without
  // a visible jump.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const popoverEl = containerRef.current;
    const wrapper = popoverEl?.parentElement;
    if (!wrapper) return;

    const myNodeContainer = wrapper.closest(".react-flow__node") || wrapper;
    const myRect = wrapper.getBoundingClientRect();
    const popoverRect = popoverEl!.getBoundingClientRect();
    const popWidth = popoverRect.width || 220;
    const popHeight = popoverRect.height || 120;
    const gap = 14;

    const others: DOMRect[] = [];
    document.querySelectorAll(".react-flow__node").forEach((el) => {
      if (el === myNodeContainer) return;
      others.push(el.getBoundingClientRect());
    });

    const rightBox = {
      top: myRect.top,
      bottom: myRect.top + popHeight,
      left: myRect.right + gap,
      right: myRect.right + gap + popWidth,
    };
    const leftBox = {
      top: myRect.top,
      bottom: myRect.top + popHeight,
      left: myRect.left - gap - popWidth,
      right: myRect.left - gap,
    };

    const overlaps = (box: typeof rightBox) =>
      others.some(
        (r) =>
          box.left < r.right &&
          box.right > r.left &&
          box.top < r.bottom &&
          box.bottom > r.top,
      );

    if (!overlaps(rightBox)) setSide("right");
    else if (!overlaps(leftBox)) setSide("left");
    else setSide("right");
    // Re-run when the cached body changes — popover height may grow, which
    // could change overlap calculations.
  }, [isOpen, cachedBody]);

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
    if (getOpenNoteNodeId() !== node.id) return;
    setOpenNoteNodeId(null);
    setError(null);
  }, [node.id]);

  const saveDraft = useCallback(async () => {
    return persist(draft);
  }, [persist, draft]);

  const saveAndClose = useCallback(async () => {
    const ok = await persist(draft);
    if (ok) close();
  }, [persist, draft, close]);

  const runSaveRequest = useCallback((closeWhenDone: boolean) => {
    if (saveRequestInFlightRef.current) return;
    saveRequestInFlightRef.current = true;
    void (async () => {
      if (closeWhenDone) {
        await saveAndClose();
      } else {
        await saveDraft();
      }
    })().finally(() => {
      window.setTimeout(() => {
        saveRequestInFlightRef.current = false;
      }, 0);
    });
  }, [saveAndClose, saveDraft]);

  const requestSaveAndClose = useCallback(() => {
    runSaveRequest(true);
  }, [runSaveRequest]);

  const requestSaveOnly = useCallback(() => {
    runSaveRequest(false);
  }, [runSaveRequest]);

  const focusTextarea = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.value.length;
      el.selectionEnd = el.value.length;
    });
  }, []);

  const stopPopoverEvent = useCallback((e: SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  const stopControlEvent = useCallback((e: SyntheticEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleSaveControlPress = useCallback(
    (e: SyntheticEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      requestSaveAndClose();
    },
    [requestSaveAndClose],
  );

  // Click outside to save & close. Only attached while open.
  // Uses a class-based check so any click landing inside *any* popover
  // surface (including its tail and absolutely-positioned children) is
  // treated as "inside" — more robust than relying solely on containerRef.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !el.closest) return;
      if (el.closest(".service-note-popover")) return;
      const clickedNode = el.closest("[data-node-id]") as HTMLElement | null;
      if (clickedNode) {
        requestSaveOnly();
        if (clickedNode.getAttribute("data-node-id") === node.id) {
          focusTextarea();
        }
        return;
      }
      requestSaveAndClose();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [focusTextarea, isOpen, node.id, requestSaveAndClose, requestSaveOnly]);

  // A click anywhere on the popover background or tail should route the
  // user into editing — focus the textarea. Buttons and the textarea itself
  // handle their own click semantics.
  const handlePopoverClick = useCallback(
    (e: SyntheticEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest("button, textarea")) return;
      focusTextarea();
    },
    [focusTextarea],
  );

  const handlePopoverDoubleClick = useCallback(
    (e: SyntheticEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest("button")) return;
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.select();
    },
    [],
  );

  if (!isOpen || !projectPath) return null;

  const remaining = MAX_LEN - draft.length;

  return (
    <div
      ref={containerRef}
      // React Flow opt-out classes keep mouse/touch events inside the popover
      // from being treated as canvas/node interactions.
      className={`service-note-popover service-note-popover-${side} nodrag nopan nowheel`}
      role="dialog"
      onPointerDown={stopPopoverEvent}
      onPointerUp={stopPopoverEvent}
      onMouseDown={stopPopoverEvent}
      onMouseDownCapture={stopPopoverEvent}
      onClick={handlePopoverClick}
      onDoubleClick={handlePopoverDoubleClick}
      onWheel={stopPopoverEvent}
    >
      <div className="service-note-popover-tail" aria-hidden="true" />
      <button
        type="button"
        className="service-note-popover-close nodrag nopan nowheel"
        onPointerDown={handleSaveControlPress}
        onMouseDown={handleSaveControlPress}
        onPointerUp={stopControlEvent}
        onClick={handleSaveControlPress}
        aria-label="Close note"
        title="Close"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
      <textarea
        ref={textareaRef}
        className="service-note-popover-textarea nodrag nopan nowheel"
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
            requestSaveAndClose();
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
          className="service-note-popover-save nodrag nopan nowheel"
          onPointerDown={handleSaveControlPress}
          onMouseDown={handleSaveControlPress}
          onPointerUp={stopControlEvent}
          onClick={handleSaveControlPress}
          disabled={saving}
        >
          Save
        </button>
      </div>
    </div>
  );
}
