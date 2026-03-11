import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { DebugProgress, GraphNode } from "../types/electron";
import { getServiceColor, getTypeBadge } from "./graph/constants";
import { BrandIcon, inferServiceBrand } from "./graph/brandIcons";

interface DebugPanelProps {
  isOpen: boolean;
  onClose: () => void;
  graphNodes: GraphNode[];
}

type DebugPhase = "setup" | "input" | "running" | "complete";

interface InvestigationStep {
  type: "thinking" | "tool_call" | "tool_result" | "follow_up";
  tool?: string;
  input?: Record<string, unknown>;
  summary?: string;
  result?: unknown;
  message?: string;
  iteration: number;
  timestamp: number;
}

interface EvidenceData {
  services: Map<string, { name: string; tools: string[] }>;
  files: Array<{ service: string; path: string; line?: number }>;
  endpoints: Array<{ method: string; url: string }>;
}

interface MentionContext {
  target: "problem" | "followup";
  start: number;
  end: number;
  query: string;
}

interface ChatTurn {
  id: string;
  prompt: string;
  response: string;
  createdAt: number;
}

interface ChatThread {
  id: string;
  title: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

const CHAT_HISTORY_STORAGE_KEY = "fere-debug-chat-threads-v1";
const CHAT_SELECTED_STORAGE_KEY = "fere-debug-chat-selected-v1";
const CHAT_LEGACY_STORAGE_KEY = "fere-debug-chat-history-v1";
const RATE_LIMIT_STORAGE_KEY = "fere-debug-rate-limit-v1";
const DAILY_CALL_LIMIT = 5;

function getTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getDailyUsage(): { date: string; count: number } {
  try {
    const raw = window.localStorage.getItem(RATE_LIMIT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.date === getTodayKey() && typeof parsed.count === "number") {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return { date: getTodayKey(), count: 0 };
}

function incrementDailyUsage(): number {
  const usage = getDailyUsage();
  const next = { date: getTodayKey(), count: usage.count + 1 };
  try {
    window.localStorage.setItem(RATE_LIMIT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next.count;
}

function getRemainingCalls(): number {
  return Math.max(0, DAILY_CALL_LIMIT - getDailyUsage().count);
}

function extractEvidence(steps: InvestigationStep[]): EvidenceData {
  const services = new Map<string, { name: string; tools: string[] }>();
  const files: EvidenceData["files"] = [];
  const endpoints: EvidenceData["endpoints"] = [];
  const seenFiles = new Set<string>();
  const seenEndpoints = new Set<string>();

  for (const step of steps) {
    if (step.type !== "tool_call" || !step.tool || !step.input) continue;

    const tool = step.tool;
    const input = step.input;

    // Extract service names
    const serviceName = (input.service_name || input.container_name) as
      | string
      | undefined;
    if (serviceName) {
      const existing = services.get(serviceName);
      if (existing) {
        if (!existing.tools.includes(tool)) existing.tools.push(tool);
      } else {
        services.set(serviceName, { name: serviceName, tools: [tool] });
      }
    }

    // Extract files
    if (tool === "read_source_file" && input.file_path) {
      const key = `${serviceName}:${input.file_path}`;
      if (!seenFiles.has(key)) {
        seenFiles.add(key);
        const lineStart = input.line_start as number | undefined;
        files.push({
          service: (serviceName as string) || "unknown",
          path: String(input.file_path),
          line: lineStart,
        });
      }
    }

    // Extract endpoints
    if (
      (tool === "fire_request" || tool === "fire_concurrent_requests") &&
      input.url
    ) {
      const key = `${input.method}:${input.url}`;
      if (!seenEndpoints.has(key)) {
        seenEndpoints.add(key);
        endpoints.push({
          method: String(input.method),
          url: String(input.url),
        });
      }
    }
  }

  return { services, files, endpoints };
}

function formatToolInput(
  tool: string,
  input: Record<string, unknown>,
): string {
  switch (tool) {
    case "fire_request":
      return `${input.method} ${input.url}`;
    case "fire_concurrent_requests":
      return `${input.method} ${input.url} x${input.count}`;
    case "get_container_logs": {
      let s = String(input.container_name);
      if (input.tail) s += ` (last ${input.tail} lines)`;
      if (input.grep) s += ` grep: "${input.grep}"`;
      return s;
    }
    case "read_source_file": {
      let s = String(input.file_path);
      if (input.line_start || input.line_end)
        s += `:${input.line_start || 1}-${input.line_end || "end"}`;
      return s;
    }
    case "find_source_files":
      return `${input.pattern} in ${input.service_name}`;
    case "grep_source":
      return `"${input.pattern}" in ${input.service_name}`;
    case "get_service_routes":
      return String(input.service_name);
    case "run_database_query":
      return `${input.container_name}: ${String(input.query).slice(0, 60)}`;
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

function stringifyToolValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderResultField(
  label: string,
  value: unknown,
  options?: { code?: boolean },
) {
  if (
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return null;
  }

  const text = stringifyToolValue(value);
  return (
    <div className="debug-panel-result-field" key={label}>
      <div className="debug-panel-result-label">{label}</div>
      {options?.code || text.includes("\n") ? (
        <pre className="debug-panel-result-pre">
          <code>{text}</code>
        </pre>
      ) : (
        <div className="debug-panel-result-value">{text}</div>
      )}
    </div>
  );
}

export function DebugPanel({ isOpen, onClose, graphNodes }: DebugPanelProps) {
  const CLOSE_ANIMATION_MS = 180;
  const [phase, setPhase] = useState<DebugPhase>("input");
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [problem, setProblem] = useState("");
  const [steps, setSteps] = useState<InvestigationStep[]>([]);
  const [diagnosis, setDiagnosis] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [followUpInput, setFollowUpInput] = useState("");
  const [fileError, setFileError] = useState("");
  const [isResultsVisible, setIsResultsVisible] = useState(true);
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const [expandedToolResults, setExpandedToolResults] = useState<
    Record<string, boolean>
  >({});
  const [problemCaret, setProblemCaret] = useState(0);
  const [followUpCaret, setFollowUpCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionSuppressed, setMentionSuppressed] = useState(false);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingHistory, setViewingHistory] = useState(false);
  const [remainingCalls, setRemainingCalls] = useState(() => getRemainingCalls());
  const problemInputRef = useRef<HTMLTextAreaElement>(null);
  const followUpInputRef = useRef<HTMLTextAreaElement>(null);
  const problemHighlightRef = useRef<HTMLDivElement>(null);
  const followUpHighlightRef = useRef<HTMLDivElement>(null);
  const pendingPromptRef = useRef("");
  const selectedChatIdRef = useRef("");
  const closeTimerRef = useRef<number | null>(null);

  // Build lookup maps from graph nodes
  const nodeByName = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of graphNodes) {
      map.set(n.name.toLowerCase(), n);
    }
    return map;
  }, [graphNodes]);

  const mentionCandidates = useMemo(() => {
    const isIpLike = (name: string) =>
      /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(name) ||
      /^\[?[a-fA-F0-9:]+\]?(:\d+)?$/.test(name);

    const byName = new Map<string, GraphNode>();
    for (const node of graphNodes) {
      const name = node.name.trim();
      if (!name || isIpLike(name)) continue;
      if (node.isGhost || node.type === "external") continue;
      if (!byName.has(name)) byName.set(name, node);
    }
    return Array.from(byName.entries())
      .map(([name, node]) => ({ name, node }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [graphNodes]);

  const createChatThread = useCallback((title?: string): ChatThread => {
    const now = Date.now();
    return {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      title: (title || "New Chat").trim() || "New Chat",
      turns: [],
      createdAt: now,
      updatedAt: now,
    };
  }, []);

  const selectedChat = useMemo(
    () => chatThreads.find((thread) => thread.id === selectedChatId),
    [chatThreads, selectedChatId],
  );

  // --- Service & file click handlers ---

  const normalizeServiceToken = useCallback((value: string) => {
    return value
      .trim()
      .replace(/^`+|`+$/g, "")
      .replace(/^@+/, "")
      .replace(/^[([{"']+|[)\]}",.!?:;'"]+$/g, "")
      .toLowerCase();
  }, []);

  const findServiceNode = useCallback(
    (serviceToken: string) => {
      const normalized = normalizeServiceToken(serviceToken);
      if (!normalized) return undefined;
      return (
        nodeByName.get(normalized) ||
        graphNodes.find(
          (n) =>
            n.name.toLowerCase() === normalized ||
            n.name.toLowerCase().includes(normalized),
        )
      );
    },
    [graphNodes, nodeByName, normalizeServiceToken],
  );

  const handleServiceClick = useCallback(
    (serviceName: string) => {
      const node = findServiceNode(serviceName);
      if (!node) return;
      // Service clicks should navigate/focus without applying debug glow.
      window.dispatchEvent(
        new CustomEvent("fere:debug-highlight-services", {
          detail: { nodeIds: [] },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("fere:debug-focus-node", {
          detail: { nodeId: node.id },
        }),
      );
    },
    [findServiceNode],
  );

  const handleFileClick = useCallback(
    async (fileRef: string) => {
      // Parse "service-name/path/to/file:line" or just "path/to/file:line"
      const colonIdx = fileRef.lastIndexOf(":");
      let pathPart = fileRef;
      let line: number | undefined;

      if (colonIdx > 0) {
        const afterColon = fileRef.slice(colonIdx + 1);
        const lineNum = parseInt(afterColon, 10);
        if (!isNaN(lineNum)) {
          pathPart = fileRef.slice(0, colonIdx);
          line = lineNum;
        }
      }

      // Try to resolve via service name as first path segment
      const parts = pathPart.split("/");
      const serviceName = parts[0];
      const relPath = parts.slice(1).join("/");
      const node =
        nodeByName.get(serviceName.toLowerCase()) ||
        graphNodes.find((n) =>
          n.name.toLowerCase().includes(serviceName.toLowerCase()),
        );

      let result;
      if (node?.projectPath && relPath) {
        result = await window.electronAPI.openInEditor(
          `${node.projectPath}/${relPath}`,
          line,
        );
      } else {
        result = await window.electronAPI.openInEditor(pathPart, line);
      }

      if (!result.success) {
        setFileError(result.error || "Could not open file");
        setTimeout(() => setFileError(""), 3000);
      }
    },
    [graphNodes, nodeByName],
  );

  const toggleToolResult = useCallback((key: string) => {
    setExpandedToolResults((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Check if a file path reference can be resolved to an absolute path
  const canResolveFile = useCallback(
    (text: string) => {
      // Absolute paths are always resolvable
      if (text.startsWith("/")) return true;

      // Strip trailing :lineNumber
      let pathPart = text;
      const colonIdx = text.lastIndexOf(":");
      if (colonIdx > 0) {
        const afterColon = text.slice(colonIdx + 1);
        if (!isNaN(parseInt(afterColon, 10))) {
          pathPart = text.slice(0, colonIdx);
        }
      }

      // First segment must be a service name with a projectPath
      const serviceName = pathPart.split("/")[0];
      const node =
        nodeByName.get(serviceName.toLowerCase()) ||
        graphNodes.find((n) =>
          n.name.toLowerCase().includes(serviceName.toLowerCase()),
        );
      return !!(node?.projectPath);
    },
    [graphNodes, nodeByName],
  );

  const getMentionContext = useCallback(
    (
      text: string,
      caret: number,
      target: "problem" | "followup",
    ): MentionContext | null => {
      const pos = Math.max(0, Math.min(caret, text.length));
      const uptoCaret = text.slice(0, pos);
      const tokenStart = Math.max(
        uptoCaret.lastIndexOf(" "),
        uptoCaret.lastIndexOf("\n"),
        uptoCaret.lastIndexOf("\t"),
      ) + 1;
      const token = uptoCaret.slice(tokenStart);
      if (!token.startsWith("@")) return null;
      if (token.length > 1 && token.includes("@")) return null;
      const query = token.slice(1);
      if (!/^[a-zA-Z0-9._-]*$/.test(query)) return null;
      return { target, start: tokenStart, end: pos, query };
    },
    [],
  );

  const activeMention = useMemo(() => {
    if (phase === "input") {
      return getMentionContext(problem, problemCaret, "problem");
    }
    if (phase === "complete" && diagnosis && !error) {
      return getMentionContext(followUpInput, followUpCaret, "followup");
    }
    return null;
  }, [
    phase,
    diagnosis,
    error,
    problem,
    problemCaret,
    followUpInput,
    followUpCaret,
    getMentionContext,
  ]);

  const mentionOptions = useMemo(() => {
    if (!activeMention || mentionSuppressed) return [];
    const q = activeMention.query.toLowerCase();
    return mentionCandidates
      .filter((option) => option.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [activeMention, mentionCandidates, mentionSuppressed]);

  useEffect(() => {
    setMentionSuppressed(false);
    setMentionIndex(0);
  }, [activeMention?.target, activeMention?.query]);

  useEffect(() => {
    if (mentionOptions.length === 0) return;
    if (mentionIndex >= mentionOptions.length) {
      setMentionIndex(mentionOptions.length - 1);
    }
  }, [mentionIndex, mentionOptions]);

  // --- Markdown components with interactive code ---

  const markdownComponents = useMemo(
    () => ({
      code({
        children,
        className,
      }: {
        children?: React.ReactNode;
        className?: string;
      }) {
        // Skip code blocks (they have a className like "language-xxx")
        if (className) return <code className={className}>{children}</code>;

        const text = String(children).replace(/\n$/, "");

        // Check if it's a service name
        if (findServiceNode(text)) {
          return (
            <span
              className="debug-clickable-service"
              onClick={() => handleServiceClick(text)}
              title="Click to highlight on graph"
            >
              {text}
            </span>
          );
        }

        // Check if it's a file path (contains / and optionally :line)
        if (text.includes("/")) {
          if (canResolveFile(text)) {
            return (
              <span
                className="debug-clickable-file"
                onClick={() => handleFileClick(text)}
                title="Click to open in editor"
              >
                {text}
              </span>
            );
          }
          // Unresolvable path — render as styled code, not clickable
          return <code>{text}</code>;
        }

        return <code>{text}</code>;
      },
      a({
        href,
        children,
      }: {
        href?: string;
        children?: React.ReactNode;
      }) {
        const label = String(children ?? "").replace(/\n/g, " ").trim();
        const matchedNode = findServiceNode(label) || findServiceNode(href || "");

        if (matchedNode) {
          return (
            <a
              href={href || "#"}
              className="debug-clickable-service debug-markdown-service-link"
              onClick={(e) => {
                e.preventDefault();
                handleServiceClick(matchedNode.name);
              }}
              title={`Focus ${matchedNode.name} on graph`}
            >
              {children}
            </a>
          );
        }

        return (
          <a
            href={href}
            target={href?.startsWith("http") ? "_blank" : undefined}
            rel={href?.startsWith("http") ? "noreferrer" : undefined}
          >
            {children}
          </a>
        );
      },
    }),
    [findServiceNode, handleServiceClick, handleFileClick, canResolveFile],
  );

  const linkifyServiceMentions = useCallback((text: string) => {
    if (!text) return text;
    return text.replace(
      /(^|[\s([{"'])@([a-zA-Z0-9._-]+)/g,
      (_, prefix: string, name: string) => `${prefix}[@${name}](#${name})`,
    );
  }, []);

  // --- Lifecycle ---

  // Check API key on mount
  useEffect(() => {
    window.electronAPI.debugGetApiKeyStatus().then((result) => {
      setHasApiKey(result.hasKey);
      if (!result.hasKey) setPhase("setup");
    });
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
      const selectedRaw = window.localStorage.getItem(CHAT_SELECTED_STORAGE_KEY);
      const legacyRaw = window.localStorage.getItem(CHAT_LEGACY_STORAGE_KEY);

      const normalizeTurn = (turn: unknown): ChatTurn | null => {
        if (!turn || typeof turn !== "object") return null;
        const t = turn as Partial<ChatTurn>;
        if (typeof t.prompt !== "string" || typeof t.response !== "string") {
          return null;
        }
        if (!t.prompt.trim() || !t.response.trim()) return null;
        const createdAt = typeof t.createdAt === "number" ? t.createdAt : Date.now();
        const id =
          typeof t.id === "string"
            ? t.id
            : `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
        return { id, prompt: t.prompt, response: t.response, createdAt };
      };

      const normalizeThread = (thread: unknown): ChatThread | null => {
        if (!thread || typeof thread !== "object") return null;
        const t = thread as Partial<ChatThread>;
        const turns = Array.isArray(t.turns)
          ? t.turns.map(normalizeTurn).filter((v): v is ChatTurn => !!v)
          : [];
        const createdAt =
          typeof t.createdAt === "number" ? t.createdAt : turns[0]?.createdAt || Date.now();
        const updatedAt =
          typeof t.updatedAt === "number"
            ? t.updatedAt
            : turns[turns.length - 1]?.createdAt || createdAt;
        const id =
          typeof t.id === "string"
            ? t.id
            : `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
        const title =
          typeof t.title === "string" && t.title.trim()
            ? t.title
            : turns[0]?.prompt.slice(0, 72) || "New Chat";
        return { id, title, turns, createdAt, updatedAt };
      };

      const parsed = raw ? JSON.parse(raw) : [];
      const safeThreads = Array.isArray(parsed)
        ? parsed.map(normalizeThread).filter((v): v is ChatThread => !!v)
        : [];

      if (safeThreads.length === 0 && !raw && legacyRaw) {
        try {
          const legacyParsed = JSON.parse(legacyRaw);
          if (Array.isArray(legacyParsed)) {
            const legacyTurns = legacyParsed
              .map(normalizeTurn)
              .filter((v): v is ChatTurn => !!v);
            if (legacyTurns.length > 0) {
              const imported = createChatThread(legacyTurns[0].prompt.slice(0, 72));
              imported.turns = legacyTurns;
              imported.createdAt = legacyTurns[0].createdAt;
              imported.updatedAt = legacyTurns[legacyTurns.length - 1].createdAt;
              safeThreads.push(imported);
            }
          }
        } catch {
          // ignore legacy parse errors
        }
      }

      if (safeThreads.length > 0) {
        setChatThreads(safeThreads);
        const selected =
          selectedRaw && safeThreads.some((t) => t.id === selectedRaw)
            ? selectedRaw
            : safeThreads[safeThreads.length - 1].id;
        setSelectedChatId(selected);
      } else {
        const initial = createChatThread();
        setChatThreads([initial]);
        setSelectedChatId(initial.id);
      }
      setIsHistoryLoaded(true);
    } catch {
      const initial = createChatThread();
      setChatThreads([initial]);
      setSelectedChatId(initial.id);
      setIsHistoryLoaded(true);
    }
  }, [createChatThread]);

  useEffect(() => {
    if (!isHistoryLoaded) return;
    try {
      window.localStorage.setItem(
        CHAT_HISTORY_STORAGE_KEY,
        JSON.stringify(chatThreads),
      );
      if (selectedChatId) {
        window.localStorage.setItem(CHAT_SELECTED_STORAGE_KEY, selectedChatId);
      }
    } catch {
      // ignore storage write failures
    }
  }, [chatThreads, selectedChatId, isHistoryLoaded]);

  useEffect(() => {
    if (chatThreads.length === 0) return;
    if (!selectedChatId || !chatThreads.some((t) => t.id === selectedChatId)) {
      setSelectedChatId(chatThreads[chatThreads.length - 1].id);
    }
  }, [chatThreads, selectedChatId]);

  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
      setShowHistory(false);
      setViewingHistory(false);
      setRemainingCalls(getRemainingCalls());
      return;
    }

    if (!shouldRender) return;

    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
      closeTimerRef.current = null;
    }, CLOSE_ANIMATION_MS);

    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [isOpen, shouldRender]);

  // Escape to close
  const handleClose = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("fere:debug-highlight-services", {
        detail: { nodeIds: [] },
      }),
    );
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, handleClose]);

  // Subscribe to progress events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onDebugProgress(
      (progress: DebugProgress) => {
        switch (progress.type) {
          case "thinking":
            setSteps((prev) => [
              ...prev,
              {
                type: "thinking",
                message: "",
                iteration: progress.iteration,
                timestamp: Date.now(),
              },
            ]);
            break;
          case "tool_call":
            setSteps((prev) => [
              ...prev,
              {
                type: "tool_call",
                tool: progress.tool,
                input: progress.input,
                iteration: progress.iteration,
                timestamp: Date.now(),
              },
            ]);
            break;
          case "tool_result":
            setSteps((prev) => [
              ...prev,
              {
                type: "tool_result",
                tool: progress.tool,
                input: progress.input,
                summary: progress.summary,
                result: progress.result,
                iteration: progress.iteration,
                timestamp: Date.now(),
              },
            ]);
            break;
          case "diagnosis_delta":
            setDiagnosis((prev) => prev + progress.text);
            setSteps((prev) => {
              const next = [...prev];
              for (let idx = next.length - 1; idx >= 0; idx -= 1) {
                if (next[idx].type === "thinking") {
                  const current = next[idx].message || "";
                  next[idx] = { ...next[idx], message: current + progress.text };
                  break;
                }
              }
              return next;
            });
            break;
          case "complete":
            // Authoritative final text — replaces any streamed partial content
            setDiagnosis(progress.diagnosis);
            incrementDailyUsage();
            setRemainingCalls(getRemainingCalls());
            if (pendingPromptRef.current.trim() && progress.diagnosis.trim()) {
              const promptText = pendingPromptRef.current.trim();
              const responseText = progress.diagnosis.trim();
              setChatThreads((prev) => {
                const now = Date.now();
                const targetId = selectedChatIdRef.current || selectedChatId;
                const turn: ChatTurn = {
                  id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
                  prompt: promptText,
                  response: responseText,
                  createdAt: now,
                };
                const idx = prev.findIndex((thread) => thread.id === targetId);
                if (idx >= 0) {
                  const next = [...prev];
                  const existing = next[idx];
                  next[idx] = {
                    ...existing,
                    title:
                      existing.turns.length === 0
                        ? promptText.slice(0, 72)
                        : existing.title,
                    turns: [...existing.turns, turn],
                    updatedAt: now,
                  };
                  return next;
                }
                const fallback = createChatThread(promptText.slice(0, 72));
                fallback.turns = [turn];
                fallback.updatedAt = now;
                setSelectedChatId(fallback.id);
                selectedChatIdRef.current = fallback.id;
                return [...prev, fallback];
              });
            }
            pendingPromptRef.current = "";
            setPhase("complete");
            break;
          case "error":
            pendingPromptRef.current = "";
            setError(progress.error);
            setPhase("complete");
            break;
        }
      },
    );
    return unsubscribe;
  }, [createChatThread, selectedChatId]);

  // Auto-highlight investigated services when diagnosis completes
  useEffect(() => {
    if (phase !== "complete" || !diagnosis) return;
    const evidence = extractEvidence(steps);
    const nodeIds: string[] = [];
    for (const svc of Array.from(evidence.services.values())) {
      const node =
        nodeByName.get(svc.name.toLowerCase()) ||
        graphNodes.find((n) =>
          n.name.toLowerCase().includes(svc.name.toLowerCase()),
        );
      if (node) nodeIds.push(node.id);
    }
    if (nodeIds.length > 0) {
      window.dispatchEvent(
        new CustomEvent("fere:debug-highlight-services", {
          detail: { nodeIds },
        }),
      );
    }
  }, [phase, diagnosis, steps, graphNodes, nodeByName]);

  // --- Action handlers ---

  const handleSaveApiKey = useCallback(async () => {
    setApiKeyError("");
    const trimmed = apiKeyInput.trim();
    if (!trimmed || trimmed.length < 10) {
      setApiKeyError("Please enter a valid API key");
      return;
    }
    const result = await window.electronAPI.debugSetApiKey(trimmed);
    if (result.success) {
      setHasApiKey(true);
      setPhase("input");
    } else {
      setApiKeyError(result.error || "Failed to save API key");
    }
  }, [apiKeyInput]);

  const handleStart = useCallback(async () => {
    const trimmed = problem.trim();
    if (!trimmed) return;
    if (getRemainingCalls() <= 0) {
      setError("Daily limit reached (5 per day). Try again tomorrow.");
      setPhase("complete");
      return;
    }
    if (!selectedChatIdRef.current && !selectedChatId) {
      const fresh = createChatThread(trimmed.slice(0, 72));
      setChatThreads((prev) => [...prev, fresh]);
      setSelectedChatId(fresh.id);
      selectedChatIdRef.current = fresh.id;
    } else if (selectedChatId) {
      selectedChatIdRef.current = selectedChatId;
    }
    pendingPromptRef.current = trimmed;
    setSteps([]);
    setDiagnosis("");
    setError("");
    setFollowUpInput("");
    setIsResultsVisible(true);
    setExpandedToolResults({});
    setViewingHistory(false);
    setShowHistory(false);
    setPhase("running");
    const result = await window.electronAPI.debugStart({ problem: trimmed });
    if (!result.success) {
      pendingPromptRef.current = "";
      setError(result.error || "Failed to start investigation");
      setPhase("complete");
    }
  }, [problem, selectedChatId, createChatThread]);

  const handleStop = useCallback(async () => {
    await window.electronAPI.debugStop();
    pendingPromptRef.current = "";
    setError("Investigation cancelled");
    setPhase("complete");
  }, []);

  const handleCopy = useCallback(() => {
    const latestResponse =
      selectedChat?.turns?.[selectedChat.turns.length - 1]?.response || diagnosis;
    if (!latestResponse) return;
    window.electronAPI.copyText(latestResponse).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [diagnosis, selectedChat]);

  const handleNewInvestigation = useCallback(() => {
    pendingPromptRef.current = "";
    const fresh = createChatThread();
    setChatThreads((prev) => [...prev, fresh]);
    setSelectedChatId(fresh.id);
    selectedChatIdRef.current = fresh.id;
    setSteps([]);
    setDiagnosis("");
    setError("");
    setFollowUpInput("");
    setProblem("");
    setIsResultsVisible(true);
    setExpandedToolResults({});
    setViewingHistory(false);
    setShowHistory(false);
    setPhase("input");
    window.dispatchEvent(
      new CustomEvent("fere:debug-highlight-services", {
        detail: { nodeIds: [] },
      }),
    );
  }, [createChatThread]);

  const handleFollowUp = useCallback(async () => {
    const trimmed = followUpInput.trim();
    if (!trimmed) return;
    if (getRemainingCalls() <= 0) {
      setError("Daily limit reached (5 per day). Try again tomorrow.");
      setPhase("complete");
      return;
    }
    pendingPromptRef.current = trimmed;
    setSteps((prev) => [
      ...prev,
      {
        type: "follow_up",
        message: trimmed,
        iteration: 0,
        timestamp: Date.now(),
      },
    ]);
    setDiagnosis("");
    setError("");
    setFollowUpInput("");
    setIsResultsVisible(true);
    setExpandedToolResults({});
    setPhase("running");
    const result = await window.electronAPI.debugFollowUp({ message: trimmed });
    if (!result.success) {
      pendingPromptRef.current = "";
      setError(result.error || "Failed to send follow-up");
      setPhase("complete");
    }
  }, [followUpInput]);

  const handleSelectChat = useCallback((chatId: string) => {
    setSelectedChatId(chatId);
    selectedChatIdRef.current = chatId;
    setShowHistory(false);
    setViewingHistory(true);
    setIsResultsVisible(true);
  }, []);

  const handleClearChat = useCallback(
    (chatId: string) => {
      setChatThreads((prev) => {
        const remaining = prev.filter((thread) => thread.id !== chatId);
        if (remaining.length > 0) return remaining;
        const fresh = createChatThread();
        setSelectedChatId(fresh.id);
        selectedChatIdRef.current = fresh.id;
        return [fresh];
      });
      if (selectedChatIdRef.current === chatId) {
        selectedChatIdRef.current = "";
      }
      setProblem("");
      setFollowUpInput("");
    },
    [createChatThread],
  );

  const autoResizeTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el) return;
      const minHeight = 48;
      const maxHeight = 220;
      el.style.height = "0px";
      const next = Math.max(minHeight, Math.min(maxHeight, el.scrollHeight));
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
    },
    [],
  );

  const applyMention = useCallback(
    (serviceName: string) => {
      if (!activeMention) return;
      const insertion = `@${serviceName} `;
      const nextCursor = activeMention.start + insertion.length;
      if (activeMention.target === "problem") {
        const next =
          problem.slice(0, activeMention.start) +
          insertion +
          problem.slice(activeMention.end);
        setProblem(next);
        setProblemCaret(nextCursor);
        requestAnimationFrame(() => {
          const el = problemInputRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(nextCursor, nextCursor);
          autoResizeTextarea(el);
        });
        return;
      }
      const next =
        followUpInput.slice(0, activeMention.start) +
        insertion +
        followUpInput.slice(activeMention.end);
      setFollowUpInput(next);
      setFollowUpCaret(nextCursor);
      requestAnimationFrame(() => {
        const el = followUpInputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
        autoResizeTextarea(el);
      });
    },
    [activeMention, problem, followUpInput, autoResizeTextarea],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionOptions.length > 0 && activeMention?.target === "problem") {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setMentionSuppressed(true);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((prev) => (prev + 1) % mentionOptions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((prev) =>
            (prev - 1 + mentionOptions.length) % mentionOptions.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applyMention(
            (mentionOptions[mentionIndex] || mentionOptions[0]).name,
          );
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleStart();
      }
    },
    [handleStart, mentionOptions, mentionIndex, activeMention, applyMention],
  );

  const handleFollowUpKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionOptions.length > 0 && activeMention?.target === "followup") {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setMentionSuppressed(true);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((prev) => (prev + 1) % mentionOptions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((prev) =>
            (prev - 1 + mentionOptions.length) % mentionOptions.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applyMention(
            (mentionOptions[mentionIndex] || mentionOptions[0]).name,
          );
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleFollowUp();
      }
    },
    [handleFollowUp, mentionOptions, mentionIndex, activeMention, applyMention],
  );

  const syncHighlightScroll = useCallback(
    (
      e: React.UIEvent<HTMLTextAreaElement>,
      ref: React.RefObject<HTMLDivElement | null>,
    ) => {
      if (!ref.current) return;
      ref.current.scrollTop = e.currentTarget.scrollTop;
      ref.current.scrollLeft = e.currentTarget.scrollLeft;
    },
    [],
  );

  const renderTextWithMentionHighlights = useCallback(
    (text: string) => {
      if (!text) return null;
      const nodes: React.ReactNode[] = [];
      const regex = /@([a-zA-Z0-9._-]+)/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (start > lastIndex) {
          nodes.push(text.slice(lastIndex, start));
        }
        const rawName = match[1];
        const node = findServiceNode(rawName);
        if (node) {
          const typeColor = getServiceColor(node.type);
          nodes.push(
            <span
              key={`${start}-${rawName}`}
              className="debug-inline-mention"
              style={{
                color: typeColor,
                borderColor: `${typeColor}40`,
                background: `${typeColor}18`,
              }}
            >
              @{rawName}
            </span>,
          );
        } else {
          nodes.push(match[0]);
        }
        lastIndex = end;
      }
      if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
      }
      return nodes;
    },
    [findServiceNode],
  );

  const renderToolResultBody = useCallback(
    (step: InvestigationStep) => {
      if (!step.tool) return null;

      const result =
        step.result && typeof step.result === "object"
          ? (step.result as Record<string, unknown>)
          : {};
      const input = step.input || {};
      const serviceName =
        typeof input.service_name === "string" ? input.service_name : null;

      if (typeof step.result === "string") {
        return renderResultField("Result", step.result, { code: true });
      }

      switch (step.tool) {
        case "fire_request":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField("Status", result.status)}
                {renderResultField("Status Text", result.statusText)}
                {renderResultField("Duration", result.duration)}
                {renderResultField("Size", result.size)}
              </div>
              {renderResultField("Headers", result.headers, { code: true })}
              {renderResultField("Body", result.body, { code: true })}
              {renderResultField("Error", result.error)}
            </>
          );
        case "fire_concurrent_requests":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField("Total", result.total)}
                {renderResultField("Succeeded", result.succeeded)}
                {renderResultField("Failed", result.failed)}
              </div>
              {renderResultField("Statuses", result.statuses, { code: true })}
              {renderResultField("Responses", result.responses, { code: true })}
              {renderResultField("Errors", result.errors, { code: true })}
            </>
          );
        case "get_container_logs":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField("Container", result.container)}
                {renderResultField("Line Count", result.lineCount)}
              </div>
              {renderResultField("Logs", result.logs, { code: true })}
              {renderResultField("Error", result.error)}
            </>
          );
        case "read_source_file":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField("File", result.file)}
                {renderResultField("Total Lines", result.totalLines)}
              </div>
              {renderResultField("Content", result.content, { code: true })}
              {renderResultField("Error", result.error)}
            </>
          );
        case "find_source_files":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField("Total", result.total)}
                {renderResultField("Truncated", result.truncated)}
              </div>
              {Array.isArray(result.files) && result.files.length > 0 ? (
                <div className="debug-panel-result-field">
                  <div className="debug-panel-result-label">Files</div>
                  <div className="debug-panel-result-chip-list">
                    {result.files.map((file, idx) => {
                      const filePath =
                        serviceName && typeof file === "string"
                          ? `${serviceName}/${file}`
                          : stringifyToolValue(file);
                      const canOpen = canResolveFile(filePath);
                      return (
                        <button
                          key={`${filePath}-${idx}`}
                          className={`debug-chip debug-chip-file${canOpen ? "" : " debug-chip-disabled"}`}
                          onClick={() => canOpen && handleFileClick(filePath)}
                          disabled={!canOpen}
                          type="button"
                        >
                          {String(file)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {renderResultField("Error", result.error)}
            </>
          );
        case "grep_source":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField("Pattern", result.pattern)}
                {renderResultField("Matches", result.totalMatches)}
              </div>
              {Array.isArray(result.matches) && result.matches.length > 0 ? (
                <div className="debug-panel-result-field">
                  <div className="debug-panel-result-label">Matches</div>
                  <div className="debug-panel-result-list">
                    {result.matches.map((match, idx) => {
                      const typedMatch =
                        match as Record<string, string | number | undefined>;
                      const fileRef =
                        serviceName && typedMatch.file
                          ? `${serviceName}/${typedMatch.file}:${typedMatch.line || 1}`
                          : null;
                      return (
                        <div className="debug-panel-result-list-item" key={idx}>
                          {fileRef && canResolveFile(fileRef) ? (
                            <button
                              type="button"
                              className="debug-clickable-file debug-panel-result-inline-file"
                              onClick={() => handleFileClick(fileRef)}
                            >
                              {typedMatch.file}:{typedMatch.line}
                            </button>
                          ) : (
                            <div className="debug-panel-result-inline-file">
                              {typedMatch.file}:{typedMatch.line}
                            </div>
                          )}
                          <pre className="debug-panel-result-pre">
                            <code>{typedMatch.content || ""}</code>
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {renderResultField("Error", result.error)}
            </>
          );
        case "get_service_routes":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField("Service", result.service)}
                {renderResultField("Route Count", result.count)}
              </div>
              {Array.isArray(result.routes) && result.routes.length > 0 ? (
                <div className="debug-panel-result-field">
                  <div className="debug-panel-result-label">Routes</div>
                  <div className="debug-panel-result-list">
                    {result.routes.map((route, idx) => {
                      const typedRoute =
                        route as Record<string, string | undefined>;
                      return (
                        <div className="debug-panel-result-list-item" key={idx}>
                          <div className="debug-panel-result-route">
                            <span className="debug-panel-result-route-method">
                              {typedRoute.method}
                            </span>
                            <span className="debug-panel-result-route-path">
                              {typedRoute.path}
                            </span>
                            {typedRoute.framework ? (
                              <span className="debug-panel-result-route-framework">
                                {typedRoute.framework}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {renderResultField("Error", result.error)}
            </>
          );
        case "run_database_query":
          return (
            <>
              <div className="debug-panel-result-grid">
                {renderResultField(
                  "Columns",
                  Array.isArray(result.columns) ? result.columns.length : undefined,
                )}
                {renderResultField("Total Rows", result.totalRows)}
              </div>
              {renderResultField("Columns", result.columns, { code: true })}
              {renderResultField("Rows", result.rows, { code: true })}
              {renderResultField("Error", result.error)}
            </>
          );
        default:
          return renderResultField("Result", step.result, { code: true });
      }
    },
    [canResolveFile, handleFileClick],
  );

  useEffect(() => {
    if (phase === "input") autoResizeTextarea(problemInputRef.current);
  }, [phase, problem, autoResizeTextarea]);

  useEffect(() => {
    if (phase === "complete" && diagnosis && !error) {
      autoResizeTextarea(followUpInputRef.current);
    }
  }, [phase, followUpInput, diagnosis, error, autoResizeTextarea]);

  // Loading / hidden state
  if (!shouldRender || hasApiKey === null) return null;

  const historyThreads = chatThreads;
  const selectedHistoryChat = selectedChat;
  const selectedChatTurns = selectedHistoryChat?.turns || [];
  const hasSavedHistory = historyThreads.length > 0;
  const showResultsPanel =
    isResultsVisible &&
    (phase === "running" || phase === "complete" || viewingHistory);
  const problemPlaceholder =
    "Ask Fere Agent to investigate an issue... (Shift+Enter for newline)";
  const followUpPlaceholder =
    'Ask a follow-up... (e.g. "check Redis instead", "try this payload: {...}")';

  return (
    <div
      className={`debug-agent-shell${showResultsPanel ? " debug-agent-shell-with-results" : ""}${isClosing ? " debug-agent-shell-closing" : ""}`}
    >
      <div className="debug-agent-dock">
        <div className="debug-agent-dock-header">
          {hasSavedHistory && (
            <button
              className={`debug-dock-btn${showHistory ? " debug-dock-btn-active" : ""}`}
              onClick={() => setShowHistory((v) => !v)}
              title="Chat history"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 4.5V8l2.5 1.5" />
              </svg>
            </button>
          )}
          <span
            className={`debug-dock-remaining${remainingCalls === 0 ? " debug-dock-remaining-zero" : ""}`}
            title={`${remainingCalls} of ${DAILY_CALL_LIMIT} daily calls remaining`}
          >
            {remainingCalls}/{DAILY_CALL_LIMIT}
          </span>
        </div>

        {showHistory && (
          <div className="debug-history-dropdown">
            <div className="debug-history-dropdown-header">
              <span>History</span>
              <button
                className="debug-history-new-btn"
                onClick={() => { handleNewInvestigation(); setShowHistory(false); }}
              >
                + New Chat
              </button>
            </div>
            {historyThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={`debug-history-item${thread.id === selectedChatId ? " debug-history-item-active" : ""}`}
                onClick={() => handleSelectChat(thread.id)}
              >
                <span className="debug-history-item-title">{thread.title}</span>
                <span className="debug-history-item-meta">
                  {thread.turns.length} msg{thread.turns.length !== 1 ? "s" : ""}
                </span>
                <span
                  className="debug-history-item-delete"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); handleClearChat(thread.id); }}
                  title="Delete chat"
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M1 1l12 12M13 1L1 13" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
        )}

        {phase === "setup" && (
          <div className="debug-panel-setup">
            <p className="debug-panel-setup-text">
              Enter your OpenAI API key to enable the Fere Agent, or set{" "}
              <code>OPENAI_API_KEY</code> in the project root <code>.env</code>.
            </p>
            <input
              type="password"
              className="debug-panel-api-input"
              placeholder="sk-..."
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveApiKey();
              }}
              autoFocus
            />
            {apiKeyError && <p className="debug-panel-error">{apiKeyError}</p>}
            <button
              className="debug-panel-submit"
              onClick={handleSaveApiKey}
              disabled={!apiKeyInput.trim()}
            >
              Save Key
            </button>
          </div>
        )}

        {phase === "input" && (
          <div className="debug-panel-input debug-agent-composer">
            <img
              className="debug-agent-logo"
              src={`${process.env.PUBLIC_URL || ""}/icon.png`}
              alt="Fere logo"
            />
            <div className="debug-textarea-wrap">
              <div
                ref={problemHighlightRef}
                className="debug-textarea-highlight"
                aria-hidden="true"
              >
                {problem ? (
                  renderTextWithMentionHighlights(problem)
                ) : (
                  <span className="debug-textarea-highlight-placeholder">
                    {problemPlaceholder}
                  </span>
                )}
              </div>
              <textarea
                ref={problemInputRef}
                className="debug-panel-textarea debug-textarea-input"
                placeholder=""
                value={problem}
                onChange={(e) => {
                  setProblem(e.target.value);
                  setProblemCaret(e.target.selectionStart ?? e.target.value.length);
                  autoResizeTextarea(e.currentTarget);
                }}
                onClick={(e) => setProblemCaret(e.currentTarget.selectionStart ?? 0)}
                onKeyUp={(e) => setProblemCaret(e.currentTarget.selectionStart ?? 0)}
                onKeyDown={handleKeyDown}
                onScroll={(e) => syncHighlightScroll(e, problemHighlightRef)}
                rows={1}
                autoFocus
              />
            </div>
            {mentionOptions.length > 0 && activeMention?.target === "problem" && (
              <div className="debug-mention-menu" role="listbox">
                {mentionOptions.map((option, idx) => {
                  const typeColor = getServiceColor(option.node.type);
                  const serviceBrand =
                    option.node.isDockerContainer && option.node.type === "container"
                      ? "docker"
                      : inferServiceBrand(option.node) || option.name;
                  return (
                  <button
                    key={option.name}
                    type="button"
                    className={`debug-mention-item${idx === mentionIndex ? " debug-mention-item-active" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyMention(option.name)}
                  >
                    <span className="debug-mention-item-main">
                      <BrandIcon
                        value={serviceBrand}
                        size={14}
                        className="debug-mention-item-icon"
                      />
                      <span className="debug-mention-item-name">@{option.name}</span>
                    </span>
                    <span
                      className="debug-mention-item-badge"
                      style={{
                        color: typeColor,
                        borderColor: `${typeColor}33`,
                        background: `${typeColor}14`,
                      }}
                    >
                      {getTypeBadge(option.node.type)}
                    </span>
                  </button>
                  );
                })}
              </div>
            )}
            <button
              className="debug-panel-submit"
              onClick={handleStart}
              disabled={!problem.trim()}
              aria-label="Investigate"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 12.7V3.3" />
                <path d="M3.8 7.5L8 3.3l4.2 4.2" />
              </svg>
            </button>
          </div>
        )}

        {phase === "running" && (
          <div className="debug-agent-dock-status">
            Investigating...
            {!showResultsPanel && (
              <button
                className="debug-panel-toggle-results"
                onClick={() => setIsResultsVisible(true)}
              >
                View Results
              </button>
            )}
          </div>
        )}

        {phase === "complete" && diagnosis && !error && (
          <div className="debug-panel-followup debug-agent-composer">
            <img
              className="debug-agent-logo"
              src={`${process.env.PUBLIC_URL || ""}/icon.png`}
              alt="Fere logo"
            />
            <div className="debug-textarea-wrap">
              <div
                ref={followUpHighlightRef}
                className="debug-textarea-highlight"
                aria-hidden="true"
              >
                {followUpInput ? (
                  renderTextWithMentionHighlights(followUpInput)
                ) : (
                  <span className="debug-textarea-highlight-placeholder">
                    {followUpPlaceholder}
                  </span>
                )}
              </div>
              <textarea
                ref={followUpInputRef}
                className="debug-panel-followup-textarea debug-textarea-input"
                placeholder=""
                value={followUpInput}
                onChange={(e) => {
                  setFollowUpInput(e.target.value);
                  setFollowUpCaret(e.target.selectionStart ?? e.target.value.length);
                  autoResizeTextarea(e.currentTarget);
                }}
                onClick={(e) => setFollowUpCaret(e.currentTarget.selectionStart ?? 0)}
                onKeyUp={(e) => setFollowUpCaret(e.currentTarget.selectionStart ?? 0)}
                onKeyDown={handleFollowUpKeyDown}
                onScroll={(e) => syncHighlightScroll(e, followUpHighlightRef)}
                rows={1}
                autoFocus
              />
            </div>
            {mentionOptions.length > 0 && activeMention?.target === "followup" && (
              <div className="debug-mention-menu" role="listbox">
                {mentionOptions.map((option, idx) => {
                  const typeColor = getServiceColor(option.node.type);
                  const serviceBrand =
                    option.node.isDockerContainer && option.node.type === "container"
                      ? "docker"
                      : inferServiceBrand(option.node) || option.name;
                  return (
                  <button
                    key={option.name}
                    type="button"
                    className={`debug-mention-item${idx === mentionIndex ? " debug-mention-item-active" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyMention(option.name)}
                  >
                    <span className="debug-mention-item-main">
                      <BrandIcon
                        value={serviceBrand}
                        size={14}
                        className="debug-mention-item-icon"
                      />
                      <span className="debug-mention-item-name">@{option.name}</span>
                    </span>
                    <span
                      className="debug-mention-item-badge"
                      style={{
                        color: typeColor,
                        borderColor: `${typeColor}33`,
                        background: `${typeColor}14`,
                      }}
                    >
                      {getTypeBadge(option.node.type)}
                    </span>
                  </button>
                  );
                })}
              </div>
            )}
            <button
              className="debug-panel-submit"
              onClick={handleFollowUp}
              disabled={!followUpInput.trim()}
              aria-label="Send"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 12.7V3.3" />
                <path d="M3.8 7.5L8 3.3l4.2 4.2" />
              </svg>
            </button>
          </div>
        )}

        {phase === "complete" && !showResultsPanel && (
          <div className="debug-agent-dock-status">
            Results are hidden.
            <button
              className="debug-panel-toggle-results"
              onClick={() => setIsResultsVisible(true)}
            >
              View Results
            </button>
          </div>
        )}
      </div>

      {showResultsPanel && (
        <div className="debug-panel debug-panel-inline">
          <div className="debug-panel-header">
            <span className="debug-panel-title">Fere Agent Response</span>
            <button
              className="debug-panel-close"
              onClick={() => setIsResultsVisible(false)}
              title="Hide results panel"
              aria-label="Hide results panel"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
          </div>

          <div className="debug-panel-body">
            {selectedChatTurns.map((turn) => (
              <div className="debug-chat-turn" key={turn.id}>
                <div className="debug-chat-turn-header">
                  <span className="debug-chat-turn-role">You</span>
                </div>
                <div className="debug-chat-turn-prompt">{turn.prompt}</div>
                <div className="debug-chat-turn-header">
                  <span className="debug-chat-turn-role">Assistant</span>
                </div>
                <div className="debug-chat-turn-response">
                  <ReactMarkdown components={markdownComponents}>
                    {linkifyServiceMentions(turn.response)}
                  </ReactMarkdown>
                </div>
              </div>
            ))}

            {phase === "running" && pendingPromptRef.current.trim() && (
              <div className="debug-chat-turn debug-chat-turn-live">
                <div className="debug-chat-turn-header">
                  <span className="debug-chat-turn-role">You</span>
                </div>
                <div className="debug-chat-turn-prompt">
                  {pendingPromptRef.current.trim()}
                </div>
                <div className="debug-chat-turn-header">
                  <span className="debug-chat-turn-role">Assistant</span>
                </div>
                <div
                  className={`debug-chat-turn-response${diagnosis ? " debug-chat-turn-response-streaming" : ""}`}
                >
                  <ReactMarkdown components={markdownComponents}>
                    {linkifyServiceMentions(diagnosis || "Thinking...")}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {phase === "complete" && error && (
              <div className="debug-panel-diagnosis">
                <div className="debug-panel-section-header">Error</div>
                <div className="debug-panel-error">{error}</div>
              </div>
            )}

            <div className="debug-panel-actions">
              {phase === "running" && (
                <button className="debug-panel-stop" onClick={handleStop}>
                  Stop Investigation
                </button>
              )}
              {phase === "complete" && (
                <>
                  <button
                    className="debug-panel-submit"
                    onClick={handleNewInvestigation}
                  >
                    New Investigation
                  </button>
                  {(selectedHistoryChat?.turns?.length || diagnosis) && (
                    <button
                      className="debug-panel-copy"
                      onClick={handleCopy}
                    >
                      {copied ? "Copied!" : "Copy Report"}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {fileError && <div className="debug-file-toast">{fileError}</div>}
    </div>
  );
}
