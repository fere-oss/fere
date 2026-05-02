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
  AuthSession,
  ChatStep,
  ExternalApiProvider,
  FixProposal,
  GraphEdge,
  GraphNode,
} from "../types/electron";
import { getServiceColor } from "./graph/constants";
import { ApiKeySetup } from "./ApiKeySetup";
import sentinelLogo from "../assets/sentinel.png";
import { AuthAvatar } from "./agent/AuthAvatar";
import { StepIcon } from "./agent/StepIcon";
import { MentionDropdown } from "./agent/MentionDropdown";
import {
  renderMirrorContent,
  renderMentions,
  CopyButton,
  ContextBlock,
  extractText,
  renderProviderMentionsInChildren,
} from "./agent/ChatMessage";
import { FindingCard } from "./agent/FindingCard";
import { buildProviderDomainMap, getLogoUrl } from "./agent/providerLogos";
import { ProviderMention } from "./agent/ProviderMention";
import {
  loadPersistedChatState,
  createThread,
  createThreadId,
  deriveThreadTitle,
  sanitizeFeed,
  sanitizeThreads,
  CHAT_STORAGE_KEY,
  MAX_CHAT_THREADS,
} from "./agent/chatPersistence";
import type {
  FeedMessage,
  FeedContext,
  FeedFinding,
  FeedItem,
  IncidentStage,
  ChatThread,
  PersistedChatState,
  ContextSnapshot,
  ContextService,
  ContextConnection,
  ContextFinding,
} from "./agent/types";

const STARTER_PROMPTS = [
  "What would break if I stopped the database right now?",
  "Walk me through the live topology — what connects to what?",
  "Why aren't my services talking to each other?",
  "Are there any hidden issues I should know about?",
  "Which services are making external API calls?",
];

