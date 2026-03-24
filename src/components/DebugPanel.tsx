import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { DebugProgress, GraphNode } from "../types/electron";

interface DebugPanelProps {
  isOpen: boolean;
  onClose: () => void;
  graphNodes: GraphNode[];
  initialProblem?: string;
  initialProblemKey?: number;
  initialAutoRun?: boolean;
  initialDisplayPrompt?: string;
}

type DebugPhase = "setup" | "input" | "running" | "complete";

type InvestigationStep = {
  type: "thinking" | "tool_call" | "tool_result";
  tool?: string;
  input?: Record<string, unknown>;
  summary?: string;
  result?: unknown;
  message?: string;
  iteration: number;
  timestamp: number;
};

type QuickAction = {
  label: string;
  description: string;
  prompt: string;
  tone: "neutral" | "warn" | "good";
};

interface EvidenceData {
  services: Map<string, { name: string; tools: string[] }>;
  files: Array<{ service: string; path: string; line?: number }>;
  endpoints: Array<{ method: string; url: string }>;
}

interface ResponseSection {
  title: string;
  content: string;
}

const RATE_LIMIT_STORAGE_KEY = "fere-debug-rate-limit-v1";
const DAILY_CALL_LIMIT = 5;

function getTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
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

    if (tool === "read_source_file" && input.file_path) {
      const key = `${serviceName}:${input.file_path}`;
      if (!seenFiles.has(key)) {
        seenFiles.add(key);
        files.push({
          service: serviceName || "unknown",
          path: String(input.file_path),
          line: input.line_start as number | undefined,
        });
      }
    }

    if (
      (tool === "fire_request" || tool === "fire_concurrent_requests") &&
      input.url
    ) {
      const key = `${input.method}:${input.url}`;
      if (!seenEndpoints.has(key)) {
        seenEndpoints.add(key);
        endpoints.push({ method: String(input.method), url: String(input.url) });
      }
    }
  }

  return { services, files, endpoints };
}

function formatToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "fire_request":
      return `${input.method} ${input.url}`;
    case "fire_concurrent_requests":
      return `${input.method} ${input.url} x${input.count}`;
    case "get_container_logs":
      return String(input.container_name || "Container logs");
    case "get_local_service_logs":
      return String(input.service_name || "Service logs");
    case "read_source_file":
      return String(input.file_path || "Source file");
    case "find_source_files":
      return `${input.pattern} in ${input.service_name}`;
    case "grep_source":
      return `Search ${input.pattern}`;
    case "get_service_routes":
      return String(input.service_name || "Routes");
    case "run_database_query":
      return String(input.container_name || "Database query");
    case "run_project_command":
      return `${input.service_name}: ${String(input.command || "command")}`;
    default:
      return tool.replace(/_/g, " ");
  }
}

function parseResponseSections(markdown: string): ResponseSection[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];

  const lines = trimmed.split("\n");
  const sections: ResponseSection[] = [];
  let currentTitle = "Overview";
  let currentContent: string[] = [];

  const flush = () => {
    const content = currentContent.join("\n").trim();
    if (!content) return;
    sections.push({ title: currentTitle, content });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[1].trim();
      currentContent = [];
      continue;
    }
    currentContent.push(line);
  }

  flush();
  return sections.length > 0
    ? sections
    : [{ title: "Overview", content: trimmed }];
}

function getSectionTone(title: string): "neutral" | "warn" | "good" {
  const normalized = title.toLowerCase();
  if (
    normalized.includes("risk") ||
    normalized.includes("issue") ||
    normalized.includes("finding") ||
    normalized.includes("problem")
  ) {
    return "warn";
  }
  if (
    normalized.includes("next action") ||
    normalized.includes("recommend") ||
    normalized.includes("healthy")
  ) {
    return "good";
  }
  return "neutral";
}

