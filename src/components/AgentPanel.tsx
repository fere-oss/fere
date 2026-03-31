import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { ChatStep, ExternalApiProvider, GraphNode } from "../types/electron";
import { getServiceColor } from "./graph/constants";
import fereLogo from "../assets/fere.png";

const PROVIDER_ALIAS_MAP: Record<string, string> = {
  gemini: "google gemini",
  aws: "aws bedrock",
  bedrock: "aws bedrock",
};

const RAW_LOGO_TOKEN = (window.electronAPI.logoDevToken || "").trim();
const LOGO_TOKEN = RAW_LOGO_TOKEN.startsWith("pk_") ? RAW_LOGO_TOKEN : "";

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomain(domain: string): string | null {
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0];
  if (!cleaned || !cleaned.includes(".")) return null;
  const parts = cleaned.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const secondLevelSuffixes = new Set(["co", "com", "org", "net", "gov", "ac"]);
  if (parts.length >= 3) {
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (tld.length === 2 && secondLevelSuffixes.has(sld)) {
      return parts.slice(-3).join(".");
    }
  }
  return parts.slice(-2).join(".");
}

function buildProviderDomainMap(providers: ExternalApiProvider[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const provider of providers) {
    const key = normalizeLabel(provider.name);
    const domains = Array.isArray(provider.domains) ? provider.domains : [];
    let selected = "";
    for (const domain of domains) {
      const normalized = normalizeDomain(domain);
      if (!normalized) continue;
      if (!selected) selected = normalized;
      if (!domain.toLowerCase().startsWith("api.")) {
        selected = normalized;
        break;
      }
    }
    if (selected) map[key] = selected;
  }
  return map;
}

function getLogoUrl(name: string, providerDomains: Record<string, string>): string | null {
  const normalizedName = normalizeLabel(name);
  const aliased = PROVIDER_ALIAS_MAP[normalizedName];
  const domain = providerDomains[normalizedName] || (aliased ? providerDomains[aliased] : "");
  if (!domain) return null;
  const params = new URLSearchParams({
    size: "32",
    format: "png",
    fallback: "monogram",
  });
  params.set("token", LOGO_TOKEN || "pk_free");
  return `https://img.logo.dev/${encodeURIComponent(domain)}?${params.toString()}`;
}

function isWordChar(char: string): boolean {
  return /[a-z0-9]/i.test(char);
}

function hasTokenBoundaries(text: string, start: number, length: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = start + length < text.length ? text[start + length] : "";
  const beforeOk = !before || !isWordChar(before);
  const afterOk = !after || !isWordChar(after);
  return beforeOk && afterOk;
}

type ProviderMentionHit = {
  start: number;
  end: number;
  text: string;
};

function findProviderMentionHits(
  text: string,
  providerDomains: Record<string, string>,
): ProviderMentionHit[] {
  if (!text.trim()) return [];
  const lookupTerms = Array.from(
    new Set([...Object.keys(providerDomains), ...Object.keys(PROVIDER_ALIAS_MAP)]),
  ).sort((a, b) => b.length - a.length);
  if (lookupTerms.length === 0) return [];

  const lower = text.toLowerCase();
  const hits: ProviderMentionHit[] = [];
  let cursor = 0;

  while (cursor < lower.length) {
    let bestStart = -1;
    let bestEnd = -1;
    for (const term of lookupTerms) {
      let idx = lower.indexOf(term, cursor);
      while (idx !== -1 && !hasTokenBoundaries(lower, idx, term.length)) {
        idx = lower.indexOf(term, idx + 1);
      }
      if (idx === -1) continue;
      const end = idx + term.length;
      if (
        bestStart === -1 ||
        idx < bestStart ||
        (idx === bestStart && end > bestEnd)
      ) {
        bestStart = idx;
        bestEnd = end;
      }
    }

    if (bestStart === -1) break;
    hits.push({ start: bestStart, end: bestEnd, text: text.slice(bestStart, bestEnd) });
    cursor = bestEnd;
  }

  return hits;
}

type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

function ProviderMention({ text, logoUrl }: { text: string; logoUrl: string }) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [logoUrl]);

  const fallback = text.charAt(0).toUpperCase() || "?";

  return (
    <span className="agp-provider-ref">
      {imgFailed ? (
        <span className="agp-provider-fallback" aria-hidden="true">{fallback}</span>
      ) : (
        <img
          src={logoUrl}
          alt=""
          className="agp-provider-logo"
          loading="lazy"
          decoding="async"
          referrerPolicy="origin"
          onError={() => setImgFailed(true)}
        />
      )}
      <strong>{text}</strong>
    </span>
  );
}