export function AgentPanel({
  nodes,
  edges,
  tabLabel,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
  const [mentionQuery, setMentionQuery] = useState<{
    query: string;
    startIdx: number;
  } | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiUsage, setAiUsage] = useState<{ used: number; limit: number; remaining: number; mode?: string } | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [providerDomains, setProviderDomains] = useState<
    Record<string, string>
  >({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);
  const [handoffCopied, setHandoffCopied] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
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
  const activeFeedRef = useRef<FeedItem[]>(feed);

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
          (item.stage === "detected" ||
            item.stage === "fixing" ||
            item.stage === "fixed"),
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

  // Fetch Sentinel AI usage, key status, and auth session on mount + window focus
  useEffect(() => {
    const refreshUsage = () => window.electronAPI.agentUsage().then(setAiUsage).catch(() => {});
    refreshUsage();
    window.electronAPI.getApiKeyStatus().then((s) => setHasApiKey(s.hasKey)).catch(() => {});
    window.electronAPI.authGetSession().then(setAuthSession).catch(() => {});
    const cleanup = window.electronAPI.onAuthSessionChanged((session) => {
      setAuthSession(session);
      refreshUsage();
    });
    // Refresh usage when window regains focus (handles day rollover)
    window.addEventListener("focus", refreshUsage);
    return () => {
      cleanup();
      window.removeEventListener("focus", refreshUsage);
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
      root.style.setProperty(
        "--agp-top-offset",
        `${Math.max(0, Math.round(top))}px`,
      );
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

  useEffect(() => {
    activeFeedRef.current = feed;
  }, [feed]);

  const updateActiveThreadFeed = useCallback(
    (nextFeed: FeedItem[]) => {
      activeFeedRef.current = nextFeed;
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

  const appendActiveThreadItems = useCallback(
    (items: FeedItem[]) => {
      const nextFeed = [...activeFeedRef.current, ...items];
      updateActiveThreadFeed(nextFeed);
      return nextFeed;
    },
    [updateActiveThreadFeed],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming || !activeThread) return;

      const userItem: FeedMessage = {
        kind: "message",
        role: "user",
        content: trimmed,
      };
      const updatedFeed = appendActiveThreadItems([userItem]);
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
      const aiMessages = [
        ...updatedFeed
          .filter((item): item is FeedMessage => item.kind === "message")
          .map(({ role, content }) => ({ role, content })),
      ];

      // Optimistically decrement usage counter immediately
      if (aiUsage && aiUsage.mode === "free" && aiUsage.remaining > 0) {
        setAiUsage({ ...aiUsage, used: aiUsage.used + 1, remaining: aiUsage.remaining - 1 });
      }

      try {
        const result = await window.electronAPI.agentChat(
          aiMessages,
          nodeIdsForScan,
          tabLabel ?? null,
          { autopilotEnabled },
          edges,
        );
        window.electronAPI.offChatToken();
        window.electronAPI.offChatStep();
        window.electronAPI.offFixProposal();
        const completedText = streamingTextRef.current || result.content || "";
        if (result.success) {
          updateActiveThreadFeed([
            ...activeFeedRef.current,
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
        // Refresh usage counter after each chat call
        window.electronAPI.agentUsage().then(setAiUsage).catch(() => {});
      }
    },
    [
      activeThread,
      appendActiveThreadItems,
      autopilotEnabled,
      isStreaming,
      nodeIdsForScan,
      scrollToEnd,
      edges,
      tabLabel,
      updateActiveThreadFeed,
    ],
  );

  const handleHandoff = useCallback(async () => {
    const now = new Date().toLocaleString();
    const scope = tabLabel ? `Project: ${tabLabel}` : "All services";
    const internalNodes = nodes.filter((n) => n.type !== "external");

    const services: ContextService[] = internalNodes.map((n) => ({
      name: n.name,
      type: n.type,
      pid: n.pid,
      ports: (n.ports ?? []).map((p) => p.port),
      healthStatus: n.healthStatus ?? "unknown",
      cpu: n.cpu ?? undefined,
      memory: n.memory ?? undefined,
      isDockerContainer: n.isDockerContainer,
      containerState: n.containerState,
      projectPath: n.projectPath ?? undefined,
      externalApis: (n.externalApis ?? []).map((a) => a.name).filter(Boolean),
      routes: (n.routes ?? []).slice(0, 6).map((r) => ({ method: r.method, path: r.path })),
    }));

    // Build topology connections from edges
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const connections: ContextConnection[] = edges
      .map((e) => {
        const src = nodeById.get(e.source);
        const tgt = nodeById.get(e.target);
        if (!src || !tgt) return null;
        return { from: src.name, to: tgt.name, port: e.targetPort };
      })
      .filter((c): c is ContextConnection => c !== null);

    const activeFindings = feed.filter(
      (item): item is FeedFinding => item.kind === "finding",
    );
    const findings: ContextFinding[] = activeFindings.map((f) => ({
      severity: f.severity,
      service: f.service,
      summary: f.summary,
      stage: f.stage,
    }));

    // Build plain-text markdown for clipboard export only.
    const svcLines = services.map((s) => {
      const ports = s.ports.length ? s.ports.join(", ") : "no port";
      const cpu = s.cpu != null ? ` · CPU ${s.cpu.toFixed(1)}%` : "";
      const mem = s.memory != null ? ` · ${s.memory.toFixed(0)} MB` : "";
      const docker = s.isDockerContainer ? ` · container (${s.containerState ?? "?"})` : "";
      const path = s.projectPath ? ` · path: ${s.projectPath}` : "";
      return `- ${s.name} [${s.type}] — port ${ports}, health: ${s.healthStatus}${cpu}${mem}${docker}${path}`;
    });
    const connLines = connections.map((c) => `- ${c.from} → ${c.to} (port ${c.port})`);
    const extLines = services
      .filter((s) => s.externalApis && s.externalApis.length > 0)
      .map((s) => `- ${s.name} calls: ${s.externalApis!.join(", ")}`);
    const routeLines = services
      .filter((s) => s.routes && s.routes.length > 0)
      .map((s) => `- ${s.name}: ${s.routes!.map((r) => `${r.method ?? "?"} ${r.path}`).join(", ")}`);
    const findLines = findings.map(
      (f) => `- [${f.severity.toUpperCase()}] ${f.service}: ${f.summary}`,
    );
    const copyText = [
      `# Fere Runtime Context`,
      `${scope} · ${now}`,
      ``,
      `## Services (${services.length})`,
      svcLines.join("\n") || "(none)",
      connLines.length ? `\n## Service Connections\n${connLines.join("\n")}` : "",
      extLines.length ? `\n## External APIs\n${extLines.join("\n")}` : "",
      routeLines.length ? `\n## API Routes\n${routeLines.join("\n")}` : "",
      ``,
      `## Active Findings`,
      findLines.join("\n") || "(none)",
      ``,
      `## Investigation Template`,
      ``,
      `**What I need help with:**`,
      ``,
      `**Steps already tried:**`,
      `- `,
      ``,
      `**Expected behavior:**`,
      ``,
      `**Actual behavior:**`,
    ]
      .join("\n")
      .trim();

    try {
      if (window.electronAPI?.copyText) {
        const result = await window.electronAPI.copyText(copyText);
        if (!result.success) throw new Error(result.error || "Copy failed");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyText);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      setHandoffCopied(true);
      setTimeout(() => setHandoffCopied(false), 2000);
    } catch {
      // No-op
    }
  }, [nodes, edges, feed, tabLabel]);

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
      const { nodeName, healthStatus, ports, command, inboundConnections, outboundConnections, networkPeers } =
        (e as CustomEvent).detail ?? {};
      if (!nodeName) return;

      const portStr = ports?.length
        ? ` on port ${(ports as number[]).join(", ")}`
        : "";
      const cmdStr = command ? ` (${String(command).slice(0, 60)})` : "";

      // Build connection context from panel data so the agent uses what the UI already shows
      const connLines: string[] = [];
      if (Array.isArray(inboundConnections) && inboundConnections.length > 0) {
        connLines.push(`Inbound (live TCP): ${(inboundConnections as Array<{name:string;sourcePort:number;targetPort:number}>).map((c) => `${c.name} (:${c.sourcePort}→:${c.targetPort})`).join(", ")}`);
      }
      if (Array.isArray(outboundConnections) && outboundConnections.length > 0) {
        connLines.push(`Outbound (live TCP): ${(outboundConnections as Array<{name:string;sourcePort:number;targetPort:number}>).map((c) => `${c.name} (:${c.sourcePort}→:${c.targetPort})`).join(", ")}`);
      }
      if (Array.isArray(networkPeers) && networkPeers.length > 0) {
        connLines.push(`Docker network peers (direction unknown): ${(networkPeers as string[]).join(", ")}`);
      }
      if (connLines.length === 0) connLines.push("No connections observed.");
      const connContext = `\n\nConnections (from live UI data):\n${connLines.map((l) => `- ${l}`).join("\n")}`;

      const isUnhealthy = healthStatus === "red" || healthStatus === "yellow";
      const msg = isUnhealthy
        ? `Investigate **${nodeName}**${portStr}${cmdStr} — health is ${healthStatus}. What's wrong and how do I fix it? Check ports, connections, and logs if it's a container.${connContext}`
        : `Tell me about **${nodeName}**${portStr}${cmdStr} — its current health, routes, and connections.${connContext}`;

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

  useEffect(() => {
    const handler = (e: Event) => {
      const { open: nextOpen } = (e as CustomEvent).detail ?? {};
      if (typeof nextOpen === "boolean") {
        setOpen(nextOpen);
      }
    };
    window.addEventListener("fere:set-agent-open", handler);
    return () => window.removeEventListener("fere:set-agent-open", handler);
  }, []);

  const handleTextareaScroll = useCallback(() => {
    if (mirrorRef.current && inputRef.current) {
      mirrorRef.current.scrollTop = inputRef.current.scrollTop;
    }
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const pos = e.target.selectionStart ?? val.length;
      const before = val.slice(0, pos);
      const atMatch = before.match(/@([\w\-.]*)$/);
      if (atMatch) {
        setMentionQuery({
          query: atMatch[1],
          startIdx: pos - atMatch[0].length,
        });
      } else {
        setMentionQuery(null);
      }
      setInput(val);
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (node: GraphNode) => {
      if (!mentionQuery) return;
      const before = input.slice(0, mentionQuery.startIdx);
      const after = input.slice(
        mentionQuery.startIdx + 1 + mentionQuery.query.length,
      );
      setInput(`${before}@${node.name}${after}`);
      setMentionQuery(null);
      setTimeout(() => inputRef.current?.focus(), 10);
    },
    [input, mentionQuery],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape" && mentionQuery) {
        setMentionQuery(null);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        setMentionQuery(null);
        void send(input);
      }
    },
    [send, input, mentionQuery],
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

  // Reset detect + autopilot when the project tab changes
  const prevTabLabelRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevTabLabelRef.current === undefined) {
      prevTabLabelRef.current = tabLabel;
      return;
    }
    if (prevTabLabelRef.current !== tabLabel) {
      prevTabLabelRef.current = tabLabel;
      setDetectionEnabled(false);
      setAutopilotEnabled(false);
    }
  }, [tabLabel]);

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
        if (
          current.feed.some((f) => f.kind === "finding" && f.id === finding.id)
        )
          return prev;
        const updated: ChatThread = {
          ...current,
          feed: [...current.feed, item],
          updatedAt: Date.now(),
        };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)].slice(
          0,
          MAX_CHAT_THREADS,
        );
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
          const result = await window.electronAPI.getContainerLogTail(
            node.containerId,
            20,
          );
          if (result.success && result.logs) {
            const lines = result.logs.split("\n").filter(Boolean).slice(-10);
            logExcerpt = lines.join("\n");
          }
        } catch {
          /* non-critical */
        }
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
    return () =>
      window.removeEventListener(
        "fere:health-degraded",
        handler as EventListener,
      );
  }, [appendFindingToFeed]);

  const updateFindingInFeed = useCallback(
    (id: string, stage: IncidentStage, error?: string) => {
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.id === activeThreadId);
        if (idx === -1) return prev;
        const current = prev[idx];
        const newFeed = current.feed.map((item) => {
          if (item.kind === "finding" && item.id === id) {
            return {
              ...item,
              stage,
              ...(error !== undefined ? { error } : {}),
            };
          }
          return item;
        });
        if (newFeed === current.feed) return prev;
        const updated: ChatThread = {
          ...current,
          feed: newFeed,
          updatedAt: Date.now(),
        };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)].slice(
          0,
          MAX_CHAT_THREADS,
        );
      });
    },
    [activeThreadId],
  );

  const toSafeAction = useCallback((fix: AgentFixAction | null) => {
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
          updateFindingInFeed(
            finding.id,
            "escalated",
            "no safe autopilot action available",
          );
          continue;
        }
        if (autopilotInFlightRef.current.has(finding.id)) continue;

        autopilotInFlightRef.current.add(finding.id);
        updateFindingInFeed(finding.id, "fixing");

        try {
          const result = await window.electronAPI.agentApplyFix(safeAction);
          if (!result.success) {
            updateFindingInFeed(
              finding.id,
              "escalated",
              result.error ?? "autopilot apply failed",
            );
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
          return (
            nodeMap.has(name) || (normalizedTab && name.includes(normalizedTab))
          );
        });
      });
      if (inScope.length === 0) return;

      const existing =
        surfacedByTabRef.current.get(tabScopeKey) ?? new Set<string>();
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
        setUnreadFindings(
          (n) => n + unseen.filter((f) => f.severity === "critical").length,
        );
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
        const updated = {
          ...current,
          feed: current.feed.filter(
            (item) => !(item.kind === "finding" && item.id === id),
          ),
        };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)].slice(
          0,
          MAX_CHAT_THREADS,
        );
      });
      const existing = surfacedByTabRef.current.get(tabScopeKey);
      if (existing) existing.delete(id);
    },
    [activeThreadId, tabScopeKey],
  );

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

  // When autopilot is turned on, immediately process any already-detected findings
  // that haven't been handled yet (fixes the case where detect runs first, user kills
  // a process, then turns on autopilot and nothing happens until the next scan cycle)
  useEffect(() => {
    if (!autopilotEnabled) return;
    const detectedFindings = feed
      .filter(
        (item): item is FeedFinding =>
          item.kind === "finding" && item.stage === "detected",
      )
      .map((item) => ({
        id: item.id,
        service: item.service,
        summary: item.summary,
        severity: item.severity,
        fix: item.fix,
        affectedServices: [],
        category: "health" as const,
        detail: "",
        impact: "",
      }));
    if (detectedFindings.length > 0) {
      void runAutopilotForFindings(detectedFindings);
    }
  // Only re-run when autopilot flips to enabled — not on every feed change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilotEnabled]);

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
        (item): item is FeedFinding =>
          item.kind === "finding" && item.id === findingId,
      );
      if (!finding) return;
      const safeAction = toSafeAction(finding.fix);
      if (!safeAction) return;

      updateFindingInFeed(findingId, "fixing");
      void window.electronAPI.agentApplyFix(safeAction).then((result) => {
        if (!result.success) {
          updateFindingInFeed(
            findingId,
            "escalated",
            result.error ?? "apply failed",
          );
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
      const isUnhealthy =
        finding.severity === "critical" || finding.severity === "warning";
      const msg = isUnhealthy
        ? `Investigate **${finding.service}**: ${finding.summary}. What's causing this and how do I fix it?`
        : `Tell me about **${finding.service}**: ${finding.summary}.`;
      void send(msg);
    },
    [send],
  );

  const openFindingInClaudeCode = useCallback(
    async (finding: FeedFinding) => {
      const serviceLines = nodes
        .filter((n) => n.type !== "external")
        .map((n) => {
          const port =
            (n.ports ?? []).map((p) => p.port).join(", ") || "no port";
          const cpu = n.cpu != null ? `, CPU ${n.cpu.toFixed(1)}%` : "";
          const mem = n.memory != null ? `, ${n.memory.toFixed(0)} MB` : "";
          return `- ${n.name} (port ${port}) — health: ${n.healthStatus ?? "unknown"}${cpu}${mem}`;
        })
        .join("\n");

      const contextText = [
        `**Finding: ${finding.summary}**`,
        `Severity: ${finding.severity} | Service: ${finding.service}`,
        finding.error ? `\nDetails: ${finding.error}` : "",
        "",
        "**Runtime context:**",
        serviceLines || "  (no services detected)",
        "",
        "Please help me investigate and fix this.",
      ]
        .filter((l) => l !== undefined)
        .join("\n")
        .trim();

      const contextItem: FeedMessage = {
        kind: "message",
        role: "user",
        content: contextText,
        copyable: true,
      };
      appendActiveThreadItems([contextItem]);
      setTimeout(() => scrollToEnd(true), 50);
      // Also open Terminal at the project dir and run `claude`
      void window.electronAPI.openInClaudeCode(finding);
    },
    [nodes, appendActiveThreadItems, scrollToEnd],
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
              <button
                className={`agp-scan-btn agp-handoff-btn agp-header-utility${handoffCopied ? " agp-handoff-btn-copied" : ""}`}
                onClick={handleHandoff}
                title={handoffCopied ? "Runtime context copied" : "Copy runtime context"}
                disabled={isStreaming}
              >
                {handoffCopied ? (
                  <span>Copied</span>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="5" y="5" width="9" height="9" rx="1.5" />
                    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
                  </svg>
                )}
              </button>
              {threads.length > 0 && (
                <button
                  className={`agp-scan-btn agp-history-btn agp-header-utility${historyOpen ? " agp-scan-btn-active" : ""}`}
                  onClick={() => {
                    setHistoryOpen((v) => !v);
                  }}
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
              <button
                className="agp-close agp-header-utility agp-close-top"
                onClick={() => setOpen(false)}
              >
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
                        {
                          thread.feed.filter((item) => item.kind === "message")
                            .length
                        }{" "}
                        msg · {formatThreadTimestamp(thread.updatedAt)}
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
            {hasApiKey !== null && (
              hasApiKey ? (
                <ApiKeySetup
                  onKeyChanged={() => {
                    window.electronAPI.getApiKeyStatus().then((s) => setHasApiKey(s.hasKey)).catch(() => {});
                    window.electronAPI.agentUsage().then(setAiUsage).catch(() => {});
                  }}
                />
              ) : authSession?.signedIn ? (
                aiUsage && aiUsage.remaining <= 0 ? (
                  <div className="agp-auth-status">
                    <div className="agp-auth-exhausted">
                      <span>You've used your {aiUsage.limit} free calls today.</span>
                      <ApiKeySetup
                        onKeyChanged={() => {
                          window.electronAPI.getApiKeyStatus().then((s) => setHasApiKey(s.hasKey)).catch(() => {});
                          window.electronAPI.agentUsage().then(setAiUsage).catch(() => {});
                        }}
                      />
                    </div>
                  </div>
                ) : aiUsage ? (
                  <div className="agp-auth-status">
                    <div className="agp-auth-remaining">
                      {aiUsage.remaining}/{aiUsage.limit} free calls remaining today
                    </div>
                  </div>
                ) : null
              ) : (
                <div className="agp-auth-gate">
                  <button
                    className="agp-auth-provider-btn"
                    onClick={() => {
                      window.electronAPI.authSignInGoogle().then((result) => {
                        if (!result?.success) {
                          window.alert(result?.error || "Google sign-in failed.");
                        }
                      }).catch((err) => {
                        window.alert(err?.message || "Google sign-in failed.");
                      });
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 48 48">
                      <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                      <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                      <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24.0 24.0 0 0 0 0 21.56l7.98-6.19z"/>
                      <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                    </svg>
                    Continue with Google
                  </button>
                  <span className="agp-auth-gate-sub">5 free AI calls per day</span>
                  <div className="agp-auth-divider">
                    <span>or</span>
                  </div>
                  <ApiKeySetup
                    onKeyChanged={() => {
                      window.electronAPI.getApiKeyStatus().then((s) => setHasApiKey(s.hasKey)).catch(() => {});
                      window.electronAPI.agentUsage().then(setAiUsage).catch(() => {});
                    }}
                  />
                </div>
              )
            )}
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
                        onOpenInClaudeCode={openFindingInClaudeCode}
                        isStreaming={isStreaming}
                      />
                    );
                  }
                  if (item.kind === "context") {
                    return (
                      <ContextBlock
                        key={i}
                        snapshot={item.snapshot}
                        copyText={item.copyText}
                      />
                    );
                  }
                  return (
                    <div
                      key={i}
                      className={`agp-msg agp-msg-${item.role}${item.copyable ? " agp-msg-copyable" : ""}`}
                    >
                      <div className="agp-msg-bubble">
                        {item.role === "assistant" || item.copyable ? (
                          <ReactMarkdown
                            className="agp-markdown"
                            rehypePlugins={[rehypeHighlight]}
                            components={mdComponents}
                          >
                            {item.content}
                          </ReactMarkdown>
                        ) : (
                          renderMentions(item.content, nodes)
                        )}
                        {item.copyable && <CopyButton text={item.content} />}
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
                                <StepIcon stepType={step.type} />
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
          <div className="agp-input-wrap">
            {mentionQuery && (
              <MentionDropdown
                query={mentionQuery.query}
                nodes={nodes}
                onSelect={handleMentionSelect}
              />
            )}
            <div className="agp-input-row">
              <div className="agp-input-container">
                <div
                  ref={mirrorRef}
                  className="agp-input-mirror"
                  aria-hidden="true"
                >
                  {renderMirrorContent(input, nodes)}
                  {"\u200b"}
                </div>
                <textarea
                  ref={inputRef}
                  className="agp-input"
                  placeholder="Ask anything about your running stack… (Enter to send)"
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onScroll={handleTextareaScroll}
                  disabled={isStreaming}
                />
              </div>
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
        </div>
      )}
    </>
  );
}
