import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { DebugProgress, GraphNode } from "../types/electron";

interface DebugPanelProps {
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

export function DebugPanel({ onClose, graphNodes }: DebugPanelProps) {
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
  const logRef = useRef<HTMLDivElement>(null);

  // Build lookup maps from graph nodes
  const serviceNameSet = useMemo(
    () => new Set(graphNodes.map((n) => n.name.toLowerCase())),
    [graphNodes],
  );

  const nodeByName = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const n of graphNodes) {
      map.set(n.name.toLowerCase(), n);
    }
    return map;
  }, [graphNodes]);

  // --- Service & file click handlers ---

  const handleServiceClick = useCallback(
    (serviceName: string) => {
      const node =
        nodeByName.get(serviceName.toLowerCase()) ||
        graphNodes.find((n) =>
          n.name.toLowerCase().includes(serviceName.toLowerCase()),
        );
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
    [graphNodes, nodeByName],
  );

  const handleFileClick = useCallback(
    (fileRef: string) => {
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

      if (node?.projectPath && relPath) {
        window.electronAPI.openInEditor(
          `${node.projectPath}/${relPath}`,
          line,
        );
      } else {
        window.electronAPI.openInEditor(pathPart, line);
      }
    },
    [graphNodes, nodeByName],
  );

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
        if (serviceNameSet.has(text.toLowerCase())) {
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

        return <code>{text}</code>;
      },
    }),
    [serviceNameSet, handleServiceClick, handleFileClick],
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
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [handleClose]);

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
          case "complete":
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
    setPhase("running");
    const result = await window.electronAPI.debugStart({ problem: trimmed });
    if (!result.success) {
      setError(result.error || "Failed to start investigation");
      setPhase("complete");
    }
  }, [problem]);

  const handleStop = useCallback(async () => {
    await window.electronAPI.debugStop();
    setPhase("complete");
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(diagnosis).then(() => {
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
    setPhase("running");
    const result = await window.electronAPI.debugFollowUp({ message: trimmed });
    if (!result.success) {
      setError(result.error || "Failed to send follow-up");
      setPhase("complete");
    }
  }, [followUpInput]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleStart();
      }
    },
    [handleStart],
  );

  const handleFollowUpKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleFollowUp();
      }
    },
    [handleFollowUp],
  );

  // Loading state
  if (hasApiKey === null) return null;

  // Track iteration changes for markers
  let lastIteration = 0;

  // Evidence data for complete phase
  const evidence =
    phase === "complete" && diagnosis ? extractEvidence(steps) : null;

  return (
    <div className="debug-panel">
      <div className="debug-panel-header">
        <span className="debug-panel-title">Debug Agent</span>
        <button className="debug-panel-close" onClick={handleClose}>
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
        {/* Setup Phase */}
        {phase === "setup" && (
          <div className="debug-panel-setup">
            <p className="debug-panel-setup-text">
              Enter your OpenAI API key to enable the debug agent, or set{" "}
              <code>OPENAI_API_KEY</code> in the project root <code>.env</code>.
              Your key is stored locally and never sent to the renderer.
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
            {apiKeyError && (
              <p className="debug-panel-error">{apiKeyError}</p>
            )}
            <button
              className="debug-panel-submit"
              onClick={handleSaveApiKey}
              disabled={!apiKeyInput.trim()}
            >
              Save Key
            </button>
          </div>
        )}

        {/* Input Phase */}
        {phase === "input" && (
          <div className="debug-panel-input">
            <label className="debug-panel-label">Describe the issue:</label>
            <textarea
              className="debug-panel-textarea"
              placeholder="My checkout endpoint returns 500 sometimes when multiple users order at the same time..."
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
              autoFocus
            />
            <button
              className="debug-panel-submit"
              onClick={handleStart}
              disabled={!problem.trim()}
            >
              Investigate
            </button>
          </div>
        )}

        {/* Running + Complete Phases */}
        {(phase === "running" || phase === "complete") && (
          <>
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

            {/* Running: Stop button */}
            {phase === "running" && (
              <div className="debug-panel-actions">
                <button className="debug-panel-stop" onClick={handleStop}>
                  Stop Investigation
                </button>
              </div>
            )}

            {/* Complete: Diagnosis + Evidence + Follow-up */}
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

                {/* Evidence bar */}
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
                            {evidence.files.map((f, i) => (
                              <button
                                key={i}
                                className="debug-chip debug-chip-file"
                                onClick={() =>
                                  handleFileClick(
                                    `${f.service}/${f.path}${f.line ? `:${f.line}` : ""}`,
                                  )
                                }
                                title={`${f.service}/${f.path}`}
                              >
                                {f.path.split("/").pop()}
                                {f.line && (
                                  <span className="debug-chip-line">
                                    :{f.line}
                                  </span>
                                )}
                              </button>
                            ))}
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

                {/* Follow-up input (only when we have a diagnosis, not an error) */}
                {diagnosis && !error && (
                  <div className="debug-panel-followup">
                    <textarea
                      className="debug-panel-followup-textarea"
                      placeholder='Ask a follow-up... (e.g. "check Redis instead", "try this payload: {...}")'
                      value={followUpInput}
                      onChange={(e) => setFollowUpInput(e.target.value)}
                      onKeyDown={handleFollowUpKeyDown}
                      rows={2}
                      autoFocus
                    />
                    <button
                      className="debug-panel-submit"
                      onClick={handleFollowUp}
                      disabled={!followUpInput.trim()}
                    >
                      Send
                    </button>
                  </div>
                )}

                <div className="debug-panel-actions">
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
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
