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

export function DebugPanel({ isOpen, onClose, graphNodes }: DebugPanelProps) {
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
  const [problemCaret, setProblemCaret] = useState(0);
  const [followUpCaret, setFollowUpCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const problemInputRef = useRef<HTMLTextAreaElement>(null);
  const followUpInputRef = useRef<HTMLTextAreaElement>(null);
  const problemHighlightRef = useRef<HTMLDivElement>(null);
  const followUpHighlightRef = useRef<HTMLDivElement>(null);

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
    if (!activeMention) return [];
    const q = activeMention.query.toLowerCase();
    return mentionCandidates
      .filter((option) => option.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [activeMention, mentionCandidates]);

  useEffect(() => {
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

  // --- Lifecycle ---

  // Check API key on mount
  useEffect(() => {
    window.electronAPI.debugGetApiKeyStatus().then((result) => {
      setHasApiKey(result.hasKey);
      if (!result.hasKey) setPhase("setup");
    });
  }, []);

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
            // Clear any streamed text from the previous iteration — each
            // new iteration starts fresh; the final iteration's tokens stay.
            setDiagnosis("");
            setSteps((prev) => [
              ...prev,
              {
                type: "thinking",
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
                summary: progress.summary,
                iteration: progress.iteration,
                timestamp: Date.now(),
              },
            ]);
            break;
          case "diagnosis_delta":
            setDiagnosis((prev) => prev + progress.text);
            break;
          case "complete":
            // Authoritative final text — replaces any streamed partial content
            setDiagnosis(progress.diagnosis);
            setPhase("complete");
            break;
          case "error":
            setError(progress.error);
            setPhase("complete");
            break;
        }
      },
    );
    return unsubscribe;
  }, []);

  // Auto-scroll investigation log
  useEffect(() => {
    if (logRef.current && phase === "running") {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [steps, phase]);

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
    setSteps([]);
    setDiagnosis("");
    setError("");
    setFollowUpInput("");
    setIsResultsVisible(true);
    setPhase("running");
    const result = await window.electronAPI.debugStart({ problem: trimmed });
    if (!result.success) {
      setError(result.error || "Failed to start investigation");
      setPhase("complete");
    }
  }, [problem]);

  const handleStop = useCallback(async () => {
    await window.electronAPI.debugStop();
    setError("Investigation cancelled");
    setPhase("complete");
  }, []);

  const handleCopy = useCallback(() => {
    window.electronAPI.copyText(diagnosis).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [diagnosis]);

  const handleNewInvestigation = useCallback(() => {
    setSteps([]);
    setDiagnosis("");
    setError("");
    setFollowUpInput("");
    setProblem("");
    setIsResultsVisible(true);
    setPhase("input");
    window.dispatchEvent(
      new CustomEvent("fere:debug-highlight-services", {
        detail: { nodeIds: [] },
      }),
    );
  }, []);

  const handleFollowUp = useCallback(async () => {
    const trimmed = followUpInput.trim();
    if (!trimmed) return;
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
    setPhase("running");
    const result = await window.electronAPI.debugFollowUp({ message: trimmed });
    if (!result.success) {
      setError(result.error || "Failed to send follow-up");
      setPhase("complete");
    }
  }, [followUpInput]);

  const autoResizeTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el) return;
      const minHeight = 64;
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

  useEffect(() => {
    if (phase === "input") autoResizeTextarea(problemInputRef.current);
  }, [phase, problem, autoResizeTextarea]);

  useEffect(() => {
    if (phase === "complete" && diagnosis && !error) {
      autoResizeTextarea(followUpInputRef.current);
    }
  }, [phase, followUpInput, diagnosis, error, autoResizeTextarea]);

  // Loading / hidden state
  if (!isOpen || hasApiKey === null) return null;

  // Track iteration changes for markers
  let lastIteration = 0;

  // Evidence data for complete phase
  const evidence =
    phase === "complete" && diagnosis ? extractEvidence(steps) : null;
  const showResultsPanel =
    isResultsVisible && (phase === "running" || phase === "complete");
  const problemPlaceholder =
    "Ask Fere Agent to investigate an issue... (Shift+Enter for newline)";
  const followUpPlaceholder =
    'Ask a follow-up... (e.g. "check Redis instead", "try this payload: {...}")';

  return (
    <div
      className={`debug-agent-shell${showResultsPanel ? " debug-agent-shell-with-results" : ""}`}
    >
      <div className="debug-agent-dock">
        <div className="debug-agent-dock-header">
        </div>

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
            <div className="debug-panel-problem-summary">
              <span className="debug-panel-problem-label">Issue:</span>{" "}
              {problem}
            </div>

            {steps.length > 0 && (
              <div className="debug-panel-investigation" ref={logRef}>
                <div className="debug-panel-section-header">
                  Investigation Log
                </div>
                {steps.map((step, i) => {
                  if (step.type === "follow_up") {
                    return (
                      <div
                        className="debug-panel-step debug-panel-step-follow_up"
                        key={i}
                      >
                        <div className="debug-panel-followup-marker">
                          <span className="debug-panel-step-icon">
                            {"\u276F"}
                          </span>
                          <span className="debug-panel-step-text">
                            {step.message}
                          </span>
                        </div>
                      </div>
                    );
                  }

                  const showIterationMarker =
                    step.type === "thinking" &&
                    step.iteration !== lastIteration;
                  if (step.type === "thinking")
                    lastIteration = step.iteration;

                  return (
                    <div
                      className={`debug-panel-step debug-panel-step-${step.type}`}
                      key={i}
                    >
                      {showIterationMarker && (
                        <span className="debug-panel-iteration-marker">
                          #{step.iteration}
                        </span>
                      )}
                      {step.type === "thinking" && (
                        <div className="debug-panel-step-row">
                          <span className="debug-panel-step-icon debug-panel-thinking-dot">
                            {phase === "running" && i === steps.length - 1
                              ? "\u25CF"
                              : "\u25CB"}
                          </span>
                          <span className="debug-panel-step-text">
                            Thinking...
                          </span>
                        </div>
                      )}
                      {step.type === "tool_call" && (
                        <div className="debug-panel-step-row">
                          <span className="debug-panel-step-icon debug-panel-tool-icon">
                            {"\u25B6"}
                          </span>
                          <div className="debug-panel-step-detail">
                            <span className="debug-panel-tool-name">
                              {step.tool}
                            </span>
                            <span className="debug-panel-tool-input">
                              {step.tool &&
                                step.input &&
                                formatToolInput(step.tool, step.input)}
                            </span>
                          </div>
                        </div>
                      )}
                      {step.type === "tool_result" && (
                        <div className="debug-panel-step-row">
                          <span className="debug-panel-step-icon debug-panel-result-icon">
                            {"\u2190"}
                          </span>
                          <span className="debug-panel-step-text debug-panel-result-text">
                            {step.summary}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {phase === "running" && diagnosis && (
              <div className="debug-panel-diagnosis">
                <div className="debug-panel-section-header">Diagnosis</div>
                <div className="debug-panel-diagnosis-content debug-panel-diagnosis-streaming">
                  <ReactMarkdown components={markdownComponents}>
                    {diagnosis}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {phase === "complete" && (
              <>
                {error && (
                  <div className="debug-panel-diagnosis">
                    <div className="debug-panel-section-header">Error</div>
                    <div className="debug-panel-error">{error}</div>
                  </div>
                )}
                {diagnosis && (
                  <div className="debug-panel-diagnosis">
                    <div className="debug-panel-section-header">Diagnosis</div>
                    <div className="debug-panel-diagnosis-content">
                      <ReactMarkdown components={markdownComponents}>
                        {diagnosis}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}

                {evidence &&
                  (evidence.services.size > 0 ||
                    evidence.files.length > 0 ||
                    evidence.endpoints.length > 0) && (
                    <div className="debug-evidence">
                      {evidence.services.size > 0 && (
                        <div className="debug-evidence-section">
                          <span className="debug-evidence-label">
                            Services
                          </span>
                          <div className="debug-evidence-chips">
                            {Array.from(evidence.services.values()).map((svc) => (
                              <button
                                key={svc.name}
                                className="debug-chip debug-chip-service"
                                onClick={() => handleServiceClick(svc.name)}
                                title={`Tools used: ${svc.tools.join(", ")}`}
                              >
                                {svc.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {evidence.files.length > 0 && (
                        <div className="debug-evidence-section">
                          <span className="debug-evidence-label">Files</span>
                          <div className="debug-evidence-chips">
                            {evidence.files.map((f, i) => {
                              const ref = `${f.service}/${f.path}${f.line ? `:${f.line}` : ""}`;
                              const resolvable = canResolveFile(ref);
                              return (
                                <button
                                  key={i}
                                  className={`debug-chip debug-chip-file${resolvable ? "" : " debug-chip-disabled"}`}
                                  onClick={resolvable ? () => handleFileClick(ref) : undefined}
                                  title={resolvable ? `${f.service}/${f.path}` : `${f.service}/${f.path} (no project path)`}
                                  disabled={!resolvable}
                                >
                                  {f.path.split("/").pop()}
                                  {f.line && (
                                    <span className="debug-chip-line">
                                      :{f.line}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {evidence.endpoints.length > 0 && (
                        <div className="debug-evidence-section">
                          <span className="debug-evidence-label">
                            Endpoints
                          </span>
                          <div className="debug-evidence-chips">
                            {evidence.endpoints.map((ep, i) => {
                              let pathname: string;
                              try {
                                pathname = new URL(ep.url).pathname;
                              } catch {
                                pathname = ep.url;
                              }
                              return (
                                <button
                                  key={i}
                                  className="debug-chip debug-chip-endpoint"
                                  onClick={() =>
                                    navigator.clipboard.writeText(
                                      `${ep.method} ${ep.url}`,
                                    )
                                  }
                                  title="Click to copy"
                                >
                                  <span className="debug-chip-method">
                                    {ep.method}
                                  </span>
                                  {pathname}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
              </>
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
                  {diagnosis && (
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