export function DebugPanel({
  isOpen,
  onClose,
  graphNodes,
  initialProblem,
  initialProblemKey,
  initialAutoRun = false,
  initialDisplayPrompt,
}: DebugPanelProps) {
  const CLOSE_ANIMATION_MS = 180;
  const [phase, setPhase] = useState<DebugPhase>("input");
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [steps, setSteps] = useState<InvestigationStep[]>([]);
  const [diagnosis, setDiagnosis] = useState("");
  const [error, setError] = useState("");
  const [activeLabel, setActiveLabel] = useState("");
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const pendingAutoStartRef = useRef(false);
  const pendingPromptRef = useRef("");
  const pendingLabelRef = useRef("");

  const nodeByName = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of graphNodes) {
      map.set(node.name.toLowerCase(), node);
    }
    return map;
  }, [graphNodes]);

  const stackSignals = useMemo(() => {
    const visibleNodes = graphNodes.filter((node) => node.type !== "external");
    const unhealthy = visibleNodes.filter(
      (node) => node.healthStatus === "red" || node.healthStatus === "yellow",
    );
    const routes = visibleNodes.reduce(
      (count, node) => count + (node.routes?.length || 0),
      0,
    );
    const datastores = visibleNodes.filter(
      (node) => node.type === "database" || node.type === "cache" || node.type === "broker",
    );

    return [
      { label: "Visible services", value: String(visibleNodes.length) },
      { label: "Needs attention", value: String(unhealthy.length) },
      { label: "Observed routes", value: String(routes) },
      { label: "Stateful deps", value: String(datastores.length) },
    ];
  }, [graphNodes]);

  const normalizeServiceToken = useCallback((value: string) => {
    return value
      .trim()
      .replace(/^`+|`+$/g, "")
      .replace(/^@+/, "")
      .replace(/^[([{"']+|[)\]}",.!?:;'`]+$/g, "")
      .toLowerCase();
  }, []);

  const findServiceNode = useCallback(
    (serviceToken: string) => {
      const normalized = normalizeServiceToken(serviceToken);
      if (!normalized) return undefined;
      return (
        nodeByName.get(normalized) ||
        graphNodes.find(
          (node) =>
            node.name.toLowerCase() === normalized ||
            node.name.toLowerCase().includes(normalized),
        )
      );
    },
    [graphNodes, nodeByName, normalizeServiceToken],
  );

  const handleServiceClick = useCallback(
    (serviceName: string) => {
      const node = findServiceNode(serviceName);
      if (!node) return;
      window.dispatchEvent(
        new CustomEvent("fere:debug-highlight-services", {
          detail: { nodeIds: [node.id] },
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
      const colonIdx = fileRef.lastIndexOf(":");
      let pathPart = fileRef;
      let line: number | undefined;

      if (colonIdx > 0) {
        const afterColon = fileRef.slice(colonIdx + 1);
        const lineNum = parseInt(afterColon, 10);
        if (!Number.isNaN(lineNum)) {
          pathPart = fileRef.slice(0, colonIdx);
          line = lineNum;
        }
      }

      const parts = pathPart.split("/");
      const serviceName = parts[0];
      const relPath = parts.slice(1).join("/");
      const node =
        nodeByName.get(serviceName.toLowerCase()) ||
        graphNodes.find((candidate) =>
          candidate.name.toLowerCase().includes(serviceName.toLowerCase()),
        );

      const result =
        node?.projectPath && relPath
          ? await window.electronAPI.openInEditor(
              `${node.projectPath}/${relPath}`,
              line,
            )
          : await window.electronAPI.openInEditor(pathPart, line);

      if (!result.success) {
        setError(result.error || "Could not open file");
      }
    },
    [graphNodes, nodeByName],
  );

  const canResolveFile = useCallback(
    (text: string) => {
      if (text.startsWith("/")) return true;
      const colonIdx = text.lastIndexOf(":");
      const pathPart =
        colonIdx > 0 && !Number.isNaN(parseInt(text.slice(colonIdx + 1), 10))
          ? text.slice(0, colonIdx)
          : text;
      const serviceName = pathPart.split("/")[0];
      const node =
        nodeByName.get(serviceName.toLowerCase()) ||
        graphNodes.find((candidate) =>
          candidate.name.toLowerCase().includes(serviceName.toLowerCase()),
        );
      return !!node?.projectPath;
    },
    [graphNodes, nodeByName],
  );

  const markdownComponents = useMemo(
    () => ({
      code({ children, className }: { children?: React.ReactNode; className?: string }) {
        if (className) return <code className={className}>{children}</code>;
        const text = String(children).replace(/\n$/, "");
        if (findServiceNode(text)) {
          return (
            <button
              type="button"
              className="debug-inline-action"
              onClick={() => handleServiceClick(text)}
            >
              {text}
            </button>
          );
        }
        if (text.includes("/") && canResolveFile(text)) {
          return (
            <button
              type="button"
              className="debug-inline-action debug-inline-action-file"
              onClick={() => handleFileClick(text)}
            >
              {text}
            </button>
          );
        }
        return <code>{text}</code>;
      },
      a({ href, children }: { href?: string; children?: React.ReactNode }) {
        const label = String(children ?? "").replace(/\n/g, " ").trim();
        const matchedNode = findServiceNode(label) || findServiceNode(href || "");
        if (!matchedNode) {
          return (
            <a
              href={href}
              target={href?.startsWith("http") ? "_blank" : undefined}
              rel={href?.startsWith("http") ? "noreferrer" : undefined}
            >
              {children}
            </a>
          );
        }
        return (
          <button
            type="button"
            className="debug-inline-action"
            onClick={() => handleServiceClick(matchedNode.name)}
          >
            {children}
          </button>
        );
      },
    }),
    [canResolveFile, findServiceNode, handleFileClick, handleServiceClick],
  );

  const quickActions = useMemo<QuickAction[]>(() => {
    const visibleNodes = graphNodes.filter((node) => node.type !== "external");
    const unhealthyNode = visibleNodes.find(
      (node) => node.healthStatus === "red" || node.healthStatus === "yellow",
    );
    const routeNode = visibleNodes.find((node) => (node.routes || []).length > 0);
    const databaseNode = visibleNodes.find((node) => node.type === "database");

    return [
      {
        label: "Assess my stack",
        description: "Run a full runtime assessment and rank the top issues.",
        prompt:
          "Assess my local stack proactively. Identify the top issues, risky dependencies, unhealthy or idle services, and likely runtime or config mismatches. Do the investigation work yourself and finish with concise sections for Current State, Top Findings, Evidence, and Recommended Next Action.",
        tone: "neutral",
      },
      {
        label: unhealthyNode ? `Check ${unhealthyNode.name}` : "Find breakage",
        description: unhealthyNode
          ? "Start with the service that already looks degraded or unhealthy."
          : "Find the most likely failure point without waiting for me to point at one.",
        prompt: unhealthyNode
          ? `Investigate \`${unhealthyNode.name}\` first, then expand to the rest of the stack if needed. Determine the likely root cause, evidence, impacted dependencies, and the best next action.`
          : "Find the most likely breakage, degraded service, or suspicious dependency issue in my local stack, and explain why it matters.",
        tone: "warn",
      },
      {
        label: routeNode ? `Check ${routeNode.name} traffic` : "Runtime health",
        description: routeNode
          ? "Inspect routes, ports, callers, and downstream dependencies."
          : "Explain what looks healthy, idle, degraded, or suspicious right now.",
        prompt: routeNode
          ? `Inspect \`${routeNode.name}\` from a runtime perspective: routes, ports, consumers, health, and any suspicious behavior or missing downstream dependencies.`
          : "Give me a runtime health assessment of my local stack: which services look healthy, idle, degraded, or suspicious, and why.",
        tone: "good",
      },
      {
        label: databaseNode ? `Check ${databaseNode.name} dependencies` : "Dependency risks",
        description: databaseNode
          ? "Map consumers and identify single points of failure around this dependency."
          : "Find missing or risky infrastructure relationships in the stack.",
        prompt: databaseNode
          ? `Map what depends on \`${databaseNode.name}\`, what \`${databaseNode.name}\` depends on, and whether it looks like a risky bottleneck or failure point right now.`
          : "Map the most important dependencies and identify any risky single points of failure or missing infrastructure in my local stack.",
        tone: "neutral",
      },
    ];
  }, [graphNodes]);

  const evidenceSummary = useMemo(() => extractEvidence(steps), [steps]);
  const evidenceChips = useMemo(() => {
    const chips: string[] = [];
    if (evidenceSummary.services.size > 0) {
      chips.push(
        `${evidenceSummary.services.size} service${evidenceSummary.services.size === 1 ? "" : "s"} checked`,
      );
    }
    if (evidenceSummary.files.length > 0) {
      chips.push(
        `${evidenceSummary.files.length} file${evidenceSummary.files.length === 1 ? "" : "s"} read`,
      );
    }
    if (evidenceSummary.endpoints.length > 0) {
      chips.push(
        `${evidenceSummary.endpoints.length} request${evidenceSummary.endpoints.length === 1 ? "" : "s"} inspected`,
      );
    }
    return chips;
  }, [evidenceSummary]);

  const activityItems = useMemo(() => {
    return steps
      .filter((step) => step.type === "tool_call" || step.type === "tool_result")
      .slice(-6)
      .map((step, index) => ({
        id: `${step.timestamp}-${index}`,
        title: step.tool ? step.tool.replace(/_/g, " ") : "Thinking",
        detail:
          step.tool && step.input
            ? formatToolInput(step.tool, step.input)
            : step.summary || step.message || "",
        complete: step.type === "tool_result",
      }));
  }, [steps]);

  const responseSections = useMemo(() => parseResponseSections(diagnosis), [diagnosis]);

  const beginInvestigation = useCallback(async (prompt: string, label: string) => {
    if (getRemainingCalls() <= 0) {
      setError("Daily limit reached. Try again tomorrow.");
      setPhase("complete");
      return;
    }

    pendingPromptRef.current = prompt.trim();
    pendingLabelRef.current = label.trim();
    setActiveLabel(label.trim());
    setSteps([]);
    setDiagnosis("");
    setError("");
    setPhase("running");

    const result = await window.electronAPI.debugStart({ problem: prompt.trim() });
    if (!result.success) {
      pendingPromptRef.current = "";
      pendingLabelRef.current = "";
      setError(result.error || "Failed to start investigation");
      setPhase("complete");
    }
  }, []);

  const handleClose = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("fere:debug-highlight-services", {
        detail: { nodeIds: [] },
      }),
    );
    onClose();
  }, [onClose]);

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

  useEffect(() => {
    window.electronAPI.debugGetApiKeyStatus().then((result) => {
      setHasApiKey(result.hasKey);
      if (!result.hasKey) setPhase("setup");
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onDebugProgress((progress: DebugProgress) => {
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
          break;
        case "complete":
          setDiagnosis(progress.diagnosis);
          incrementDailyUsage();
          pendingPromptRef.current = "";
          pendingLabelRef.current = "";
          setPhase("complete");
          break;
        case "error":
          pendingPromptRef.current = "";
          pendingLabelRef.current = "";
          setError(progress.error);
          setPhase("complete");
          break;
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (phase !== "complete" || !diagnosis) return;
    const nodeIds: string[] = [];
    for (const svc of Array.from(evidenceSummary.services.values())) {
      const node =
        nodeByName.get(svc.name.toLowerCase()) ||
        graphNodes.find((candidate) =>
          candidate.name.toLowerCase().includes(svc.name.toLowerCase()),
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
  }, [diagnosis, evidenceSummary.services, graphNodes, nodeByName, phase]);

  useEffect(() => {
    if (!initialProblemKey || !initialProblem) return;
    setSteps([]);
    setDiagnosis("");
    setError("");
    setActiveLabel(initialDisplayPrompt || "Investigation");
    pendingPromptRef.current = initialProblem;
    pendingLabelRef.current = initialDisplayPrompt || "Investigation";
    pendingAutoStartRef.current = initialAutoRun;
    setPhase("input");
  }, [initialAutoRun, initialDisplayPrompt, initialProblem, initialProblemKey]);

  useEffect(() => {
    if (!isOpen || !pendingAutoStartRef.current || !pendingPromptRef.current.trim()) return;
    pendingAutoStartRef.current = false;
    void beginInvestigation(
      pendingPromptRef.current,
      pendingLabelRef.current || "Investigation",
    );
  }, [beginInvestigation, isOpen]);

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
      setError("");
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

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [handleClose, isOpen]);

  if (!shouldRender || hasApiKey === null) return null;

  return (
    <div
      className={`debug-agent-shell${phase !== "input" ? " debug-agent-shell-with-results" : ""}${isClosing ? " debug-agent-shell-closing" : ""}`}
    >
      <div className="debug-agent-dock">
        {phase === "setup" && (
          <div className="debug-panel-setup debug-ai-launcher">
            <div className="debug-ai-launcher-header">
              <div className="debug-panel-title-wrap">
                <span className="debug-panel-title">Fere AI</span>
                <span className="debug-panel-subtitle">
                  Runtime-aware investigation for your local stack.
                </span>
              </div>
            </div>
            <p className="debug-panel-setup-text">
              Enter your OpenAI API key to enable Fere AI, or set <code>OPENAI_API_KEY</code> in the project root <code>.env</code>.
            </p>
            <input
              type="password"
              className="debug-panel-api-input"
              placeholder="sk-..."
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSaveApiKey();
              }}
              autoFocus
            />
            {apiKeyError ? <p className="debug-panel-error">{apiKeyError}</p> : null}
            <button className="debug-panel-submit" onClick={handleSaveApiKey}>
              Save Key
            </button>
          </div>
        )}

        {phase === "input" && hasApiKey && (
          <div className="debug-ai-launcher">
            <div className="debug-ai-launcher-header">
              <div className="debug-panel-title-wrap">
                <span className="debug-panel-title">Fere AI</span>
                <span className="debug-panel-subtitle">
                  Runtime-aware investigation for your local stack.
                </span>
              </div>
              <div className="debug-ai-launcher-kicker">One click. Evidence first.</div>
            </div>

            <div className="debug-ai-signal-grid">
              {stackSignals.map((signal) => (
                <div key={signal.label} className="debug-ai-signal-card">
                  <div className="debug-ai-signal-value">{signal.value}</div>
                  <div className="debug-ai-signal-label">{signal.label}</div>
                </div>
              ))}
            </div>

            <div className="debug-ai-quick-actions-grid">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={`debug-ai-quick-action-card debug-ai-quick-action-card-${action.tone}`}
                  onClick={() => void beginInvestigation(action.prompt, action.label)}
                >
                  <span className="debug-ai-quick-action-title">{action.label}</span>
                  <span className="debug-ai-quick-action-description">{action.description}</span>
                </button>
              ))}
            </div>

            <div className="debug-ai-launcher-footnote">
              Fere AI inspects the live topology, routes, dependencies, and source context for you. The prompt stays internal.
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="debug-agent-dock-status debug-agent-dock-status-minimal">
            <span>Investigating {activeLabel ? `- ${activeLabel}` : "your stack"}</span>
            <button
              className="debug-panel-stop"
              onClick={() => void window.electronAPI.debugStop()}
            >
              Stop
            </button>
          </div>
        )}
      </div>

      {phase !== "input" && (
        <div className="debug-panel debug-panel-inline debug-ai-results-shell">
          <div className="debug-panel-header">
            <div className="debug-panel-title-wrap">
              <span className="debug-panel-title">Fere AI</span>
              <span className="debug-panel-subtitle">
                {activeLabel || "Runtime investigation"}
              </span>
            </div>
            <button
              className="debug-panel-close"
              onClick={handleClose}
              title="Close Fere AI"
              aria-label="Close Fere AI"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
          </div>

          <div className="debug-panel-body debug-ai-results-body">
            <div className="debug-ai-summary-grid">
              <div className="debug-ai-summary-card debug-ai-summary-card-primary">
                <div className="debug-ai-summary-label">Assessment</div>
                <div className="debug-ai-summary-value">{activeLabel || "Runtime investigation"}</div>
              </div>
              {evidenceChips.map((chip) => (
                <div key={chip} className="debug-ai-summary-card">
                  <div className="debug-ai-summary-label">Evidence</div>
                  <div className="debug-ai-summary-value">{chip}</div>
                </div>
              ))}
            </div>

            {activityItems.length > 0 ? (
              <div className="debug-ai-activity-list">
                {activityItems.map((item) => (
                  <div key={item.id} className="debug-ai-activity-item">
                    <span className={`debug-ai-activity-dot${item.complete ? " debug-ai-activity-dot-complete" : ""}`} />
                    <div className="debug-ai-activity-copy">
                      <div className="debug-ai-activity-title">{item.title}</div>
                      {item.detail ? <div className="debug-ai-activity-detail">{item.detail}</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {(evidenceSummary.services.size > 0 ||
              evidenceSummary.files.length > 0 ||
              evidenceSummary.endpoints.length > 0) && (
              <div className="debug-ai-evidence-grid">
                {evidenceSummary.services.size > 0 && (
                  <section className="debug-ai-evidence-card">
                    <div className="debug-ai-evidence-title">Services inspected</div>
                    <div className="debug-ai-evidence-chip-row">
                      {Array.from(evidenceSummary.services.values()).map((service) => (
                        <button
                          key={service.name}
                          type="button"
                          className="debug-ai-evidence-chip"
                          onClick={() => handleServiceClick(service.name)}
                        >
                          {service.name}
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {evidenceSummary.files.length > 0 && (
                  <section className="debug-ai-evidence-card">
                    <div className="debug-ai-evidence-title">Files checked</div>
                    <div className="debug-ai-evidence-chip-row">
                      {evidenceSummary.files.slice(0, 8).map((file) => {
                        const fileRef = `${file.service}/${file.path}${file.line ? `:${file.line}` : ""}`;
                        return (
                          <button
                            key={fileRef}
                            type="button"
                            className="debug-ai-evidence-chip debug-ai-evidence-chip-file"
                            onClick={() => void handleFileClick(fileRef)}
                          >
                            {file.path}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {evidenceSummary.endpoints.length > 0 && (
                  <section className="debug-ai-evidence-card">
                    <div className="debug-ai-evidence-title">Requests checked</div>
                    <div className="debug-ai-evidence-chip-row">
                      {evidenceSummary.endpoints.slice(0, 6).map((endpoint) => (
                        <span key={`${endpoint.method}-${endpoint.url}`} className="debug-ai-evidence-chip debug-ai-evidence-chip-endpoint">
                          <strong>{endpoint.method}</strong>
                          <span>{endpoint.url}</span>
                        </span>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}

            {phase === "running" && !diagnosis && !error ? (
              <div className="debug-ai-empty-state">Gathering evidence from the running environment...</div>
            ) : null}

            {error ? <div className="debug-panel-error">{error}</div> : null}

            {responseSections.length > 0 ? (
              <div className="debug-ai-section-grid">
                {responseSections.map((section) => (
                  <section
                    key={section.title}
                    className={`debug-ai-section-card debug-ai-section-card-${getSectionTone(section.title)}`}
                  >
                    <div className="debug-ai-section-title">{section.title}</div>
                    <div className="debug-ai-section-content">
                      <ReactMarkdown
                        components={markdownComponents}
                        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                      >
                        {section.content}
                      </ReactMarkdown>
                    </div>
                  </section>
                ))}
              </div>
            ) : null}

            <div className="debug-ai-toolbar">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="debug-ai-toolbar-action"
                  onClick={() => void beginInvestigation(action.prompt, action.label)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
