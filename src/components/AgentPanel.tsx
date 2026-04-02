import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type {
  AgentFinding,
  AgentFixAction,
  AgentSeverity,
  ChatStep,
  ExternalApiProvider,
  FixProposal,
  GraphNode,
} from "../types/electron";
import { getServiceColor } from "./graph/constants";
import fereLogo from "../assets/fere.png";
import sentinelLogo from "../assets/sentinel.png";

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

function buildProviderDomainMap(
  providers: ExternalApiProvider[],
): Record<string, string> {
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

function getLogoUrl(
  name: string,
  providerDomains: Record<string, string>,
): string | null {
  const normalizedName = normalizeLabel(name);
  const aliased = PROVIDER_ALIAS_MAP[normalizedName];
  const domain =
    providerDomains[normalizedName] ||
    (aliased ? providerDomains[aliased] : "");
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

function hasTokenBoundaries(
  text: string,
  start: number,
  length: number,
): boolean {
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
    new Set([
      ...Object.keys(providerDomains),
      ...Object.keys(PROVIDER_ALIAS_MAP),
    ]),
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
    hits.push({
      start: bestStart,
      end: bestEnd,
      text: text.slice(bestStart, bestEnd),
    });
    cursor = bestEnd;
  }

  return hits;
}

type FeedMessage = { kind: "message"; role: "user" | "assistant"; content: string };
type FeedFinding = {
  kind: "finding";
  id: string;
  service: string;
  summary: string;
  severity: AgentSeverity;
  fix: AgentFixAction | null;
  stage: IncidentStage;
  error?: string;
  insertedAt: number;
};
type FeedItem = FeedMessage | FeedFinding;
type IncidentStage = "detected" | "fixing" | "fixed" | "verified" | "escalated";
type ChatThread = { id: string; title: string; updatedAt: number; feed: FeedItem[] };
// Keep ChatMessage as an alias for backwards compat in a few call sites
type ChatMessage = FeedMessage;

function ProviderMention({ text, logoUrl }: { text: string; logoUrl: string }) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [logoUrl]);

  return (
    <span className="agp-provider-ref">
      {!imgFailed && (
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
      nodes.push(
        <ProviderMention
          key={`provider-${idx}-${hit.start}`}
          text={hit.text}
          logoUrl={logoUrl}
        />,
      );
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

  const element = children as React.ReactElement<{
    children?: React.ReactNode;
  }>;
  const elementType = typeof element.type === "string" ? element.type : "";
  if (
    elementType === "code" ||
    elementType === "pre" ||
    elementType === "a" ||
    elementType === "strong"
  ) {
    return element;
  }

  if (!("children" in element.props)) return element;
  return React.cloneElement(element, {
    ...element.props,
    children: renderProviderMentionsInChildren(
      element.props.children,
      providerDomains,
    ),
  });
}

// ── Node-linking helpers ──────────────────────────────────────────────────────

// Extract plain text from React children so we can match against node names.
function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (children == null) return "";
  if (Array.isArray(children)) return children.map(extractText).join("");
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

function deriveThreadTitle(feed: FeedItem[]): string {
  const firstUser = feed.find(
    (item): item is FeedMessage =>
      item.kind === "message" && item.role === "user" && item.content.trim().length > 0,
  );
  if (!firstUser) return "New chat";
  const oneLine = firstUser.content.replace(/\s+/g, " ").trim();
  return oneLine.length > 56 ? `${oneLine.slice(0, 56)}…` : oneLine;
}

function sanitizeFeed(input: unknown): FeedItem[] {
  if (!Array.isArray(input)) return [];
  const items: FeedItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    // Old format: { role, content } without kind — migrate
    if (!m.kind && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      items.push({ kind: "message", role: m.role as "user" | "assistant", content: m.content });
      continue;
    }
    // New message format
    if (m.kind === "message" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      items.push({ kind: "message", role: m.role as "user" | "assistant", content: m.content });
      continue;
    }
    // Findings are transient — do NOT restore from storage
  }
  return items;
}

function sanitizeThreads(input: unknown): ChatThread[] {
  if (!Array.isArray(input)) return [];
  const threads: ChatThread[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const maybe = raw as Partial<ChatThread> & { messages?: unknown };
    // Support both old "messages" key and new "feed" key
    const feed = sanitizeFeed(maybe.feed ?? maybe.messages);
    const updatedAt =
      typeof maybe.updatedAt === "number" && Number.isFinite(maybe.updatedAt)
        ? maybe.updatedAt
        : Date.now();
    threads.push({
      id: typeof maybe.id === "string" && maybe.id.trim() ? maybe.id : createThreadId(),
      title: typeof maybe.title === "string" && maybe.title.trim() ? maybe.title.trim() : deriveThreadTitle(feed),
      updatedAt,
      feed,
    });
  }
  return threads.slice(0, MAX_CHAT_THREADS);
}

function createThread(feed: FeedItem[] = []): ChatThread {
  return { id: createThreadId(), title: deriveThreadTitle(feed), updatedAt: Date.now(), feed };
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
    return {
      open: false,
      activeThreadId: initialThread.id,
      threads: [initialThread],
      input: "",
    };
  }
}

