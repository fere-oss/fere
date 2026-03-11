import React, { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { GraphEdge, GraphNode, QueryProgress } from "../types/electron";

interface StackQueryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  initialQuery?: string;
  initialQueryKey?: number;
  initialServiceName?: string;
}

interface OptimizationHint {
  text: string;
  serviceName?: string;
}

export function StackQueryPanel({
  isOpen,
  onClose,
  graphNodes,
  graphEdges,
  initialQuery,
  initialQueryKey,
  initialServiceName,
}: StackQueryPanelProps) {
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [references, setReferences] = useState<{
    services?: string[];
    ports?: number[];
    routes?: Array<{ serviceName: string; method: string; path: string }>;
    projects?: string[];
  } | null>(null);
  const [optimizationSignals, setOptimizationSignals] = useState<
    Array<{ text: string; serviceName?: string }>
  >([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const pendingAutoSubmitRef = React.useRef(false);

  const normalizeServiceToken = useCallback((value: string) => {
    return value
      .trim()
      .replace(/^`+|`+$/g, "")
      .replace(/^@+/, "")
      .replace(/^[([{"']+|[)\]}",.!?:;'"]+$/g, "")
      .toLowerCase();
  }, []);

  const optimizationHints = React.useMemo<OptimizationHint[]>(() => {
    const hints: OptimizationHint[] = [];
    const duplicateBuckets = new Map<
      string,
      { name: string; count: number; active: number; project?: string }
    >();

    for (const node of graphNodes) {
      if (node.type === "external") continue;

      const memory = Number(node.memory || 0);
      const cpu = Number(node.cpu || 0);
      const health = node.healthStatus || "unknown";
      const project =
        node.project ||
        node.projectPath?.split("/").pop() ||
        node.repoPath?.split("/").pop();

      if (health === "yellow" && memory >= 5) {
        hints.push({
          text: `${node.name} is idle but using ${memory.toFixed(1)}% memory${
            project ? ` in ${project}` : ""
          }.`,
          serviceName: node.name,
        });
      } else if (cpu >= 20 || memory >= 12) {
        hints.push({
          text: `${node.name} is resource-heavy right now (cpu ${cpu.toFixed(
            1,
          )}%, memory ${memory.toFixed(1)}%)${project ? ` in ${project}` : ""}.`,
          serviceName: node.name,
        });
      }

      const duplicateKey = `${(project || "global").toLowerCase()}::${node.name.toLowerCase()}`;
      const existing = duplicateBuckets.get(duplicateKey) || {
        name: node.name,
        count: 0,
        active: 0,
        project,
      };
      existing.count += 1;
      if (health === "green") existing.active += 1;
      duplicateBuckets.set(duplicateKey, existing);
    }

    for (const bucket of Array.from(duplicateBuckets.values())) {
      if (bucket.count < 2) continue;
      hints.push({
        text: `${bucket.count} instances of ${bucket.name} are visible${
          bucket.project ? ` in ${bucket.project}` : ""
        } (${bucket.active} active).`,
        serviceName: bucket.name,
      });
    }

    return hints.slice(0, 6);
  }, [graphNodes]);

  const findServiceNode = useCallback(
    (serviceToken: string) => {
      const normalized = normalizeServiceToken(serviceToken);
      if (!normalized) return undefined;
      return graphNodes.find(
        (node) =>
          node.type !== "external" &&
          (node.name.toLowerCase() === normalized ||
            node.name.toLowerCase().includes(normalized)),
      );
    },
    [graphNodes, normalizeServiceToken],
  );

  const handleServiceClick = useCallback(
    (serviceName: string) => {
      const node = findServiceNode(serviceName);
      if (!node) return;
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

  const handlePortClick = useCallback(
    (port: number) => {
      const node = graphNodes.find(
        (candidate) =>
          candidate.type !== "external" &&
          (candidate.ports || []).some((entry) => entry.port === port),
      );
      if (!node) return;
      handleServiceClick(node.name);
    },
    [graphNodes, handleServiceClick],
  );

  const handleRouteClick = useCallback(
    (serviceName: string, routePath: string) => {
      const node =
        findServiceNode(serviceName) ||
        graphNodes.find(
          (candidate) =>
            candidate.type !== "external" &&
            (candidate.routes || []).some((route) => route.path === routePath),
        );
      if (!node) return;
      handleServiceClick(node.name);
    },
    [findServiceNode, graphNodes, handleServiceClick],
  );

  const handleProjectClick = useCallback(
    (projectName: string) => {
      const matched = graphNodes.filter((node) => {
        if (node.type === "external") return false;
        const labels = [
          node.project,
          node.projectPath?.split("/").pop(),
          node.repoPath?.split("/").pop(),
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase());
        return labels.includes(projectName.toLowerCase());
      });
      if (matched.length === 0) return;
      window.dispatchEvent(
        new CustomEvent("fere:debug-highlight-services", {
          detail: { nodeIds: matched.map((node) => node.id) },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("fere:debug-focus-node", {
          detail: { nodeId: matched[0].id },
        }),
      );
    },
    [graphNodes],
  );

  useEffect(() => {
    window.electronAPI.debugGetApiKeyStatus().then((result) => {
      setHasApiKey(result.hasKey);
    });
  }, []);

  useEffect(() => {
    if (!initialQueryKey || !initialQuery) return;
    setQuery(initialQuery);
    setAnswer("");
    setReferences(null);
    setOptimizationSignals([]);
    setError("");
    setLoading(false);
    pendingAutoSubmitRef.current = true;
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const length = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(length, length);
    });
  }, [initialQuery, initialQueryKey]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onQueryProgress(
      (progress: QueryProgress) => {
        switch (progress.type) {
          case "thinking":
            setLoading(true);
            setAnswer("");
            setReferences(null);
            setOptimizationSignals([]);
            setError("");
            break;
          case "answer_delta":
            setAnswer((prev) => prev + progress.text);
            break;
          case "complete":
            setAnswer(progress.answer);
            setReferences(progress.references || null);
            setOptimizationSignals(progress.optimizationSignals || []);
            setLoading(false);
            break;
          case "error":
            setError(progress.error);
            setLoading(false);
            break;
        }
      },
    );
    return unsubscribe;
  }, []);

  const handleSaveApiKey = useCallback(async () => {
    setApiKeyError("");
    const trimmed = apiKeyInput.trim();
    if (!trimmed || trimmed.length < 10) {
      setApiKeyError("Please enter a valid API key");
      return;
    }

    const result = await window.electronAPI.debugSetApiKey(trimmed);
    if (!result.success) {
      setApiKeyError(result.error || "Failed to save API key");
      return;
    }

    setHasApiKey(true);
  }, [apiKeyInput]);

  const handleSubmit = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    pendingAutoSubmitRef.current = false;
    setAnswer("");
    setReferences(null);
    setOptimizationSignals([]);
    setError("");
    setLoading(true);
    const result = await window.electronAPI.queryStart({
      query: trimmed,
      graphSnapshot: {
        nodes: graphNodes,
        edges: graphEdges,
      },
    });
    if (!result.success) {
      setError(result.error || "Failed to start query");
      setLoading(false);
    }
  }, [graphEdges, graphNodes, query]);

  useEffect(() => {
    if (!isOpen || !hasApiKey || !pendingAutoSubmitRef.current || loading) return;
    if (!query.trim()) return;
    handleSubmit();
  }, [handleSubmit, hasApiKey, isOpen, loading, query]);

  const handleClose = useCallback(() => {
    window.electronAPI.queryStop();
    onClose();
  }, [onClose]);

  const markdownComponents = {
    code({
      children,
      className,
    }: {
      children?: React.ReactNode;
      className?: string;
    }) {
      if (className) return <code className={className}>{children}</code>;
      const text = String(children).replace(/\n$/, "");
      const node = findServiceNode(text);
      if (!node) return <code>{text}</code>;
      return (
        <span
          className="debug-clickable-service"
          onClick={() => handleServiceClick(node.name)}
          title={`Focus ${node.name} on graph`}
        >
          {text}
        </span>
      );
    },
    a({
      href,
      children,
    }: {
      href?: string;
      children?: React.ReactNode;
    }) {
      const label = String(children ?? "").replace(/\n/g, " ").trim();
      const node = findServiceNode(label) || findServiceNode(href || "");
      if (!node) {
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
        <a
          href={href || "#"}
          className="debug-clickable-service debug-markdown-service-link"
          onClick={(e) => {
            e.preventDefault();
            handleServiceClick(node.name);
          }}
          title={`Focus ${node.name} on graph`}
        >
          {children}
        </a>
      );
    },
  };

  if (!isOpen || hasApiKey === null) return null;

  return (
    <div className="stack-query-panel">
      <div className="stack-query-panel-header">
        <div className="stack-query-panel-title-wrap">
          <div className="stack-query-panel-title">Ask Fere</div>
          <div className="stack-query-panel-subtitle">
            General stack questions
          </div>
          {initialServiceName ? (
            <div className="stack-query-panel-scope">
              Scoped to <span>{initialServiceName}</span>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="debug-panel-close stack-query-panel-close"
          onClick={handleClose}
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

      {!hasApiKey ? (
        <div className="debug-panel-setup">
          <p className="debug-panel-setup-text">
            Enter your OpenAI API key to enable stack queries.
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
          />
          {apiKeyError ? <p className="debug-panel-error">{apiKeyError}</p> : null}
          <button
            className="debug-panel-submit"
            onClick={handleSaveApiKey}
            disabled={!apiKeyInput.trim()}
          >
            Save Key
          </button>
        </div>
      ) : (
        <>
          <div className="stack-query-panel-composer">
            <textarea
              ref={textareaRef}
              className="stack-query-panel-textarea"
              placeholder="What is using port 3001? What depends on Redis? Which services are idle?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              rows={3}
            />
            <div className="stack-query-panel-footer">
              <div className="stack-query-panel-suggestions">
                <button
                  type="button"
                  className="stack-query-panel-suggestion"
                  onClick={() => setQuery("What is using port 3001?")}
                >
                  Port 3001
                </button>
                <button
                  type="button"
                  className="stack-query-panel-suggestion"
                  onClick={() => setQuery("What depends on Redis?")}
                >
                  Redis deps
                </button>
                <button
                  type="button"
                  className="stack-query-panel-suggestion"
                  onClick={() => setQuery("Which services are idle right now?")}
                >
                  Idle services
                </button>
              </div>
              <button
                type="button"
                className="debug-panel-submit stack-query-panel-submit"
                onClick={handleSubmit}
                disabled={!query.trim() || loading}
              >
                Ask
              </button>
            </div>
          </div>

          {loading ? <div className="stack-query-panel-status">Thinking…</div> : null}
          {error ? <div className="debug-panel-error">{error}</div> : null}

          {(optimizationSignals.length > 0 ||
            (!answer && !loading && !error && optimizationHints.length > 0)) ? (
            <div className="stack-query-panel-optimizations">
              <div className="stack-query-panel-reference-label">
                Optimization Signals
              </div>
              <div className="stack-query-panel-optimization-list">
                {(optimizationSignals.length > 0
                  ? optimizationSignals
                  : optimizationHints
                ).map((signal) => (
                  <button
                    key={signal.text}
                    type="button"
                    className={`stack-query-panel-optimization-card${
                      signal.serviceName ? " stack-query-panel-optimization-card-actionable" : ""
                    }`}
                    onClick={() =>
                      signal.serviceName ? handleServiceClick(signal.serviceName) : undefined
                    }
                    disabled={!signal.serviceName}
                  >
                    <span>{signal.text}</span>
                    {signal.serviceName ? (
                      <span className="stack-query-panel-optimization-action">
                        Focus
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {answer ? (
            <>
              <div className="stack-query-panel-answer">
                <ReactMarkdown components={markdownComponents}>
                  {answer}
                </ReactMarkdown>
              </div>
              {references &&
              ((references.services && references.services.length > 0) ||
                (references.ports && references.ports.length > 0) ||
                (references.routes && references.routes.length > 0) ||
                (references.projects && references.projects.length > 0)) ? (
                <div className="stack-query-panel-references">
                  {references.services && references.services.length > 0 ? (
                    <div className="stack-query-panel-reference-group">
                      <span className="stack-query-panel-reference-label">
                        Services
                      </span>
                      <div className="stack-query-panel-reference-chips">
                        {references.services.map((service) => (
                          <button
                            key={service}
                            type="button"
                            className="stack-query-panel-chip"
                            onClick={() => handleServiceClick(service)}
                          >
                            {service}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {references.ports && references.ports.length > 0 ? (
                    <div className="stack-query-panel-reference-group">
                      <span className="stack-query-panel-reference-label">
                        Ports
                      </span>
                      <div className="stack-query-panel-reference-chips">
                        {references.ports.map((port) => (
                          <button
                            key={port}
                            type="button"
                            className="stack-query-panel-chip stack-query-panel-chip-mono"
                            onClick={() => handlePortClick(port)}
                          >
                            :{port}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {references.routes && references.routes.length > 0 ? (
                    <div className="stack-query-panel-reference-group">
                      <span className="stack-query-panel-reference-label">
                        Routes
                      </span>
                      <div className="stack-query-panel-reference-chips">
                        {references.routes.map((route) => (
                          <button
                            key={`${route.serviceName}:${route.method}:${route.path}`}
                            type="button"
                            className="stack-query-panel-chip stack-query-panel-chip-route"
                            onClick={() =>
                              handleRouteClick(route.serviceName, route.path)
                            }
                          >
                            <span className="stack-query-panel-chip-method">
                              {route.method}
                            </span>
                            <span>{route.path}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {references.projects && references.projects.length > 0 ? (
                    <div className="stack-query-panel-reference-group">
                      <span className="stack-query-panel-reference-label">
                        Projects
                      </span>
                      <div className="stack-query-panel-reference-chips">
                        {references.projects.map((project) => (
                          <button
                            key={project}
                            type="button"
                            className="stack-query-panel-chip"
                            onClick={() => handleProjectClick(project)}
                          >
                            {project}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
