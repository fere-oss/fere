import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { GraphNode } from "../../types/electron";
import {
  getNoteForNode,
  noteProjectPath,
  nodeNoteServiceKey,
  subscribeServiceNoteUpdates,
  upsertServiceNote,
} from "./serviceNotes";

const MAX_LEN = 500;

function readNote(node: GraphNode): string {
  const entry = getNoteForNode(node);
  return entry?.body ?? "";
}

export function ServiceNoteEditor({ node }: { node: GraphNode }) {
  const projectPath = noteProjectPath(node);

  // Subscribe to cache so external edits (e.g. another panel saved) reflect here.
  const cachedBody = useSyncExternalStore(
    subscribeServiceNoteUpdates,
    () => readNote(node),
    () => readNote(node),
  );

  const [draft, setDraft] = useState(cachedBody);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Pull cache changes into the draft when not actively editing.
  useEffect(() => {
    if (!isEditing) setDraft(cachedBody);
  }, [cachedBody, isEditing]);

  // Reset when switching nodes.
  useEffect(() => {
    setIsEditing(false);
    setError(null);
  }, [node.id]);

  const save = useCallback(
    async (next: string) => {
      if (!projectPath) {
        setError("Notes require a project path");
        return;
      }
      const trimmed = next.slice(0, MAX_LEN);
      if (trimmed === cachedBody) {
        setIsEditing(false);
        return;
      }
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
          return;
        }
        upsertServiceNote(projectPath, serviceKey, res.note ?? null);
        setIsEditing(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save note");
      } finally {
        setSaving(false);
      }
    },
    [projectPath, node, cachedBody],
  );

  if (!projectPath) {
    return (
      <div className="service-note-block service-note-block-disabled">
        <div className="service-note-label">Note</div>
        <div className="service-note-disabled-msg">
          Notes are only available for services in a tracked project.
        </div>
      </div>
    );
  }

  const remaining = MAX_LEN - draft.length;

  return (
    <div className="service-note-block">
      <div className="service-note-header">
        <span className="service-note-label">Note</span>
        {!isEditing && cachedBody && (
          <button
            type="button"
            className="service-note-edit-btn"
            onClick={() => {
              setDraft(cachedBody);
              setIsEditing(true);
              setTimeout(() => textareaRef.current?.focus(), 0);
            }}
          >
            Edit
          </button>
        )}
      </div>

      {isEditing ? (
        <>
          <textarea
            ref={textareaRef}
            className="service-note-textarea"
            value={draft}
            maxLength={MAX_LEN}
            placeholder="Leave a reminder for yourself or a teammate…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(cachedBody);
                setIsEditing(false);
              } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void save(draft);
              }
            }}
          />
          <div className="service-note-footer">
            <span className="service-note-hint">
              {remaining < 50 ? `${remaining} left` : "⌘+Enter to save"}
            </span>
            <div className="service-note-actions">
              <button
                type="button"
                className="service-note-btn service-note-btn-secondary"
                onClick={() => {
                  setDraft(cachedBody);
                  setIsEditing(false);
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="service-note-btn service-note-btn-primary"
                onClick={() => void save(draft)}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      ) : cachedBody ? (
        <div
          className="service-note-body"
          onClick={() => {
            setDraft(cachedBody);
            setIsEditing(true);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
        >
          {cachedBody}
        </div>
      ) : (
        <button
          type="button"
          className="service-note-add"
          onClick={() => {
            setDraft("");
            setIsEditing(true);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
        >
          + Add a note
        </button>
      )}

      {error && <div className="service-note-error">{error}</div>}
    </div>
  );
}