function FindingCard({
  item,
  onFix,
  onExplain,
  onDismiss,
  isStreaming,
}: {
  item: FeedFinding;
  onFix: (id: string) => void;
  onExplain: (finding: FeedFinding) => void;
  onDismiss: (id: string) => void;
  isStreaming: boolean;
}) {
  const canDismiss =
    item.stage === "detected" ||
    item.stage === "verified" ||
    item.stage === "escalated";

  return (
    <div className={`agp-finding-card agp-finding-stage-${item.stage}`}>
      <div className="agp-finding-card-header">
        <span className={`agp-finding-dot agp-finding-dot-${item.severity}`} />
        <span className="agp-finding-service">{item.service}</span>
        {canDismiss && (
          <button className="agp-finding-dismiss" onClick={() => onDismiss(item.id)} title="Dismiss">
            ×
          </button>
        )}
      </div>
      <div className="agp-finding-summary">{item.summary}</div>

      {item.stage === "detected" && (
        <div className="agp-finding-actions">
          {item.fix &&
            (item.fix.type === "restart-container" || item.fix.type === "kill-port") && (
              <button
                className="agp-finding-fix-btn"
                onClick={() => onFix(item.id)}
                disabled={isStreaming}
              >
                {item.fix.type === "restart-container"
                  ? "Restart container"
                  : `Kill :${item.fix.port}`}
              </button>
            )}
          <button
            className="agp-finding-explain-btn"
            onClick={() => onExplain(item)}
            disabled={isStreaming}
          >
            Explain
          </button>
        </div>
      )}

      {(item.stage === "fixing" || item.stage === "fixed") && (
        <div className="agp-finding-status">
          <span className="agp-step-spinner" />
          {item.stage === "fixing" ? "Applying fix…" : "Verifying…"}
        </div>
      )}

      {item.stage === "verified" && (
        <div className="agp-finding-status agp-finding-status-verified">
          ✓ Fixed
        </div>
      )}

      {item.stage === "escalated" && (
        <div className="agp-finding-escalated">
          <div className="agp-finding-status agp-finding-status-escalated">
            {item.error ?? "Needs manual review"}
          </div>
          <button
            className="agp-finding-explain-btn"
            onClick={() => onExplain(item)}
            disabled={isStreaming}
          >
            Explain
          </button>
        </div>
      )}
    </div>
  );
}

