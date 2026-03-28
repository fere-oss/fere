import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentCategory, AgentFinding, AgentFixAction, GraphNode } from "../types/electron";

const BACKGROUND_SCAN_INTERVAL_MS = 45000;
const TOPOLOGY_SCAN_DEBOUNCE_MS = 1200;

const FINDING_SEVERITY_ORDER: Record<AgentFinding["severity"], number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
};

function sortFindings(findings: AgentFinding[]): AgentFinding[] {
  return [...findings].sort((a, b) => {
    const severityDiff =
      FINDING_SEVERITY_ORDER[a.severity] - FINDING_SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    const blastRadiusDiff =
      (b.affectedServices?.length ?? 0) - (a.affectedServices?.length ?? 0);
    if (blastRadiusDiff !== 0) return blastRadiusDiff;
    return a.summary.localeCompare(b.summary);
  });
}

function AgentGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5 L13.5 4v4c0 3-2.5 5.2-5.5 6C5 13.2 2.5 11 2.5 8V4Z" />
      <path d="M5.8 8l1.5 1.5 3-3" />
    </svg>
  );
}

function CodeBlock({ code }: { code: string }) {
  const isYaml = /^[\w-]+:/m.test(code.trim());
  return (
    <pre className="agp-row-code">
      {code.split("\n").map((line, i) => {
        if (isYaml) {
          const m = line.match(/^(\s*)([\w-]+)(:)(.*)$/);
          if (m) {
            return (
              <span key={i}>
                {m[1]}
                <span style={{ color: "#0078d4" }}>{m[2]}</span>
                <span style={{ color: "#a3a3a3" }}>{m[3]}</span>
                <span style={{ color: "#525252" }}>{m[4]}</span>
                {"\n"}
              </span>
            );
          }
          const li = line.match(/^(\s*-\s*)(.*)/);
          if (li) {
            return (
              <span key={i}>
                <span style={{ color: "#a3a3a3" }}>{li[1]}</span>
                <span style={{ color: "#525252" }}>{li[2]}</span>
                {"\n"}
              </span>
            );
          }
        } else {
          const parts = line.split(/(\s+|\|)/);
          return (
            <span key={i}>
              {parts.map((part, j) => {
                if (j === 0) {
                  return (
                    <span key={j} style={{ color: "#0a0a0a", fontWeight: 500 }}>
                      {part}
                    </span>
                  );
                }
                if (part === "|") return <span key={j} style={{ color: "#0078d4" }}>{part}</span>;
                if (/^-/.test(part)) return <span key={j} style={{ color: "#a3a3a3" }}>{part}</span>;
                if (/^\d+$/.test(part.trim())) {
                  return <span key={j} style={{ color: "#d97706" }}>{part}</span>;
                }
                return <span key={j}>{part}</span>;
              })}
              {"\n"}
            </span>
          );
        }
        return <span key={i}>{line}{"\n"}</span>;
      })}
    </pre>
  );
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "#ef4444",
  warning: "#f59e0b",
  suggestion: "#a3a3a3",
};

const CATEGORY_META: Record<AgentCategory, { label: string; color: string; bg: string }> = {
  health: { label: "Health", color: "#dc2626", bg: "#fef2f2" },
  connectivity: { label: "Connectivity", color: "#7c3aed", bg: "#f5f3ff" },
  config: { label: "Config", color: "#b45309", bg: "#fffbeb" },
  security: { label: "Security", color: "#c2410c", bg: "#fff7ed" },
  dependency: { label: "Dependency", color: "#0369a1", bg: "#f0f9ff" },
};

const KW_COLORS = {
  keyword: "#d73a49",
  string: "#032f62",
  comment: "#6a737d",
  number: "#005cc5",
  decorator: "#e36209",
};

type TokenType = keyof typeof KW_COLORS;
type Token = { text: string; type?: TokenType };