function renderProviderMentionsInText(
  text: string,
  providerDomains: Record<string, string>,
): React.ReactNode {
  const hits = findProviderMentionHits(text, providerDomains);
  if (hits.length === 0) return text;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, idx) => {
    if (hit.start > cursor) nodes.push(text.slice(cursor, hit.start));
    const logoUrl = getLogoUrl(hit.text, providerDomains);
    if (logoUrl) {
      nodes.push(<ProviderMention key={`provider-${idx}-${hit.start}`} text={hit.text} logoUrl={logoUrl} />);
    } else {
      nodes.push(hit.text);
    }
    cursor = hit.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderProviderMentionsInChildren(
  children: React.ReactNode,
  providerDomains: Record<string, string>,
): React.ReactNode {
  if (typeof children === "string") {
    return renderProviderMentionsInText(children, providerDomains);
  }
  if (children == null) return children;
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <React.Fragment key={index}>
        {renderProviderMentionsInChildren(child, providerDomains)}
      </React.Fragment>
    ));
  }
  if (!React.isValidElement(children)) return children;

  const element = children as React.ReactElement<{ children?: React.ReactNode }>;
  const elementType = typeof element.type === "string" ? element.type : "";
  if (elementType === "code" || elementType === "pre" || elementType === "a" || elementType === "strong") {
    return element;
  }

  if (!("children" in element.props)) return element;
  return React.cloneElement(element, {
    ...element.props,
    children: renderProviderMentionsInChildren(element.props.children, providerDomains),
  });
}

// ── Node-linking helpers ──────────────────────────────────────────────────────

// Extract plain text from React children so we can match against node names.
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (children == null) return "";
  if (Array.isArray(children))
    return children.map(extractText).join("");
  if (React.isValidElement(children)) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>;
    return extractText(el.props.children);
  }
  return "";
}

const STARTER_PROMPTS = [
  "What would break if I stopped the database right now?",
  "Walk me through the live topology — what connects to what?",
  "Why aren't my services talking to each other?",
  "Are there any hidden issues I should know about?",
  "Which services are making external API calls?",
];

const CHAT_STORAGE_KEY = "fere.agent-panel.chat.v1";
const MAX_CHAT_THREADS = 30;

type PersistedChatState = {
  open: boolean;
  activeThreadId: string;
  threads: ChatThread[];
  input: string;
};

function createThreadId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function deriveThreadTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((msg) => msg.role === "user" && msg.content.trim().length > 0);
  if (!firstUser) return "New chat";
  const oneLine = firstUser.content.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New chat";
  return oneLine.length > 56 ? `${oneLine.slice(0, 56)}…` : oneLine;
}

function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (m): m is ChatMessage =>
      !!m &&
      (m as ChatMessage).role !== undefined &&
      ((m as ChatMessage).role === "user" || (m as ChatMessage).role === "assistant") &&
      typeof (m as ChatMessage).content === "string",
  );
}

function sanitizeThreads(input: unknown): ChatThread[] {
  if (!Array.isArray(input)) return [];
  const threads: ChatThread[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const maybe = raw as Partial<ChatThread>;
    const messages = sanitizeMessages(maybe.messages);
    const updatedAt =
      typeof maybe.updatedAt === "number" && Number.isFinite(maybe.updatedAt)
        ? maybe.updatedAt
        : Date.now();
    threads.push({
      id: typeof maybe.id === "string" && maybe.id.trim() ? maybe.id : createThreadId(),
      title:
        typeof maybe.title === "string" && maybe.title.trim()
          ? maybe.title.trim()
          : deriveThreadTitle(messages),
      updatedAt,
      messages,
    });
  }
  return threads.slice(0, MAX_CHAT_THREADS);
}

function createThread(messages: ChatMessage[] = []): ChatThread {
  return {
    id: createThreadId(),
    title: deriveThreadTitle(messages),
    updatedAt: Date.now(),
    messages,
  };
}

function loadPersistedChatState(): PersistedChatState {
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) {
      const initialThread = createThread([]);
      return {
        open: false,
        activeThreadId: initialThread.id,
        threads: [initialThread],
        input: "",
      };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedChatState>;
    const parsedAny = parsed as Partial<PersistedChatState> & {
      messages?: unknown;
    };
    let threads = sanitizeThreads(parsedAny.threads);

    // Migration from old single-chat schema: { open, messages, input }
    if (threads.length === 0) {
      const migratedMessages = sanitizeMessages(parsedAny.messages);
      threads = [createThread(migratedMessages)];
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
    return {
      open: false,
      activeThreadId: initialThread.id,
      threads: [initialThread],
      input: "",
    };
  }
}

