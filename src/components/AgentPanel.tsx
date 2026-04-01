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

type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

type IncidentStage = "detected" | "fixing" | "fixed" | "verified" | "escalated";

type IncidentRecord = {
  id: string;
  service: string;
  summary: string;
  stage: IncidentStage;
  updatedAt: number;
  error?: string;
};

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

function deriveThreadTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find(
    (msg) => msg.role === "user" && msg.content.trim().length > 0,
  );
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
      ((m as ChatMessage).role === "user" ||
        (m as ChatMessage).role === "assistant") &&
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
      id:
        typeof maybe.id === "string" && maybe.id.trim()
          ? maybe.id
          : createThreadId(),
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
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [incidentState, setIncidentState] = useState<
    Record<string, IncidentRecord>
  >({});

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
  const messages = activeThread?.messages ?? [];

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
      Object.values(incidentState).filter(
        (i) =>
          i.stage === "detected" || i.stage === "fixing" || i.stage === "fixed",
      ).length,
    [incidentState],
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

      try {
        const result = await window.electronAPI.agentChat(
          updatedMessages,
          nodeIdsForScan,
          tabLabel ?? null,
          { autopilotEnabled },
        );
        window.electronAPI.offChatToken();
        window.electronAPI.offChatStep();
        window.electronAPI.offFixProposal();
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

  // Feature: health degradation → surface alert + fetch logs for containers
  useEffect(() => {
    const handler = async (e: Event) => {
      const { node } = (e as CustomEvent<{ node: GraphNode }>).detail ?? {};
      if (!node) return;

      const incidentId = `health-${node.id}`;
      let logExcerpt = "";

      // Fetch last 20 log lines for Docker containers
      if (node.isDockerContainer && node.containerId) {
        try {
          const result = await window.electronAPI.getContainerLogTail(node.containerId, 20);
          if (result.success && result.logs) {
            // Extract last meaningful lines, skip empty
            const lines = result.logs.split("\n").filter(Boolean).slice(-10);
            logExcerpt = lines.join("\n");
          }
        } catch {
          // non-critical, skip
        }
      }

      const portStr = (node.ports ?? []).map(p => p.port).join(", ");
      const detail = logExcerpt
        ? `**${node.name}** went red${portStr ? ` (port ${portStr})` : ""}.\n\nLast logs:\n\`\`\`\n${logExcerpt}\n\`\`\``
        : `**${node.name}** health dropped to red${portStr ? ` (port ${portStr})` : ""}. No container logs available.`;

      setIncidentState((prev) => ({
        ...prev,
        [incidentId]: {
          id: incidentId,
          service: node.name,
          summary: `${node.name} went red`,
          stage: "detected",
          updatedAt: Date.now(),
          error: detail,
        },
      }));
      setUnreadFindings((n) => n + 1);
    };

    window.addEventListener("fere:health-degraded", handler as EventListener);
    return () => window.removeEventListener("fere:health-degraded", handler as EventListener);
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

  const appendAutoMessage = useCallback(
    (content: string) => {
      const autoMsg: ChatMessage = { role: "user", content };
      setThreads((prev) => {
        const idx = prev.findIndex((thread) => thread.id === activeThreadId);
        if (idx === -1) return prev;
        const current = prev[idx];
        const nextMessages = [...current.messages, autoMsg];
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

  const updateIncidentStage = useCallback(
    (finding: AgentFinding, stage: IncidentStage, error?: string) => {
      setIncidentState((prev) => ({
        ...prev,
        [finding.id]: {
          id: finding.id,
          service: finding.service,
          summary: finding.summary,
          stage,
          updatedAt: Date.now(),
          ...(error ? { error } : {}),
        },
      }));
    },
    [],
  );

  const toSafeAction = useCallback((finding: AgentFinding) => {
    const fix = finding.fix;
    if (!fix) return null;
    if (
      fix.type === "restart-container" &&
      typeof fix.containerId === "string"
    ) {
      return {
        type: "restart-container" as const,
        containerId: fix.containerId,
      };
    }
    if (
      fix.type === "kill-port" &&
      Number.isInteger(fix.port) &&
      Number.isInteger(fix.pid)
    ) {
      return { type: "kill-port" as const, port: fix.port, pid: fix.pid };
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
        const safeAction = toSafeAction(finding);
        if (!safeAction) {
          updateIncidentStage(
            finding,
            "escalated",
            "no safe autopilot action available",
          );
          appendAutoMessage(
            `[auto-escalation] Detected issue for **${finding.service}** requires manual confirmation.`,
          );
          continue;
        }
        if (autopilotInFlightRef.current.has(finding.id)) continue;

        autopilotInFlightRef.current.add(finding.id);
        updateIncidentStage(finding, "fixing");
        appendAutoMessage(
          `[auto-autopilot] Autopilot applying safe fix for **${finding.service}** — ${finding.summary}.`,
        );

        try {
          const result = await window.electronAPI.agentApplyFix(safeAction);
          if (!result.success) {
            updateIncidentStage(
              finding,
              "escalated",
              result.error ?? "autopilot apply failed",
            );
            appendAutoMessage(
              `[auto-escalation] Autopilot could not apply fix for **${finding.service}**. Manual action required.`,
            );
            continue;
          }

          updateIncidentStage(finding, "fixed");
          await new Promise((resolve) => setTimeout(resolve, 1600));
          const verify = await verifyAutopilotFix(finding);
          if (verify.verified) {
            updateIncidentStage(finding, "verified");
            appendAutoMessage(
              `[auto-verified] Autopilot fixed and verified **${finding.service}**.`,
            );
          } else {
            updateIncidentStage(finding, "escalated", verify.reason);
            appendAutoMessage(
              `[auto-escalation] Autopilot applied a fix for **${finding.service}**, but verification failed (${verify.reason}). Manual follow-up needed.`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          updateIncidentStage(finding, "escalated", msg);
          appendAutoMessage(
            `[auto-escalation] Autopilot encountered an error for **${finding.service}**: ${msg}`,
          );
        } finally {
          autopilotInFlightRef.current.delete(finding.id);
        }
      }
    },
    [appendAutoMessage, toSafeAction, updateIncidentStage, verifyAutopilotFix],
  );

  const surfaceFindings = useCallback(
    (findings: AgentFinding[]) => {
      if (findings.length === 0) return;

      const normalizedTab = (tabLabel ?? "").trim().toLowerCase();
      const inScope = findings.filter((f) => {
        const serviceName = f.service.toLowerCase();
        if (nodeMap.has(serviceName)) return true;

        // System tab: allow findings even when a service dropped out of graph
        // (for example, just-stopped containers).
        if (!tabLabel) return true;

        // Project tabs: keep findings scoped by tab label fallback when the
        // service is no longer present in the current node map.
        if (normalizedTab && serviceName.includes(normalizedTab)) return true;

        if (
          Array.isArray(f.affectedServices) &&
          f.affectedServices.some((svc) => {
            const name = svc.toLowerCase();
            return (
              nodeMap.has(name) || (normalizedTab && name.includes(normalizedTab))
            );
          })
        ) {
          return true;
        }

        return false;
      });
      if (inScope.length === 0) return;

      const existing =
        surfacedByTabRef.current.get(tabScopeKey) ?? new Set<string>();
      const unseen = inScope.filter((f) => !existing.has(f.id));
      if (unseen.length === 0) return;

      unseen.forEach((f) => existing.add(f.id));
      surfacedByTabRef.current.set(tabScopeKey, existing);
      unseen.forEach((f) => updateIncidentStage(f, "detected"));

      if (autopilotEnabled) {
        void runAutopilotForFindings(unseen);
        return;
      }

      if (open && !isStreaming) {
        const top = unseen[0];
        void send(
          `[auto-diagnosis] A new issue was detected: **${top.service}** — ${top.summary}. Please diagnose and propose a fix.`,
        );
      } else {
        setUnreadFindings(
          (n) => n + unseen.filter((f) => f.severity === "critical").length,
        );
      }
    },
    [
      autopilotEnabled,
      isStreaming,
      nodeMap,
      open,
      runAutopilotForFindings,
      send,
      tabScopeKey,
      updateIncidentStage,
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
      setIncidentState((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          if (next[id] && next[id].stage !== "verified") {
            next[id] = { ...next[id], stage: "verified", updatedAt: Date.now() };
          }
        }
        return next;
      });
      // Allow resolved findings to resurface if they return
      const existing = surfacedByTabRef.current.get(tabScopeKey);
      if (existing) ids.forEach((id) => existing.delete(id));
    });
    return () => window.electronAPI.offFindingResolved();
  }, [detectionEnabled, tabScopeKey]);

  // Subscribe to worsened findings — bump severity in incidentState
  useEffect(() => {
    if (!detectionEnabled) return;
    window.electronAPI.onFindingWorsened((findings: AgentFinding[]) => {
      setIncidentState((prev) => {
        const next = { ...prev };
        for (const f of findings) {
          if (next[f.id]) {
            next[f.id] = { ...next[f.id], stage: "detected", updatedAt: Date.now() };
          }
        }
        return next;
      });
      const criticals = findings.filter((f) => f.severity === "critical");
      if (criticals.length > 0) setUnreadFindings((n) => n + criticals.length);
    });
    return () => window.electronAPI.offFindingWorsened();
  }, [detectionEnabled]);

  // After a verify turn completes, scan and auto-resolve incidents that are gone
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  useEffect(() => {
    if (isStreaming) return;
    const last = messages[messages.length - 1];
    const secondLast = messages[messages.length - 2];
    if (
      !secondLast ||
      secondLast.role !== "user" ||
      (!secondLast.content.startsWith("[auto-verifying]") &&
        !secondLast.content.startsWith("[auto-verify]"))
    ) return;
    if (!last || last.role !== "assistant") return;
    // Run a scan to clear incidents that are no longer present
    let cancelled = false;
    window.electronAPI.agentScan(nodeIdsForScan).then((result) => {
      if (cancelled || !result.success) return;
      const currentIds = new Set(result.findings.map((f) => f.id));
      setIncidentState((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const [id, inc] of Object.entries(next)) {
          if (
            (inc.stage === "fixed" || inc.stage === "detected") &&
            !currentIds.has(id)
          ) {
            next[id] = { ...inc, stage: "verified", updatedAt: Date.now() };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  const dismissFinding = useCallback((id: string) => {
    setIncidentState((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const existing = surfacedByTabRef.current.get(tabScopeKey);
    if (existing) existing.delete(id);
  }, [tabScopeKey]);

  const dismissAllFindings = useCallback(() => {
    setIncidentState({});
    surfacedByTabRef.current.delete(tabScopeKey);
  }, [tabScopeKey]);

  const exportFindings = useCallback(() => {
    const data = Object.values(incidentState);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sentinel-findings-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [incidentState]);

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
          await window.electronAPI.agentChat(
            [
              ...messages,
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
        if (autopilotEnabled) {
          // Keep autopilot deterministic: verify with a scan instead of waiting
          // on an extra LLM verification turn.
          const verifyResult = await window.electronAPI.agentScan(nodeIdsForScan);
          if (!verifyResult.success) {
            appendAutoMessage(
              `[auto-escalation] Autopilot applied a fix, but verification scan failed (${verifyResult.error ?? "scan failed"}).`,
            );
          } else {
            const activeIssues = verifyResult.findings.filter(
              (f) => f.severity === "critical" || f.severity === "warning",
            ).length;
            appendAutoMessage(
              `[auto-verified] Autopilot applied and verified fix: "${fix.description}". Active issues remaining: ${activeIssues}.`,
            );
          }
        } else {
          // Trigger verification turn
          setTimeout(() => {
            void send(
              `[auto-verifying] The fix was applied: "${fix.description}". Please verify using your tools that the issue is resolved and confirm the service is healthy.`,
            );
          }, 1500);
        }
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
    [autopilotEnabled, messages, nodeIdsForScan, tabLabel, send],
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
              {Object.keys(incidentState).length > 0 && (
                <button
                  className={`agp-scan-btn agp-findings-btn${findingsOpen ? " agp-scan-btn-active" : ""}`}
                  onClick={() => { setFindingsOpen((v) => !v); setHistoryOpen(false); }}
                  title="Active findings"
                  disabled={isStreaming}
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6.5 1.5l5 9H1.5l5-9z" />
                    <path d="M6.5 5v2.5M6.5 9.2h.01" />
                  </svg>
                  <span style={{ marginLeft: 3 }}>{Object.keys(incidentState).length}</span>
                </button>
              )}
              {threads.length > 0 && (
                <button
                  className={`agp-scan-btn agp-history-btn agp-header-utility${historyOpen ? " agp-scan-btn-active" : ""}`}
                  onClick={() => { setHistoryOpen((v) => !v); setFindingsOpen(false); }}
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
                        {thread.messages.length} msg ·{" "}
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

          {findingsOpen && (
            <div className="agp-history-panel">
              <div className="agp-findings-toolbar">
                <span className="agp-findings-toolbar-title">
                  {Object.keys(incidentState).length} finding{Object.keys(incidentState).length !== 1 ? "s" : ""}
                </span>
                <div className="agp-findings-toolbar-actions">
                  <button className="agp-findings-action-btn" onClick={exportFindings} title="Export as JSON">
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 1v7M3.5 5.5L6 8l2.5-2.5" />
                      <path d="M2 10h8" />
                    </svg>
                    Export
                  </button>
                  <button className="agp-findings-action-btn agp-findings-dismiss-all" onClick={dismissAllFindings} title="Dismiss all">
                    Clear all
                  </button>
                </div>
              </div>
              {Object.values(incidentState)
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((inc) => (
                  <div key={inc.id} className={`agp-history-item agp-finding-item agp-finding-stage-${inc.stage}`}>
                    <div className="agp-history-item-content">
                      <span className="agp-history-title">{inc.service}: {inc.summary}</span>
                      <span className="agp-history-meta agp-finding-stage-label">
                        {inc.stage}{inc.error ? ` — ${inc.error}` : ""}
                      </span>
                    </div>
                    <button
                      className="agp-history-delete"
                      onClick={() => dismissFinding(inc.id)}
                      title="Dismiss"
                    >
                      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" />
                      </svg>
                    </button>
                  </div>
                ))}
            </div>
          )}

          {/* Chat body */}
          <div className="agp-chat-body">
            {messages.length === 0 && !showStream ? (
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
              /* Message list */
              <div className="agp-messages">
                {messages.map((msg, i) => {
                  const isAuto =
                    msg.role === "user" && msg.content.startsWith("[auto-");
                  if (isAuto) {
                    const isVerifying =
                      msg.content.startsWith("[auto-verifying]") ||
                      msg.content.startsWith("[auto-verify]");
                    const isVerified = msg.content.startsWith("[auto-verified]");
                    const isAutopilot =
                      msg.content.startsWith("[auto-autopilot]");
                    const isEscalation =
                      msg.content.startsWith("[auto-escalation]");
                    const label = isVerified
                      ? "Fix verified"
                      : isVerifying
                      ? "Fix applied · verifying…"
                      : isAutopilot
                        ? "Autopilot applying safe fix…"
                        : isEscalation
                          ? "Escalation · manual follow-up needed"
                          : "Issue detected · diagnosing…";
                    return (
                      <div key={i} className="agp-auto-trigger">
                        <span className="agp-step-icon" aria-hidden="true">
                          {isEscalation ? (
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
                              <path d="M6 1.5l4.5 8H1.5L6 1.5z" />
                              <path d="M6 4.2v2.6M6 8.4h.01" />
                            </svg>
                          ) : isVerified ? (
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
                              <path d="M2.2 6.3l2.3 2.3 5-5" />
                            </svg>
                          ) : isVerifying ? (
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
                          ) : (
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
                          )}
                        </span>
                        <span className="agp-step-label">{label}</span>
                        {(isAutopilot || isVerifying || (!isEscalation && !isVerified && !isAutopilot)) && (
                          <span className="agp-step-spinner" />
                        )}
                      </div>
                    );
                  }
                  return (
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
