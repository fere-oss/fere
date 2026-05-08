// Tracks which service node currently has its sticky-note popover open.
// Only one popover is open at a time — opening a new one closes the previous.

let openNodeId: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function getOpenNoteNodeId(): string | null {
  return openNodeId;
}

export function setOpenNoteNodeId(id: string | null) {
  if (openNodeId === id) return;
  openNodeId = id;
  notify();
}

export function toggleOpenNoteNodeId(id: string) {
  setOpenNoteNodeId(openNodeId === id ? null : id);
}

export function subscribeOpenNoteNodeId(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