const LANG_PATTERNS: Record<string, Array<[RegExp, TokenType]>> = {
  python: [
    [/#[^\n]*/g, "comment"],
    [/"""[\s\S]*?"""|'''[\s\S]*?'''|f?"[^"\n\\]*(?:\\.[^"\n\\]*)*"|f?'[^'\n\\]*(?:\\.[^'\n\\]*)*'/g, "string"],
    [/\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|self|try|while|with|yield)\b/g, "keyword"],
    [/@\w+/g, "decorator"],
    [/\b\d+\.?\d*\b/g, "number"],
  ],
  javascript: [
    [/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "comment"],
    [/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`/g, "string"],
    [/\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|with|yield)\b/g, "keyword"],
    [/\b\d+\.?\d*\b/g, "number"],
  ],
  yaml: [
    [/#[^\n]*/g, "comment"],
    [/"[^"]*"|'[^']*'/g, "string"],
    [/^\s*[\w-]+(?=\s*:)/gm, "keyword"],
    [/\b(true|false|null|yes|no)\b/g, "decorator"],
  ],
  json: [
    [/"[^"\\]*(?:\\.[^"\\]*)*"(?=\s*:)/g, "keyword"],
    [/"[^"\\]*(?:\\.[^"\\]*)*"/g, "string"],
    [/\b(true|false|null)\b/g, "decorator"],
    [/\b\d+\.?\d*\b/g, "number"],
  ],
  bash: [
    [/#[^\n]*/g, "comment"],
    [/"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'/g, "string"],
    [/\b(case|cd|chmod|cp|do|docker|done|echo|elif|else|esac|export|fi|for|function|git|grep|if|ls|mkdir|mv|npm|return|rm|source|sudo|then|while|yarn)\b/g, "keyword"],
    [/\$\{?\w+\}?/g, "decorator"],
  ],
};
LANG_PATTERNS.ts = LANG_PATTERNS.javascript;
LANG_PATTERNS.tsx = LANG_PATTERNS.javascript;
LANG_PATTERNS.jsx = LANG_PATTERNS.javascript;
LANG_PATTERNS.py = LANG_PATTERNS.python;
LANG_PATTERNS.sh = LANG_PATTERNS.bash;
LANG_PATTERNS.shell = LANG_PATTERNS.bash;
LANG_PATTERNS.yml = LANG_PATTERNS.yaml;

function tokenize(code: string, lang: string): Token[] {
  const patterns = LANG_PATTERNS[lang.toLowerCase()];
  if (!patterns) return [{ text: code }];
  const spans: Array<{ start: number; end: number; type: TokenType }> = [];
  for (const [rx, type] of patterns) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(code)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!spans.some((span) => span.start < end && span.end > start)) {
        spans.push({ start, end, type });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const tokens: Token[] = [];
  let pos = 0;
  for (const { start, end, type } of spans) {
    if (start > pos) tokens.push({ text: code.slice(pos, start) });
    tokens.push({ text: code.slice(start, end), type });
    pos = end;
  }
  if (pos < code.length) tokens.push({ text: code.slice(pos) });
  return tokens;
}

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const tokens = tokenize(code, lang);
  return (
    <>
      {tokens.map((token, i) =>
        token.type ? (
          <span key={i} style={{ color: KW_COLORS[token.type] }}>
            {token.text}
          </span>
        ) : (
          <span key={i}>{token.text}</span>
        ),
      )}
    </>
  );
}

function ActionRow({ action }: { action: AgentFixAction }) {
  const [state, setState] = useState<"idle" | "confirming" | "applying" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleApply = async () => {
    if (state === "idle") {
      setState("confirming");
      return;
    }
    setState("applying");
    try {
      const result = await window.electronAPI.agentApplyFix(action);
      if (result.success) setState("done");
      else {
        setErr(result.error ?? "Failed");
        setState("error");
      }
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : "Unknown");
      setState("error");
    }
  };

  const isWriteFile = action.type === "write-file";
  const previewContent =
    isWriteFile && action.content
      ? action.content.slice(0, 600) + (action.content.length > 600 ? "\n..." : "")
      : action.preview;
  const lang = isWriteFile && action.filePath ? action.filePath.split(".").pop() ?? "" : "";

  return (
    <div className="agp-action-row">
      {isWriteFile && action.filePath && (
        <div className="agp-action-filepath">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 2h5l3 3v5H2z" />
            <path d="M7 2v3h3" />
          </svg>
          <code>{action.filePath}</code>
        </div>
      )}
      {previewContent && (
        <pre className="agp-code-block agp-action-code">
          <code>
            <HighlightedCode code={previewContent} lang={lang} />
          </code>
        </pre>
      )}
      <div className="agp-row-actions">
        {state === "done" ? (
          <span className="agp-applied">{isWriteFile ? "File written" : "Applied"}</span>
        ) : state === "applying" ? (
          <span className="agp-muted-text">Applying...</span>
        ) : state === "error" ? (
          <span className="agp-error-text">{err}</span>
        ) : state === "confirming" ? (
          <>
            <span className="agp-muted-text">
              {isWriteFile ? `Write ${action.filePath?.split("/").pop()}?` : "Run this fix?"}
            </span>
            <button className="agp-btn agp-btn-confirm" onClick={handleApply}>Confirm</button>
            <button className="agp-btn agp-btn-ghost" onClick={() => setState("idle")}>Cancel</button>
          </>
        ) : (
          <>
            {action.type !== "copy-only" && (
              <button className="agp-btn agp-btn-primary" onClick={handleApply}>Apply Fix</button>
            )}
            {previewContent && (
              <button
                className="agp-btn agp-btn-ghost"
                onClick={() => {
                  navigator.clipboard.writeText(previewContent).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FindingRow({
  finding,
  isNew,
  onDismiss,
  onFocusService,
}: {
  finding: AgentFinding;
  isNew?: boolean;
  onDismiss: (id: string) => void;
  onFocusService: (finding: AgentFinding) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmState, setConfirmState] = useState<"idle" | "confirming" | "applying" | "done" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const fix = finding.fix;
  const canApply = fix && fix.type !== "copy-only";
  const catMeta = CATEGORY_META[finding.category] ?? CATEGORY_META.config;

  const handleCopy = () => {
    if (fix?.preview) navigator.clipboard.writeText(fix.preview).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleConfirm = async () => {
    if (!fix || fix.type === "copy-only") return;
    setConfirmState("applying");
    setApplyError(null);
    try {
      const result = await window.electronAPI.agentApplyFix(fix);
      if (result.success) setConfirmState("done");
      else {
        setApplyError(result.error ?? "Failed");
        setConfirmState("error");
      }
    } catch (error: unknown) {
      setApplyError(error instanceof Error ? error.message : "Unknown error");
      setConfirmState("error");
    }
  };

  return (
    <div className={`agp-row${expanded ? " agp-row-open" : ""}${isNew ? " agp-row-new" : ""}`}>
      <div className="agp-row-header" onClick={() => setExpanded((v) => !v)}>
        <span className="agp-dot" style={{ background: SEVERITY_DOT[finding.severity] }} />
        <div className="agp-row-text">
          <div className="agp-row-title-line">
            <span className="agp-row-title">{finding.summary}</span>
            {isNew && <span className="agp-new-chip">New</span>}
          </div>
          <div className="agp-row-meta">
            <span className="agp-row-service">{finding.service}</span>
            <span className="agp-cat-badge" style={{ color: catMeta.color, background: catMeta.bg }}>
              {catMeta.label}
            </span>
            {finding.affectedServices.length > 0 && (
              <span className="agp-impact-chip">{finding.affectedServices.length} affected</span>
            )}
          </div>
        </div>
        <svg className={`agp-chevron${expanded ? " agp-chevron-open" : ""}`} width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </div>
      {expanded && (
        <div className="agp-row-body">
          <p className="agp-row-detail">{finding.detail}</p>
          {finding.impact && (
            <div className="agp-row-impact">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 2v4l3 2" />
                <circle cx="6" cy="6" r="4.5" />
              </svg>
              {finding.impact}
            </div>
          )}
          {fix?.preview && <CodeBlock code={fix.preview} />}
          <div className="agp-row-actions">
            {confirmState === "done" ? (
              <span className="agp-applied">Applied</span>
            ) : confirmState === "applying" ? (
              <span className="agp-muted-text">Applying...</span>
            ) : confirmState === "error" ? (
              <span className="agp-error-text">{applyError}</span>
            ) : confirmState === "confirming" ? (
              <>
                <span className="agp-muted-text">Run this fix?</span>
                <button className="agp-btn agp-btn-confirm" onClick={handleConfirm}>Confirm</button>
                <button className="agp-btn agp-btn-ghost" onClick={() => setConfirmState("idle")}>Cancel</button>
              </>
            ) : (
              <>
                {canApply && <button className="agp-btn agp-btn-primary" onClick={() => setConfirmState("confirming")}>Apply Fix</button>}
                {fix?.preview && <button className="agp-btn agp-btn-ghost" onClick={handleCopy}>{copied ? "Copied" : "Copy"}</button>}
                <button className="agp-btn agp-btn-ghost" onClick={() => onFocusService(finding)}>
                  Focus Service
                </button>
                <button className="agp-btn agp-btn-ghost agp-btn-dismiss" onClick={() => onDismiss(finding.id)}>Dismiss</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentPanel({ nodes }: { nodes: GraphNode[] }) {
  const [open, setOpen] = useState(false);
  const [findings, setFindings] = useState<AgentFinding[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [newFindingIds, setNewFindingIds] = useState<string[]>([]);
  const latestActionableIdsRef = useRef<Set<string>>(new Set());
  const scanRequestIdRef = useRef(0);

  const nodeIdsForScan = useMemo(
    () => nodes.filter((node) => node.type !== "external").map((node) => node.id),
    [nodes],
  );
  const scanFingerprint = useMemo(
    () =>
      nodes
        .filter((node) => node.type !== "external")
        .map((node) => {
          const ports = (node.ports ?? [])
            .map((port) => port.port)
            .sort((a, b) => a - b)
            .join(",");
          return [
            node.id,
            node.name,
            node.healthStatus,
            node.containerState ?? "",
            node.isGhost ? "ghost" : "live",
            ports,
          ].join(":");
        })
        .sort()
        .join("|"),
    [nodes],
  );
  const hasScanned = useMemo(
    () => lastScanAt !== null || scanError !== null,
    [lastScanAt, scanError],
  );

  const criticalCount = findings.filter((finding) => finding.severity === "critical").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const suggestionCount = findings.filter((finding) => finding.severity === "suggestion").length;
  const totalIssues = criticalCount + warningCount;
  const unseenIssueCount = useMemo(
    () =>
      newFindingIds.filter((id) =>
        findings.some(
          (finding) => finding.id === id && finding.severity !== "suggestion",
        ),
      ).length,
    [findings, newFindingIds],
  );

  const healthScore = hasScanned
    ? Math.max(0, 100 - criticalCount * 15 - warningCount * 5 - suggestionCount)
    : null;
  const healthGrade =
    healthScore === null
      ? null
      : healthScore >= 90
        ? { label: "Excellent", color: "#16a34a" }
        : healthScore >= 75
          ? { label: "Good", color: "#65a30d" }
          : healthScore >= 60
            ? { label: "Fair", color: "#ca8a04" }
            : healthScore >= 40
              ? { label: "Poor", color: "#ea580c" }
              : { label: "Critical", color: "#dc2626" };

  const runScan = useCallback(async (source: "manual" | "background" = "manual") => {
    const requestId = scanRequestIdRef.current + 1;
    scanRequestIdRef.current = requestId;
    if (source === "manual") {
      setScanning(true);
      setScanError(null);
    }
    if (nodeIdsForScan.length === 0) {
      latestActionableIdsRef.current = new Set();
      setFindings([]);
      setNewFindingIds([]);
      setLastScanAt(Date.now());
      if (source === "manual") setScanning(false);
      return;
    }
    try {
      const result = await window.electronAPI.agentScan(nodeIdsForScan);
      if (requestId !== scanRequestIdRef.current) return;
      if (result.success) {
        const nextFindings = sortFindings(result.findings);
        const nextActionableIds = new Set(
          nextFindings
            .filter((finding) => finding.severity !== "suggestion")
            .map((finding) => finding.id),
        );
        if (source === "background" && !open) {
          const newlyDetected = Array.from(nextActionableIds).filter(
            (id) => !latestActionableIdsRef.current.has(id),
          );
          if (newlyDetected.length > 0) {
            setNewFindingIds((prev) => Array.from(new Set([...prev, ...newlyDetected])));
          }
        } else if (source === "manual") {
          setNewFindingIds([]);
        }
        latestActionableIdsRef.current = nextActionableIds;
        setFindings(nextFindings);
        setLastScanAt(Date.now());
        if (source === "manual") setScanError(null);
      } else {
        if (source === "manual") {
          setScanError(result.error ?? "Scan failed");
        }
      }
    } catch (error: unknown) {
      if (requestId !== scanRequestIdRef.current) return;
      if (source === "manual") {
        setScanError(error instanceof Error ? error.message : "Scan failed");
      }
    } finally {
      if (source === "manual" && requestId === scanRequestIdRef.current) {
        setScanning(false);
      }
    }
  }, [nodeIdsForScan, open]);

  useEffect(() => {
    if (!scanFingerprint) {
      latestActionableIdsRef.current = new Set();
      setFindings([]);
      setNewFindingIds([]);
      setLastScanAt(null);
      setScanError(null);
      return;
    }
    const timeout = window.setTimeout(
      () => void runScan("background"),
      hasScanned ? TOPOLOGY_SCAN_DEBOUNCE_MS : 0,
    );
    return () => window.clearTimeout(timeout);
  }, [hasScanned, runScan, scanFingerprint]);

  useEffect(() => {
    if (!scanFingerprint) return;
    const interval = window.setInterval(() => {
      void runScan("background");
    }, BACKGROUND_SCAN_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [runScan, scanFingerprint]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const handleFocusService = useCallback(
    (finding: AgentFinding) => {
      const target = nodes.find(
        (node) =>
          node.name === finding.service ||
          node.name.toLowerCase() === finding.service.toLowerCase() ||
          finding.affectedServices.includes(node.name),
      );
      if (!target) return;
      window.dispatchEvent(
        new CustomEvent("fere:focus-node", {
          detail: { nodeId: target.id, nodeName: target.name },
        }),
      );
    },
    [nodes],
  );

  const issues = findings.filter((finding) => finding.severity !== "suggestion");
  const suggestions = findings.filter((finding) => finding.severity === "suggestion");
  const clearNewFindings = useCallback(() => setNewFindingIds([]), []);
  const showIssueBadge = totalIssues > 0 && !open;
  const showUnreadDot = unseenIssueCount > 0 && !open && !showIssueBadge;
  const headerSubtext =
    scanning
      ? "Scanning the live runtime"
      : unseenIssueCount > 0
        ? `${unseenIssueCount} new issue${unseenIssueCount !== 1 ? "s" : ""} detected in background`
        : scanError
          ? "Scan failed"
          : totalIssues > 0
            ? `${totalIssues} actionable issue${totalIssues !== 1 ? "s" : ""}`
            : findings.length > 0
              ? `${findings.length} low-priority suggestion${findings.length !== 1 ? "s" : ""}`
              : hasScanned
                ? "All clear"
                : "Watching your stack";

  return (
    <>
      <button
        className={`agp-trigger-btn${open ? " agp-trigger-btn-active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="Open Sentinel"
      >
        <AgentGlyph className="agp-trigger-icon" />
        <span className="agp-trigger-label">Sentinel</span>
        {showUnreadDot && <span className="agp-trigger-ping" aria-hidden="true" />}
        {showIssueBadge && (
          <span
            className={`agp-trigger-badge${unseenIssueCount > 0 ? " agp-trigger-badge-unreviewed" : ""}`}
          >
            {totalIssues}
          </span>
        )}
      </button>

      {open && (
        <div className="agp-popup">
          <div className="agp-header">
            <div className="agp-header-left">
              <AgentGlyph className="agp-avatar-icon" />
              <div className="agp-header-text">
                <span className="agp-header-title">Sentinel</span>
                <span className="agp-header-sub">{headerSubtext}</span>
              </div>
            </div>
            <div className="agp-header-right">
              <button className="agp-scan-btn" onClick={() => void runScan()} disabled={scanning} title="Re-scan">
                <svg className={scanning ? "agp-spin" : ""} width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M7 2a5 5 0 1 1-3.54 1.46" />
                </svg>
              </button>
              <button className="agp-close" onClick={() => setOpen(false)}>×</button>
            </div>
          </div>

          <div className="agp-body">
            {scanning ? (
              <div className="agp-empty">
                <svg className="agp-spin" width="22" height="22" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M7 2a5 5 0 1 1-3.54 1.46" />
                </svg>
                <span>Scanning your stack...</span>
                <span className="agp-empty-sub">Checking health, dependencies, connectivity, and config drift</span>
              </div>
            ) : scanError ? (
              <div className="agp-empty">
                <span>{scanError}</span>
                <button className="agp-btn agp-btn-ghost" onClick={() => void runScan()}>Retry</button>
              </div>
            ) : findings.length === 0 ? (
              <div className="agp-findings">
                <div className="agp-empty agp-all-clear">
                  <div className="agp-clear-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8.5 12l2.5 2.5 4.5-4.5" />
                    </svg>
                  </div>
                  <span className="agp-clear-title">All systems nominal</span>
                  <span className="agp-empty-sub">No unhealthy services, missing dependencies, or obvious config drift detected</span>
                </div>
              </div>
            ) : (
              <div className="agp-findings">
                {unseenIssueCount > 0 && (
                  <div className="agp-watch-banner">
                    <div className="agp-watch-banner-copy">
                      <span className="agp-watch-dot" aria-hidden="true" />
                      <span className="agp-watch-banner-title">
                        {unseenIssueCount} new issue{unseenIssueCount !== 1 ? "s" : ""} detected in background
                      </span>
                    </div>
                    <button className="agp-btn agp-btn-ghost" onClick={clearNewFindings}>
                      Mark reviewed
                    </button>
                  </div>
                )}

                {healthScore !== null && healthGrade !== null && (
                  <div className="agp-score-bar">
                    <div className="agp-score-header">
                      <span className="agp-score-label">Environment Health</span>
                      <span className="agp-score-value" style={{ color: healthGrade.color }}>
                        {healthScore}% — {healthGrade.label}
                      </span>
                    </div>
                    <div className="agp-score-track">
                      <div className="agp-score-fill" style={{ width: `${healthScore}%`, background: healthGrade.color }} />
                    </div>
                    <div className="agp-score-counts">
                      {criticalCount > 0 && <span className="agp-count-chip agp-count-critical">{criticalCount} critical</span>}
                      {warningCount > 0 && <span className="agp-count-chip agp-count-warning">{warningCount} warning{warningCount !== 1 ? "s" : ""}</span>}
                      {suggestionCount > 0 && <span className="agp-count-chip agp-count-suggestion">{suggestionCount} suggestion{suggestionCount !== 1 ? "s" : ""}</span>}
                    </div>
                  </div>
                )}

                {issues.length > 0 && (
                  <div className="agp-section">
                    <span className="agp-section-label">Issues</span>
                    {issues.map((finding) => (
                      <FindingRow
                        key={finding.id}
                        finding={finding}
                        isNew={newFindingIds.includes(finding.id)}
                        onDismiss={(id) => setFindings((prev) => prev.filter((item) => item.id !== id))}
                        onFocusService={handleFocusService}
                      />
                    ))}
                  </div>
                )}

                {suggestions.length > 0 && (
                  <div className="agp-section">
                    <span className="agp-section-label">Suggestions</span>
                    {suggestions.map((finding) => (
                      <FindingRow
                        key={finding.id}
                        finding={finding}
                        isNew={newFindingIds.includes(finding.id)}
                        onDismiss={(id) => setFindings((prev) => prev.filter((item) => item.id !== id))}
                        onFocusService={handleFocusService}
                      />
                    ))}
                  </div>
                )}

                <div className="agp-empty-sub" style={{ textAlign: "left" }}>
                  Sentinel watches the live stack in the background, reacts to topology changes, and rescans on an interval. It is meant to catch concrete runtime drift that a general coding assistant cannot see from code alone.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