export function AgentPanel({
  nodes,
  tabLabel,
}: {
  nodes: GraphNode[];
  tabLabel?: string | null;
}) {
  const persistedState = useMemo(() => loadPersistedChatState(), []);
  const [open, setOpen] = useState(persistedState.open);
  const [threads, setThreads] = useState<ChatThread[]>(persistedState.threads);
  const [activeThreadId, setActiveThreadId] = useState(
    persistedState.activeThreadId,
  );
  const [streamingText, setStreamingText] = useState("");
  const [steps, setSteps] = useState<ChatStep[]>([]);
  const [pendingFixes, setPendingFixes] = useState<
    (FixProposal & {
      status: "pending" | "applying" | "done" | "error";
      errorMsg?: string;
    })[]
  >([]);
  const [unreadFindings, setUnreadFindings] = useState(0);
  const [input, setInput] = useState(persistedState.input);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerDomains, setProviderDomains] = useState<
    Record<string, string>
  >({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingTextRef = useRef("");
  const surfacedByTabRef = useRef<Map<string, Set<string>>>(new Map());
  const autopilotInFlightRef = useRef<Set<string>>(new Set());
  // Pending investigation message — sent once activeThread settles after thread switch
  const pendingInvestigationRef = useRef<string | null>(null);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const feed = useMemo(() => activeThread?.feed ?? [], [activeThread]);

  const nodeIdsForScan = useMemo(
    () => nodes.filter((n) => n.type !== "external").map((n) => n.id),
    [nodes],
  );
  const nodeIdsScopeSignature = useMemo(
    () => [...nodeIdsForScan].sort().join("|"),
    [nodeIdsForScan],
  );

  const serviceCount = useMemo(
    () => nodes.filter((n) => n.type !== "external").length,
    [nodes],
  );
  const activeIncidentCount = useMemo(
    () =>
      feed.filter(
        (item): item is FeedFinding =>
          item.kind === "finding" &&
          (item.stage === "detected" || item.stage === "fixing" || item.stage === "fixed"),
      ).length,
    [feed],
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of nodes) {
      if (node.type !== "external") map.set(node.name.toLowerCase(), node);
    }
    return map;
  }, [nodes]);

  const tabScopeKey = useMemo(() => tabLabel ?? "__system__", [tabLabel]);

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

  // Shift main content when panel opens (VS Code-style layout push)
  useEffect(() => {
    if (open) {
      document.body.classList.add("sentinel-panel-open");
    } else {
      document.body.classList.remove("sentinel-panel-open");
    }
    return () => document.body.classList.remove("sentinel-panel-open");
  }, [open]);

  // Keep panel top aligned with .app-body so it matches Service Map height.
  useEffect(() => {
    const root = document.documentElement;
    const appBody = document.querySelector(".app-body") as HTMLElement | null;
    if (!appBody) return;

    const updateTopOffset = () => {
      const { top } = appBody.getBoundingClientRect();
      root.style.setProperty("--agp-top-offset", `${Math.max(0, Math.round(top))}px`);
    };

    updateTopOffset();

    const resizeObserver = new ResizeObserver(updateTopOffset);
    resizeObserver.observe(appBody);
    window.addEventListener("resize", updateTopOffset);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateTopOffset);
      root.style.removeProperty("--agp-top-offset");
    };
  }, []);

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
        <blockquote>
          {renderProviderMentionsInChildren(children, providerDomains)}
        </blockquote>
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

  const updateActiveThreadFeed = useCallback(
    (nextFeed: FeedItem[]) => {
      setThreads((prev) => {
        const idx = prev.findIndex((thread) => thread.id === activeThreadId);
        if (idx === -1) return prev;
        const current = prev[idx];
        const updated: ChatThread = {
          ...current,
          feed: nextFeed,
          title: deriveThreadTitle(nextFeed),
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

      const userItem: FeedMessage = { kind: "message", role: "user", content: trimmed };
      const updatedFeed = [...feed, userItem];
      updateActiveThreadFeed(updatedFeed);
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
          const idx = prev.findIndex(
            (s) => s.path === step.path && s.type === step.type,
          );
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = { ...next[idx], done: true };
            return next;
          }
          return [...prev, step];
        });
      });

      setPendingFixes([]);
      window.electronAPI.onFixProposal((proposal: FixProposal) => {
        setPendingFixes((prev) => {
          if (prev.some((f) => f.id === proposal.id)) return prev;
          return [...prev, { ...proposal, status: "pending" }];
        });
      });

      // Only send message items to the AI (not finding cards)
      const chatMessages = feed
        .filter((item): item is FeedMessage => item.kind === "message")
        .map(({ role, content }) => ({ role, content }));
      const aiMessages = [...chatMessages, { role: "user" as const, content: trimmed }];

      try {
        const result = await window.electronAPI.agentChat(
          aiMessages,
          nodeIdsForScan,
          tabLabel ?? null,
          { autopilotEnabled },
        );
        window.electronAPI.offChatToken();
        window.electronAPI.offChatStep();
        window.electronAPI.offFixProposal();
        const completedText = streamingTextRef.current;
        if (result.success) {
          updateActiveThreadFeed([
            ...updatedFeed,
            { kind: "message", role: "assistant", content: completedText },
          ]);
        } else {
          setError(result.error ?? "No response");
        }
      } catch (err: unknown) {
        window.electronAPI.offChatToken();
        window.electronAPI.offChatStep();
        window.electronAPI.offFixProposal();
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
      autopilotEnabled,
      feed,
      isStreaming,
      nodeIdsForScan,
      scrollToEnd,
      tabLabel,
      updateActiveThreadFeed,
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

  // Drain pending investigation once activeThread has settled on the fresh thread
  useEffect(() => {
    if (!pendingInvestigationRef.current || isStreaming) return;
    const msg = pendingInvestigationRef.current;
    pendingInvestigationRef.current = null;
    void send(msg);
  }, [activeThread, isStreaming, send]);

  // Feature: click a node → Sentinel auto-investigates
  useEffect(() => {
    const handler = (e: Event) => {
      const { nodeName, healthStatus, ports, command } =
        (e as CustomEvent).detail ?? {};
      if (!nodeName) return;

      const portStr = ports?.length ? ` on port ${(ports as number[]).join(", ")}` : "";
      const cmdStr = command ? ` (${String(command).slice(0, 60)})` : "";
      const isUnhealthy = healthStatus === "red" || healthStatus === "yellow";
      const msg = isUnhealthy
        ? `Investigate **${nodeName}**${portStr}${cmdStr} — health is ${healthStatus}. What's wrong and how do I fix it? Check ports, connections, and logs if it's a container.`
        : `Tell me about **${nodeName}**${portStr}${cmdStr} — its current health, routes, and connections.`;

      // Open panel and start a fresh thread — send fires once activeThread settles
      setOpen(true);
      const freshThread = createThread([]);
      pendingInvestigationRef.current = msg;
      setThreads((prev) => [freshThread, ...prev].slice(0, MAX_CHAT_THREADS));
      setActiveThreadId(freshThread.id);
    };
    window.addEventListener("fere:investigate-node", handler);
    return () => window.removeEventListener("fere:investigate-node", handler);
  }, []);


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

  const toggleDetection = useCallback(() => {
    setDetectionEnabled((v) => !v);
  }, []);

  const toggleAutopilot = useCallback(() => {
    setAutopilotEnabled((v) => !v);
  }, []);

  const appendFindingToFeed = useCallback(
    (finding: AgentFinding) => {
      const item: FeedFinding = {
        kind: "finding",
        id: finding.id,
        service: finding.service,
        summary: finding.summary,
        severity: finding.severity,
        fix: finding.fix,
        stage: "detected",
        insertedAt: Date.now(),
      };
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.id === activeThreadId);
        if (idx === -1) return prev;
        const current = prev[idx];
        // Don't duplicate
        if (current.feed.some((f) => f.kind === "finding" && f.id === finding.id)) return prev;
        const updated: ChatThread = {
          ...current,
          feed: [...current.feed, item],
          updatedAt: Date.now(),
        };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)].slice(0, MAX_CHAT_THREADS);
      });
    },
    [activeThreadId],
  );

  // Feature: health degradation → surface alert + fetch logs for containers
  useEffect(() => {
    const handler = async (e: Event) => {
      const { node } = (e as CustomEvent<{ node: GraphNode }>).detail ?? {};
      if (!node) return;

      const incidentId = `health-${node.id}`;
      let logExcerpt = "";

      if (node.isDockerContainer && node.containerId) {
        try {
          const result = await window.electronAPI.getContainerLogTail(node.containerId, 20);
          if (result.success && result.logs) {
            const lines = result.logs.split("\n").filter(Boolean).slice(-10);
            logExcerpt = lines.join("\n");
          }
        } catch { /* non-critical */ }
      }

      const portStr = (node.ports ?? []).map((p) => p.port).join(", ");
      const detail = logExcerpt
        ? `**${node.name}** went red${portStr ? ` (port ${portStr})` : ""}.\n\nLast logs:\n\`\`\`\n${logExcerpt}\n\`\`\``
        : `**${node.name}** health dropped to red${portStr ? ` (port ${portStr})` : ""}. No container logs available.`;

      appendFindingToFeed({
        id: incidentId,
        severity: "critical",
        category: "health",
        service: node.name,
        summary: `${node.name} went red`,
        detail,
        impact: null,
        affectedServices: [],
        fix: null,
      });
      setUnreadFindings((n) => n + 1);
    };

    window.addEventListener("fere:health-degraded", handler as EventListener);
    return () => window.removeEventListener("fere:health-degraded", handler as EventListener);
  }, [appendFindingToFeed]);

  const updateFindingInFeed = useCallback(
    (id: string, stage: IncidentStage, error?: string) => {
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.id === activeThreadId);
        if (idx === -1) return prev;
        const current = prev[idx];
        const newFeed = current.feed.map((item) => {
          if (item.kind === "finding" && item.id === id) {
            return { ...item, stage, ...(error !== undefined ? { error } : {}) };
          }
          return item;
        });
        if (newFeed === current.feed) return prev;
        const updated: ChatThread = { ...current, feed: newFeed, updatedAt: Date.now() };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)].slice(0, MAX_CHAT_THREADS);
      });
    },
    [activeThreadId],
  );

  const toSafeAction = useCallback((fix: AgentFixAction | null) => {
    if (!fix) return null;
    if (fix.type === "restart-container" && typeof fix.containerId === "string") {
      return { type: "restart-container" as const, containerId: fix.containerId };
    }
    if (fix.type === "kill-port" && Number.isInteger(fix.port) && Number.isInteger(fix.pid)) {
      return { type: "kill-port" as const, port: fix.port!, pid: fix.pid! };
    }
    return null;
  }, []);

  const isSafeFixProposal = useCallback(
    (fix: FixProposal & { status: string }) => {
      if (
        fix.fix_type === "restart-container" &&
        typeof fix.container_id === "string"
      )
        return true;
      if (
        fix.fix_type === "kill-port" &&
        Number.isInteger(fix.port) &&
        Number.isInteger(fix.pid)
      )
        return true;
      return false;
    },
    [],
  );

  const verifyAutopilotFix = useCallback(
    async (
      finding: AgentFinding,
    ): Promise<{ verified: boolean; reason?: string }> => {
      const scan = await window.electronAPI.agentScan(nodeIdsForScan);
      if (!scan.success)
        return { verified: false, reason: scan.error ?? "verify scan failed" };
      const current = scan.findings.filter(
        (f) => f.severity === "critical" || f.severity === "warning",
      );
      const stillFailing = current.some(
        (f) =>
          f.id === finding.id ||
          f.service === finding.service ||
          (Array.isArray(f.affectedServices) &&
            f.affectedServices.includes(finding.service)),
      );
      return stillFailing
        ? {
            verified: false,
            reason: "service/dependency still unhealthy after fix",
          }
        : { verified: true };
    },
    [nodeIdsForScan],
  );

  const runAutopilotForFindings = useCallback(
    async (findings: AgentFinding[]) => {
      for (const finding of findings) {
        const safeAction = toSafeAction(finding.fix);
        if (!safeAction) {
          updateFindingInFeed(finding.id, "escalated", "no safe autopilot action available");
          continue;
        }
        if (autopilotInFlightRef.current.has(finding.id)) continue;

        autopilotInFlightRef.current.add(finding.id);
        updateFindingInFeed(finding.id, "fixing");

        try {
          const result = await window.electronAPI.agentApplyFix(safeAction);
          if (!result.success) {
            updateFindingInFeed(finding.id, "escalated", result.error ?? "autopilot apply failed");
            continue;
          }

          updateFindingInFeed(finding.id, "fixed");
          await new Promise((resolve) => setTimeout(resolve, 1600));
          const verify = await verifyAutopilotFix(finding);
          if (verify.verified) {
            updateFindingInFeed(finding.id, "verified");
          } else {
            updateFindingInFeed(finding.id, "escalated", verify.reason);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          updateFindingInFeed(finding.id, "escalated", msg);
        } finally {
          autopilotInFlightRef.current.delete(finding.id);
        }
      }
    },
    [toSafeAction, updateFindingInFeed, verifyAutopilotFix],
  );

  const surfaceFindings = useCallback(
    (findings: AgentFinding[]) => {
      if (findings.length === 0) return;

      const normalizedTab = (tabLabel ?? "").trim().toLowerCase();
      const inScope = findings.filter((f) => {
        const serviceName = f.service.toLowerCase();
        if (nodeMap.has(serviceName)) return true;
        if (!normalizedTab) return true;
        return f.affectedServices?.some((svc) => {
          const name = svc.toLowerCase();
          return nodeMap.has(name) || (normalizedTab && name.includes(normalizedTab));
        });
      });
      if (inScope.length === 0) return;

      const existing = surfacedByTabRef.current.get(tabScopeKey) ?? new Set<string>();
      const unseen = inScope.filter((f) => !existing.has(f.id));
      if (unseen.length === 0) return;

      unseen.forEach((f) => existing.add(f.id));
      surfacedByTabRef.current.set(tabScopeKey, existing);
      unseen.forEach((f) => updateFindingInFeed(f.id, "detected"));

      // Push finding cards to feed
      unseen.forEach((f) => appendFindingToFeed(f));

      if (autopilotEnabled) {
        void runAutopilotForFindings(unseen);
        return;
      }

      // Increment unread badge if panel is closed
      if (!open) {
        setUnreadFindings((n) => n + unseen.filter((f) => f.severity === "critical").length);
      }
    },
    [
      appendFindingToFeed,
      autopilotEnabled,
      nodeMap,
      open,
      runAutopilotForFindings,
      tabScopeKey,
      tabLabel,
      updateFindingInFeed,
    ],
  );

  // Subscribe to proactive findings from background scan
  useEffect(() => {
    if (!detectionEnabled) return;
    window.electronAPI.onProactiveFinding((findings: AgentFinding[]) => {
      surfaceFindings(findings);
    });
    return () => window.electronAPI.offProactiveFinding();
  }, [detectionEnabled, surfaceFindings]);

  // Subscribe to resolved findings — transition to "verified" and clear from surfaced set
  useEffect(() => {
    if (!detectionEnabled) return;
    window.electronAPI.onFindingResolved((ids: string[]) => {
      ids.forEach((id) => updateFindingInFeed(id, "verified"));
      const existing = surfacedByTabRef.current.get(tabScopeKey);
      if (existing) ids.forEach((id) => existing.delete(id));
    });
    return () => window.electronAPI.offFindingResolved();
  }, [detectionEnabled, tabScopeKey, updateFindingInFeed]);

  // Subscribe to worsened findings
  useEffect(() => {
    if (!detectionEnabled) return;
    window.electronAPI.onFindingWorsened((findings: AgentFinding[]) => {
      findings.forEach((f) => updateFindingInFeed(f.id, "detected"));
      const criticals = findings.filter((f) => f.severity === "critical");
      if (criticals.length > 0) setUnreadFindings((n) => n + criticals.length);
    });
    return () => window.electronAPI.offFindingWorsened();
  }, [detectionEnabled, updateFindingInFeed]);

  const dismissFinding = useCallback(
    (id: string) => {
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.id === activeThreadId);
        if (idx === -1) return prev;
        const current = prev[idx];
        const updated = { ...current, feed: current.feed.filter((item) => !(item.kind === "finding" && item.id === id)) };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)].slice(0, MAX_CHAT_THREADS);
      });
      const existing = surfacedByTabRef.current.get(tabScopeKey);
      if (existing) existing.delete(id);
    },
    [activeThreadId, tabScopeKey],
  );

  const dismissAllFindings = useCallback(() => {
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.id === activeThreadId);
      if (idx === -1) return prev;
      const current = prev[idx];
      const updated = { ...current, feed: current.feed.filter((item) => item.kind !== "finding") };
      return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)].slice(0, MAX_CHAT_THREADS);
    });
    surfacedByTabRef.current.delete(tabScopeKey);
  }, [activeThreadId, tabScopeKey]);

  const exportFindings = useCallback(() => {
    const data = feed.filter((item): item is FeedFinding => item.kind === "finding");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sentinel-findings-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [feed]);

  // On tab switch, run a fresh scoped scan so findings surface per project tab.
  useEffect(() => {
    if (!detectionEnabled) return;
    let cancelled = false;
    const runScopedRefresh = async () => {
      try {
        const result = await window.electronAPI.agentScan(nodeIdsForScan);
        if (cancelled || !result.success) return;
        const scopedFindings = result.findings.filter(
          (f) => f.severity === "critical" || f.severity === "warning",
        );
        surfaceFindings(scopedFindings);
      } catch {
        // ignore refresh errors; live proactive stream still runs
      }
    };
    void runScopedRefresh();
    return () => {
      cancelled = true;
    };
  }, [
    detectionEnabled,
    nodeIdsForScan,
    nodeIdsScopeSignature,
    surfaceFindings,
    tabScopeKey,
  ]);

  // Clear unread badge when panel opens
  useEffect(() => {
    if (open) setUnreadFindings(0);
  }, [open]);

  const applyFix = useCallback(
    async (fix: FixProposal & { status: string }) => {
      setPendingFixes((prev) =>
        prev.map((f) => (f.id === fix.id ? { ...f, status: "applying" } : f)),
      );
      try {
        if (fix.fix_type === "restart-container" && fix.container_id) {
          await window.electronAPI.agentApplyFix({
            type: "restart-container",
            containerId: fix.container_id,
          });
        } else if (fix.fix_type === "kill-port" && fix.port != null) {
          await window.electronAPI.agentApplyFix(
            Number.isInteger(fix.pid)
              ? { type: "kill-port", port: fix.port, pid: fix.pid }
              : { type: "kill-port", port: fix.port },
          );
        } else if (
          fix.fix_type === "launch-in-terminal" &&
          fix.command &&
          fix.cwd
        ) {
          const chatMessages = feed
            .filter((item): item is FeedMessage => item.kind === "message")
            .map(({ role, content }) => ({ role, content }));
          await window.electronAPI.agentChat(
            [
              ...chatMessages,
              {
                role: "user",
                content: `Execute this now using launch_in_terminal: ${fix.command} in ${fix.cwd}`,
              },
            ],
            nodeIdsForScan,
            tabLabel ?? null,
            { autopilotEnabled },
          );
        }
        setPendingFixes((prev) =>
          prev.map((f) => (f.id === fix.id ? { ...f, status: "done" } : f)),
        );
      } catch (err) {
        setPendingFixes((prev) =>
          prev.map((f) =>
            f.id === fix.id
              ? { ...f, status: "error", errorMsg: String(err) }
              : f,
          ),
        );
      }
    },
    [autopilotEnabled, feed, nodeIdsForScan, tabLabel],
  );

  useEffect(() => {
    if (!autopilotEnabled) return;
    const next = pendingFixes.find(
      (f) => f.status === "pending" && isSafeFixProposal(f),
    );
    if (!next) return;
    void applyFix(next);
  }, [autopilotEnabled, applyFix, isSafeFixProposal, pendingFixes]);

  const startNewConversation = useCallback(() => {
    const next = createThread([]);
    setThreads((prev) => [next, ...prev].slice(0, MAX_CHAT_THREADS));
    setActiveThreadId(next.id);
    setInput("");
    setError(null);
    setHistoryOpen(false);
  }, []);

  const deleteThread = useCallback(
    (e: React.MouseEvent, threadId: string) => {
      e.stopPropagation();
      setThreads((prev) => {
        const next = prev.filter((t) => t.id !== threadId);
        // If we deleted the active thread, switch to the first remaining one (or create new)
        if (threadId === activeThreadId) {
          const fallback = next[0] ?? createThread([]);
          if (!next[0]) {
            setActiveThreadId(fallback.id);
            return [fallback];
          }
          setActiveThreadId(fallback.id);
        }
        return next;
      });
      setError(null);
    },
    [activeThreadId],
  );

  const applyFindingFix = useCallback(
    (findingId: string) => {
      const finding = feed.find(
        (item): item is FeedFinding => item.kind === "finding" && item.id === findingId,
      );
      if (!finding) return;
      const safeAction = toSafeAction(finding.fix);
      if (!safeAction) return;

      updateFindingInFeed(findingId, "fixing");
      void window.electronAPI.agentApplyFix(safeAction).then((result) => {
        if (!result.success) {
          updateFindingInFeed(findingId, "escalated", result.error ?? "apply failed");
          return;
        }
        updateFindingInFeed(findingId, "fixed");
        setTimeout(() => {
          void window.electronAPI.agentScan(nodeIdsForScan).then((scan) => {
            if (!scan.success) {
              updateFindingInFeed(findingId, "escalated", "verify scan failed");
              return;
            }
            const stillFailing = scan.findings.some(
              (f) => f.id === findingId || f.service === finding.service,
            );
            updateFindingInFeed(
              findingId,
              stillFailing ? "escalated" : "verified",
              stillFailing ? "issue persists after fix" : undefined,
            );
          });
        }, 1600);
      });
    },
    [feed, nodeIdsForScan, toSafeAction, updateFindingInFeed],
  );

  const explainFinding = useCallback(
    (finding: FeedFinding) => {
      const isUnhealthy = finding.severity === "critical" || finding.severity === "warning";
      const msg = isUnhealthy
        ? `Investigate **${finding.service}**: ${finding.summary}. What's causing this and how do I fix it?`
        : `Tell me about **${finding.service}**: ${finding.summary}.`;
      void send(msg);
    },
    [send],
  );

  return (
    <>
      <button
        className={`agp-trigger-logo-btn${open ? " agp-trigger-btn-active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Ask Sentinel"
      >
        <img src={sentinelLogo} alt="Sentinel" className="agp-trigger-logo" />
        {unreadFindings > 0 && !open && (
          <span className="agp-trigger-badge agp-findings-badge">
            {unreadFindings}
          </span>
        )}
      </button>

      {open && (
        <div className="agp-popup">
          {/* Header */}
          <div className="agp-header">
            <div className="agp-header-left">
              <img
                src={sentinelLogo}
                alt="Sentinel"
                className="agp-avatar-logo"
              />
              <div className="agp-header-text">
                <span className="agp-header-title">Sentinel</span>
                <span className="agp-header-sub">{headerSub}</span>
              </div>
            </div>
            <div className="agp-header-right">
              <button
                className={`agp-detect-btn${detectionEnabled ? " agp-detect-btn-active" : ""}`}
                onClick={toggleDetection}
                title={
                  detectionEnabled
                    ? "Stop detecting problems"
                    : "Start detecting problems"
                }
                disabled={isStreaming}
              >
                <span
                  className={`agp-detect-dot${detectionEnabled ? " agp-detect-dot-active" : ""}`}
                />
                <span>{detectionEnabled ? "Detecting" : "Detect"}</span>
              </button>
              <button
                className={`agp-autopilot-btn${autopilotEnabled ? " agp-autopilot-btn-active" : ""}`}
                onClick={toggleAutopilot}
                title={
                  autopilotEnabled ? "Disable autopilot" : "Enable autopilot"
                }
                disabled={isStreaming}
              >
                <span
                  className={`agp-autopilot-dot${autopilotEnabled ? " agp-autopilot-dot-active" : ""}`}
                />
                <span>
                  {autopilotEnabled ? "Autopilot On" : "Autopilot Off"}
                </span>
                {activeIncidentCount > 0 && (
                  <span className="agp-autopilot-count">
                    {activeIncidentCount}
                  </span>
                )}
              </button>
              {threads.length > 0 && (
                <button
                  className={`agp-scan-btn agp-history-btn agp-header-utility${historyOpen ? " agp-scan-btn-active" : ""}`}
                  onClick={() => { setHistoryOpen((v) => !v); }}
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
                  className="agp-scan-btn agp-new-chat-btn agp-header-utility"
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
              <button className="agp-close agp-header-utility agp-close-top" onClick={() => setOpen(false)}>
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
                  <div
                    key={thread.id}
                    className={`agp-history-item${thread.id === activeThreadId ? " agp-history-item-active" : ""}`}
                    onClick={() => {
                      setActiveThreadId(thread.id);
                      setHistoryOpen(false);
                      setError(null);
                    }}
                  >
                    <div className="agp-history-item-content">
                      <span className="agp-history-title">{thread.title}</span>
                      <span className="agp-history-meta">
                        {thread.feed.filter(item => item.kind === "message").length} msg ·{" "}
                        {formatThreadTimestamp(thread.updatedAt)}
                      </span>
                    </div>
                    <button
                      className="agp-history-delete"
                      onClick={(e) => deleteThread(e, thread.id)}
                      title="Delete chat"
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 11 11"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      >
                        <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Chat body */}
          <div className="agp-chat-body">
            {feed.length === 0 && !showStream ? (
              /* Welcome / starter screen */
              <div className="agp-welcome">
                <img
                  src={sentinelLogo}
                  alt="Sentinel"
                  className="agp-welcome-logo"
                />
                <p className="agp-welcome-title">
                  Ask about your running stack
                </p>
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
              /* Unified feed */
              <div className="agp-messages">
                {feed.map((item, i) => {
                  if (item.kind === "finding") {
                    return (
                      <FindingCard
                        key={item.id}
                        item={item}
                        onFix={applyFindingFix}
                        onExplain={explainFinding}
                        onDismiss={dismissFinding}
                        isStreaming={isStreaming}
                      />
                    );
                  }
                  return (
                    <div key={i} className={`agp-msg agp-msg-${item.role}`}>
                      <div className="agp-msg-bubble">
                        {item.role === "assistant" ? (
                          <ReactMarkdown
                            className="agp-markdown"
                            rehypePlugins={[rehypeHighlight]}
                            components={mdComponents}
                          >
                            {item.content}
                          </ReactMarkdown>
                        ) : (
                          item.content
                        )}
                      </div>
                    </div>
                  );
                })}

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
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M1 3.5C1 2.95 1.45 2.5 2 2.5h2.5l1 1H10c.55 0 1 .45 1 1v4.5c0 .55-.45 1-1 1H2c-.55 0-1-.45-1-1V3.5z" />
                                  </svg>
                                ) : step.type === "run_command" ? (
                                  // Terminal prompt
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <rect
                                      x="1"
                                      y="1.5"
                                      width="10"
                                      height="9"
                                      rx="1.5"
                                    />
                                    <path d="M3.5 4.5l2 2-2 2" />
                                    <path d="M7.5 8.5h1" />
                                  </svg>
                                ) : step.type === "get_node_details" ? (
                                  // Service details lookup (neutral search icon)
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <circle cx="5" cy="5" r="2.5" />
                                    <path d="M7 7l2.5 2.5" />
                                  </svg>
                                ) : step.type === "docker_logs" ||
                                  step.type === "docker_exec" ||
                                  step.type === "docker_control" ? (
                                  // Docker container box
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <rect
                                      x="1.5"
                                      y="3"
                                      width="9"
                                      height="7"
                                      rx="1"
                                    />
                                    <path d="M4 3V2M8 3V2" />
                                    <path d="M4 6.5h4M4 8.5h2" />
                                  </svg>
                                ) : (
                                  // File (read_file)
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 12 12"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M2 1.5h5.5L10 4v7H2V1.5z" />
                                    <path d="M7.5 1.5V4H10" />
                                    <path d="M4 6.5h4M4 8.5h2.5" />
                                  </svg>
                                )}
                              </span>
                              <span className="agp-step-label">
                                {step.label}
                              </span>
                              {!step.done && (
                                <span className="agp-step-spinner" />
                              )}
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

          {/* Fix buttons proposed by agent */}
          {pendingFixes.length > 0 && (
            <div className="agp-fix-panel">
              {pendingFixes.map((fix) => (
                <div
                  key={fix.id}
                  className={`agp-fix-item agp-fix-${fix.status}`}
                >
                  <div className="agp-fix-desc">{fix.description}</div>
                  {fix.status === "pending" && (
                    <button
                      className="agp-fix-btn"
                      onClick={() => void applyFix(fix)}
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2 6l3 3 5-5" />
                      </svg>
                      {fix.label}
                    </button>
                  )}
                  {fix.status === "applying" && (
                    <span className="agp-fix-applying">
                      <span className="agp-step-spinner" /> Applying…
                    </span>
                  )}
                  {fix.status === "done" && (
                    <span className="agp-fix-done">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2 6l3 3 5-5" />
                      </svg>
                      Applied
                    </span>
                  )}
                  {fix.status === "error" && (
                    <span className="agp-fix-error" title={fix.errorMsg}>
                      Failed
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

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