export function AgentPanel({ nodes }: { nodes: GraphNode[] }) {
  const persistedState = useMemo(() => loadPersistedChatState(), []);
  const [open, setOpen] = useState(persistedState.open);
  const [threads, setThreads] = useState<ChatThread[]>(persistedState.threads);
  const [activeThreadId, setActiveThreadId] = useState(persistedState.activeThreadId);
  const [streamingText, setStreamingText] = useState("");
  const [steps, setSteps] = useState<ChatStep[]>([]);
  const [input, setInput] = useState(persistedState.input);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerDomains, setProviderDomains] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingTextRef = useRef("");

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const messages = activeThread?.messages ?? [];

  const nodeIdsForScan = useMemo(
    () => nodes.filter((n) => n.type !== "external").map((n) => n.id),
    [nodes],
  );

  const serviceCount = useMemo(
    () => nodes.filter((n) => n.type !== "external").length,
    [nodes],
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of nodes) {
      if (node.type !== "external") map.set(node.name.toLowerCase(), node);
    }
    return map;
  }, [nodes]);

  useEffect(() => {
    let mounted = true;
    window.electronAPI
      .getExternalApiProviders()
      .then((providers) => {
        if (!mounted) return;
        setProviderDomains(buildProviderDomainMap(providers));
      })
      .catch(() => {
        if (!mounted) return;
        setProviderDomains({});
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    try {
      const nextState: PersistedChatState = {
        open,
        activeThreadId,
        threads: threads.slice(0, MAX_CHAT_THREADS),
        input,
      };
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(nextState));
    } catch {
      // Ignore localStorage write failures
    }
  }, [open, activeThreadId, threads, input]);

  useEffect(() => {
    if (threads.length > 0) return;
    const next = createThread([]);
    setThreads([next]);
    setActiveThreadId(next.id);
  }, [threads]);

  useEffect(() => {
    if (!threads.some((thread) => thread.id === activeThreadId) && threads[0]) {
      setActiveThreadId(threads[0].id);
    }
  }, [threads, activeThreadId]);

  const focusNode = useCallback((node: GraphNode) => {
    // Switch to service map first, then focus the node
    window.dispatchEvent(new CustomEvent("fere:show-graph"));
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("fere:focus-node", {
          detail: { nodeId: node.id, nodeName: node.name },
        }),
      );
    }, 80);
  }, []);

  const mdComponents = useMemo(
    () => ({
      // Only intercept strong — AI is instructed to bold service names.
      // Checking the full text of the <strong> avoids double-processing
      // that happens when both p and strong components clone children.
      strong: ({ children }: { children?: React.ReactNode }) => {
        const text = extractText(children).trim();
        const node = nodeMap.get(text.toLowerCase());
        if (node) {
          const color = getServiceColor(node.type ?? "");
          return (
            <button
              className="agp-node-ref"
              style={{ "--node-color": color } as React.CSSProperties}
              onClick={() => focusNode(node)}
              title={`Focus ${node.name} · ${node.type ?? "service"}`}
            >
              {text}
            </button>
          );
        }
        const logoUrl = getLogoUrl(text, providerDomains);
        if (logoUrl) {
          return <ProviderMention text={text} logoUrl={logoUrl} />;
        }
        return <strong>{children}</strong>;
      },
      p: ({ children }: { children?: React.ReactNode }) => (
        <p>{renderProviderMentionsInChildren(children, providerDomains)}</p>
      ),
      li: ({ children }: { children?: React.ReactNode }) => (
        <li>{renderProviderMentionsInChildren(children, providerDomains)}</li>
      ),
      blockquote: ({ children }: { children?: React.ReactNode }) => (
        <blockquote>{renderProviderMentionsInChildren(children, providerDomains)}</blockquote>
      ),
      h1: ({ children }: { children?: React.ReactNode }) => (
        <h1>{renderProviderMentionsInChildren(children, providerDomains)}</h1>
      ),
      h2: ({ children }: { children?: React.ReactNode }) => (
        <h2>{renderProviderMentionsInChildren(children, providerDomains)}</h2>
      ),
      h3: ({ children }: { children?: React.ReactNode }) => (
        <h3>{renderProviderMentionsInChildren(children, providerDomains)}</h3>
      ),
    }),
    [nodeMap, focusNode, providerDomains],
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [input]);

  const scrollToEnd = useCallback((smooth = true) => {
    endRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  }, []);

  const updateActiveThreadMessages = useCallback(
    (nextMessages: ChatMessage[]) => {
      setThreads((prev) => {
        const idx = prev.findIndex((thread) => thread.id === activeThreadId);
        if (idx === -1) return prev;
        const current = prev[idx];
        const updated: ChatThread = {
          ...current,
          messages: nextMessages,
          title: deriveThreadTitle(nextMessages),
          updatedAt: Date.now(),
        };
        const next = [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
        return next.slice(0, MAX_CHAT_THREADS);
      });
    },
    [activeThreadId],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming || !activeThread) return;

      const userMsg: ChatMessage = { role: "user", content: trimmed };
      const updatedMessages = [...messages, userMsg];
      updateActiveThreadMessages(updatedMessages);
      setInput("");
      setIsStreaming(true);
      streamingTextRef.current = "";
      setStreamingText("");
      setSteps([]);
      setError(null);

      setTimeout(() => scrollToEnd(true), 50);

      window.electronAPI.onChatToken((token: string) => {
        streamingTextRef.current += token;
        setStreamingText(streamingTextRef.current);
        scrollToEnd(false);
      });

      window.electronAPI.onChatStep((step: ChatStep) => {
        setSteps((prev) => {
          // If same path already in list, mark it done; otherwise append
          const idx = prev.findIndex((s) => s.path === step.path && s.type === step.type);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = { ...next[idx], done: true };
            return next;
          }
          return [...prev, step];
        });
      });

      try {
        const result = await window.electronAPI.agentChat(
          updatedMessages,
          nodeIdsForScan,
        );
        window.electronAPI.offChatToken();
        window.electronAPI.offChatStep();
        // Capture text NOW before finally clears the ref
        const completedText = streamingTextRef.current;
        if (result.success) {
          updateActiveThreadMessages([
            ...updatedMessages,
            { role: "assistant", content: completedText },
          ]);
        } else {
          setError(result.error ?? "No response");
        }
      } catch (err: unknown) {
        window.electronAPI.offChatToken();
        window.electronAPI.offChatStep();
        setError(err instanceof Error ? err.message : "Failed to connect");
      } finally {
        setStreamingText("");
        streamingTextRef.current = "";
        setSteps([]);
        setIsStreaming(false);
        setTimeout(() => scrollToEnd(true), 100);
      }
    },
    [
      activeThread,
      isStreaming,
      messages,
      nodeIdsForScan,
      scrollToEnd,
      updateActiveThreadMessages,
    ],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send(input);
      }
    },
    [send, input],
  );

  const headerSub =
    serviceCount > 0
      ? `${serviceCount} service${serviceCount !== 1 ? "s" : ""} running`
      : "Watching for services";

  const showStream = isStreaming || streamingText.length > 0;
  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  );

  const formatThreadTimestamp = useCallback((ts: number) => {
    try {
      return new Date(ts).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, []);

  const startNewConversation = useCallback(() => {
    const next = createThread([]);
    setThreads((prev) => [next, ...prev].slice(0, MAX_CHAT_THREADS));
    setActiveThreadId(next.id);
    setInput("");
    setError(null);
    setHistoryOpen(false);
  }, []);

  return (
    <>
      <button
        className={`agp-trigger-logo-btn${open ? " agp-trigger-btn-active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Ask Fere"
      >
        <img src={fereLogo} alt="Fere" className="agp-trigger-logo" />
      </button>

      {open && (
        <div className="agp-popup">
          {/* Header */}
          <div className="agp-header">
            <div className="agp-header-left">
              <img src={fereLogo} alt="Fere" className="agp-avatar-logo" />
              <div className="agp-header-text">
                <span className="agp-header-title">Fere</span>
                <span className="agp-header-sub">{headerSub}</span>
              </div>
            </div>
            <div className="agp-header-right">
              {threads.length > 0 && (
                <button
                  className={`agp-scan-btn agp-history-btn${historyOpen ? " agp-scan-btn-active" : ""}`}
                  onClick={() => setHistoryOpen((v) => !v)}
                  title="Chat history"
                  disabled={isStreaming}
                >
                  <svg
                    className="agp-history-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="8" cy="8" r="5.5" />
                    <path d="M8 5.2v3.1l2 1.2" />
                  </svg>
                </button>
              )}
              {threads.length > 0 && (
                <button
                  className="agp-scan-btn"
                  onClick={startNewConversation}
                  title="New conversation"
                  disabled={isStreaming}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  >
                    <path d="M1 7h12M7 1v12" />
                  </svg>
                </button>
              )}
              <button className="agp-close" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
          </div>
          {historyOpen && (
            <div className="agp-history-panel">
              {sortedThreads.length === 0 ? (
                <div className="agp-history-empty">No saved chats yet.</div>
              ) : (
                sortedThreads.map((thread) => (
                  <button
                    key={thread.id}
                    className={`agp-history-item${thread.id === activeThreadId ? " agp-history-item-active" : ""}`}
                    onClick={() => {
                      setActiveThreadId(thread.id);
                      setHistoryOpen(false);
                      setError(null);
                    }}
                  >
                    <span className="agp-history-title">{thread.title}</span>
                    <span className="agp-history-meta">
                      {thread.messages.length} msg · {formatThreadTimestamp(thread.updatedAt)}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}

          {/* Chat body */}
          <div className="agp-chat-body">
            {messages.length === 0 && !showStream ? (
              /* Welcome / starter screen */
              <div className="agp-welcome">
                <img src={fereLogo} alt="Fere" className="agp-welcome-logo" />
                <p className="agp-welcome-title">Ask about your running stack</p>
                <p className="agp-welcome-sub">
                  I can see your live topology, active connections, Docker
                  containers, and codebase config — things no IDE agent can see.
                </p>
                <div className="agp-starters">
                  {STARTER_PROMPTS.map((p) => (
                    <button
                      key={p}
                      className="agp-starter-chip"
                      onClick={() => void send(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              /* Message list */
              <div className="agp-messages">
                {messages.map((msg, i) => (
                  <div key={i} className={`agp-msg agp-msg-${msg.role}`}>
                    <div className="agp-msg-bubble">
                      {msg.role === "assistant" ? (
                        <ReactMarkdown
                          className="agp-markdown"
                          rehypePlugins={[rehypeHighlight]}
                          components={mdComponents}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      ) : (
                        msg.content
                      )}
                    </div>
                  </div>
                ))}

                {showStream && (
                  <div className="agp-msg agp-msg-assistant">
                    <div className="agp-msg-bubble">
                      {steps.length > 0 && (
                        <div className="agp-steps">
                          {steps.map((step, i) => (
                            <div
                              key={i}
                              className={`agp-step${step.done ? " agp-step-done" : ""}`}
                            >
                              <span className="agp-step-icon">
                                {step.type === "list_directory" ? (
                                  // Folder
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M1 3.5C1 2.95 1.45 2.5 2 2.5h2.5l1 1H10c.55 0 1 .45 1 1v4.5c0 .55-.45 1-1 1H2c-.55 0-1-.45-1-1V3.5z" />
                                  </svg>
                                ) : step.type === "run_command" ? (
                                  // Terminal prompt
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="1" y="1.5" width="10" height="9" rx="1.5" />
                                    <path d="M3.5 4.5l2 2-2 2" />
                                    <path d="M7.5 8.5h1" />
                                  </svg>
                                ) : step.type === "get_node_details" ? (
                                  // Node/service lookup
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="6" cy="5" r="2.5" />
                                    <path d="M2 10c0-2.2 1.8-4 4-4s4 1.8 4 4" />
                                  </svg>
                                ) : step.type === "docker_logs" || step.type === "docker_exec" || step.type === "docker_control" ? (
                                  // Docker container box
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="1.5" y="3" width="9" height="7" rx="1" />
                                    <path d="M4 3V2M8 3V2" />
                                    <path d="M4 6.5h4M4 8.5h2" />
                                  </svg>
                                ) : (
                                  // File (read_file)
                                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M2 1.5h5.5L10 4v7H2V1.5z" />
                                    <path d="M7.5 1.5V4H10" />
                                    <path d="M4 6.5h4M4 8.5h2.5" />
                                  </svg>
                                )}
                              </span>
                              <span className="agp-step-label">{step.label}</span>
                              {!step.done && <span className="agp-step-spinner" />}
                            </div>
                          ))}
                        </div>
                      )}
                      {streamingText ? (
                        <ReactMarkdown
                          className="agp-markdown"
                          rehypePlugins={[rehypeHighlight]}
                          components={mdComponents}
                        >
                          {streamingText}
                        </ReactMarkdown>
                      ) : steps.length === 0 ? (
                        <div className="agp-thinking">
                          <span className="agp-dot" />
                          <span className="agp-dot" />
                          <span className="agp-dot" />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}

                {error && <div className="agp-chat-error">{error}</div>}
              </div>
            )}
            <div ref={endRef} />
          </div>

          {/* Input */}
          <div className="agp-input-row">
            <textarea
              ref={inputRef}
              className="agp-input"
              placeholder="Ask anything about your running stack… (Enter to send)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
            />
            <button
              className="agp-send-btn"
              onClick={() => void send(input)}
              disabled={isStreaming || !input.trim()}
              title="Send (Enter)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 8H3" />
                <path d="M9 4l4 4-4 4" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
