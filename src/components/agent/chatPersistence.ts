import type {
  ChatThread,
  ContextSnapshot,
  FeedFinding,
  FeedItem,
  FeedMessage,
  PersistedChatState,
} from "./types";

export const CHAT_STORAGE_KEY = "fere.agent-panel.chat.v1";
export const MAX_CHAT_THREADS = 30;

export function createThreadId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/^[-*]\s+/gm, "");
}

export function deriveThreadTitle(feed: FeedItem[]): string {
  const firstUser = feed.find(
    (item): item is FeedMessage =>
      item.kind === "message" && item.role === "user" && item.content.trim().length > 0,
  );
  if (!firstUser) return "New chat";
  const clean = stripMarkdown(firstUser.content).replace(/\s+/g, " ").trim();
  return clean.length > 56 ? `${clean.slice(0, 56)}…` : clean;
}

export function sanitizeFeed(input: unknown): FeedItem[] {
  if (!Array.isArray(input)) return [];
  const items: FeedItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    // Old format: { role, content } without kind — migrate
    if (
      !m.kind &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
    ) {
      items.push({ kind: "message", role: m.role as "user" | "assistant", content: m.content });
      continue;
    }
    if (
      m.kind === "message" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
    ) {
      const msg: FeedMessage = {
        kind: "message",
        role: m.role as "user" | "assistant",
        content: m.content,
        copyable: m.copyable === true,
      };
      items.push(msg);
      continue;
    }
    if (
      m.kind === "context" &&
      m.snapshot &&
      typeof m.snapshot === "object" &&
      typeof m.copyText === "string"
    ) {
      items.push({ kind: "context", snapshot: m.snapshot as ContextSnapshot, copyText: m.copyText });
      continue;
    }
    if (
      m.kind === "message" &&
      m.contextSnapshot &&
      typeof m.contextSnapshot === "object" &&
      typeof m.content === "string"
    ) {
      items.push({
        kind: "context",
        snapshot: m.contextSnapshot as ContextSnapshot,
        copyText: m.content,
      });
      continue;
    }
    // Findings are transient — do NOT restore from storage
  }
  return items;
}

export function sanitizeThreads(input: unknown): ChatThread[] {
  if (!Array.isArray(input)) return [];
  const threads: ChatThread[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const maybe = raw as Partial<ChatThread> & { messages?: unknown };
    const feed = sanitizeFeed(maybe.feed ?? maybe.messages);
    const updatedAt =
      typeof maybe.updatedAt === "number" && Number.isFinite(maybe.updatedAt)
        ? maybe.updatedAt
        : Date.now();
    threads.push({
      id:
        typeof maybe.id === "string" && maybe.id.trim()
          ? maybe.id
          : createThreadId(),
      title:
        typeof maybe.title === "string" && maybe.title.trim()
          ? maybe.title.trim()
          : deriveThreadTitle(feed),
      updatedAt,
      feed,
    });
  }
  return threads.slice(0, MAX_CHAT_THREADS);
}

export function createThread(feed: FeedItem[] = []): ChatThread {
  return {
    id: createThreadId(),
    title: deriveThreadTitle(feed),
    updatedAt: Date.now(),
    feed,
  };
}

export function loadPersistedChatState(): PersistedChatState {
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) {
      const initialThread = createThread([]);
      return { open: false, activeThreadId: initialThread.id, threads: [initialThread], input: "" };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
    const parsedAny = parsed as Partial<PersistedChatState> & { messages?: unknown };
    let threads = sanitizeThreads(parsedAny.threads);

    // Migration from old single-chat schema: { open, messages, input }
    if (threads.length === 0) {
      const migratedFeed = sanitizeFeed(parsedAny.messages);
      threads = [createThread(migratedFeed)];
    }

    const activeThreadId =
      typeof parsed.activeThreadId === "string" &&
      threads.some((thread) => thread.id === parsed.activeThreadId)
        ? parsed.activeThreadId
        : threads[0].id;
    return {
      open: parsed.open === true,
      activeThreadId,
      threads,
      input: typeof parsed.input === "string" ? parsed.input : "",
    };
  } catch {
    const initialThread = createThread([]);
    return { open: false, activeThreadId: initialThread.id, threads: [initialThread], input: "" };
  }
}
