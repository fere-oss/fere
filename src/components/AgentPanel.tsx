import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { AgentCategory, AgentFinding, AgentFixAction, AgentStreamEvent, GraphNode } from "../types/electron";
import logo from "../assets/fere.png";

// ── Syntax highlighter ────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  const isYaml = /^[\w-]+:/m.test(code.trim());
  return (
    <pre className="agp-row-code">
      {code.split("\n").map((line, i) => {
        if (isYaml) {
          const m = line.match(/^(\s*)([\w-]+)(:)(.*)$/);
          if (m) return (
            <span key={i}>{m[1]}<span style={{ color: "#0078d4" }}>{m[2]}</span><span style={{ color: "#a3a3a3" }}>{m[3]}</span><span style={{ color: "#525252" }}>{m[4]}</span>{"\n"}</span>
          );
          const li = line.match(/^(\s*-\s*)(.*)/);
          if (li) return <span key={i}><span style={{ color: "#a3a3a3" }}>{li[1]}</span><span style={{ color: "#525252" }}>{li[2]}</span>{"\n"}</span>;
        } else {
          const parts = line.split(/(\s+|\|)/);
          return (
            <span key={i}>
              {parts.map((p, j) => {
                if (j === 0) return <span key={j} style={{ color: "#0a0a0a", fontWeight: 500 }}>{p}</span>;
                if (p === "|") return <span key={j} style={{ color: "#0078d4" }}>{p}</span>;
                if (/^-/.test(p)) return <span key={j} style={{ color: "#a3a3a3" }}>{p}</span>;
                if (/^\d+$/.test(p.trim())) return <span key={j} style={{ color: "#d97706" }}>{p}</span>;
                return <span key={j}>{p}</span>;
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

// ── Constants ─────────────────────────────────────────────────────────────────

const SEVERITY_DOT: Record<string, string> = {
  critical: "#ef4444",
  warning: "#f59e0b",
  suggestion: "#a3a3a3",
};

const CATEGORY_META: Record<AgentCategory, { label: string; color: string; bg: string }> = {
  health:       { label: "Health",       color: "#dc2626", bg: "#fef2f2" },
  connectivity: { label: "Connectivity", color: "#7c3aed", bg: "#f5f3ff" },
  config:       { label: "Config",       color: "#b45309", bg: "#fffbeb" },
  security:     { label: "Security",     color: "#c2410c", bg: "#fff7ed" },
  dependency:   { label: "Dependency",   color: "#0369a1", bg: "#f0f9ff" },
};

// ── Finding row ───────────────────────────────────────────────────────────────

function FindingRow({ finding, onDismiss, onInvestigate }: {
  finding: AgentFinding;
  onDismiss: (id: string) => void;
  onInvestigate: (finding: AgentFinding) => void;
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
      const result = await window.electronAPI.agentApplyFix(fix as AgentFixAction);
      if (result.success) setConfirmState("done");
      else { setApplyError(result.error ?? "Failed"); setConfirmState("error"); }
    } catch (err: unknown) {
      setApplyError(err instanceof Error ? err.message : "Unknown error");
      setConfirmState("error");
    }
  };

  return (
    <div className={`agp-row${expanded ? " agp-row-open" : ""}`}>
      <div className="agp-row-header" onClick={() => setExpanded((v) => !v)}>
        <span className="agp-dot" style={{ background: SEVERITY_DOT[finding.severity] }} />
        <div className="agp-row-text">
          <div className="agp-row-title-line">
            <span className="agp-row-title">{finding.summary}</span>
          </div>
          <div className="agp-row-meta">
            <span className="agp-row-service">{finding.service}</span>
            <span className="agp-cat-badge" style={{ color: catMeta.color, background: catMeta.bg }}>
              {catMeta.label}
            </span>
            {finding.affectedServices.length > 0 && (
              <span className="agp-impact-chip">
                {finding.affectedServices.length} affected
              </span>
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
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 2v4l3 2" /><circle cx="6" cy="6" r="4.5" /></svg>
              {finding.impact}
            </div>
          )}
          {fix?.preview && <CodeBlock code={fix.preview} />}
          <div className="agp-row-actions">
            {confirmState === "done" ? <span className="agp-applied">Applied</span>
              : confirmState === "applying" ? <span className="agp-muted-text">Applying...</span>
              : confirmState === "error" ? <span className="agp-error-text">{applyError}</span>
              : confirmState === "confirming" ? (
                <>
                  <span className="agp-muted-text">Run this fix?</span>
                  <button className="agp-btn agp-btn-confirm" onClick={handleConfirm}>Confirm</button>
                  <button className="agp-btn agp-btn-ghost" onClick={() => setConfirmState("idle")}>Cancel</button>
                </>
              ) : (
                <>
                  {canApply && <button className="agp-btn agp-btn-primary" onClick={() => setConfirmState("confirming")}>Apply Fix</button>}
                  {fix?.preview && <button className="agp-btn agp-btn-ghost" onClick={handleCopy}>{copied ? "Copied" : "Copy"}</button>}
                  <button className="agp-btn agp-btn-ghost" onClick={() => onInvestigate(finding)} style={{ color: "#0078d4", borderColor: "#0078d420" }}>
                    Ask AI
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

// ── Syntax highlighter ────────────────────────────────────────────────────────

const KW_COLORS = { keyword: "#d73a49", string: "#032f62", comment: "#6a737d", number: "#005cc5", decorator: "#e36209" };

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
      const s = m.index, e = s + m[0].length;
      if (!spans.some((x) => x.start < e && x.end > s)) spans.push({ start: s, end: e, type });
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
    <>{tokens.map((t, i) =>
      t.type
        ? <span key={i} style={{ color: KW_COLORS[t.type] }}>{t.text}</span>
        : <span key={i}>{t.text}</span>
    )}</>
  );
}

// ── Markdown + service-link renderer ─────────────────────────────────────────
// namePattern and nameToId are computed once via useMemo in AgentPanel and passed in.

type NameMap = { nameToId: Map<string, string>; pattern: RegExp | null };

function renderMarkdown(text: string, nm: NameMap): React.ReactNode {
  const { nameToId, pattern } = nm;

  function renderPlain(str: string): React.ReactNode[] {
    if (!pattern) return [str];
    const parts = str.split(pattern);
    return parts.map((part, i) => {
      const nodeId = nameToId.get(part) ?? nameToId.get(part.toLowerCase());
      if (nodeId) {
        return (
          <button key={i} className="agp-service-pill"
            onClick={() => window.dispatchEvent(new CustomEvent("fere:focus-node", { detail: { nodeId, nodeName: part } }))}>
            {part}
          </button>
        );
      }
      return part;
    });
  }

  function renderInline(str: string): React.ReactNode {
    const result: React.ReactNode[] = [];
    let rem = str;
    let k = 0;
    while (rem.length > 0) {
      const bold = rem.match(/^\*\*(.+?)\*\*/s);
      if (bold) { result.push(<strong key={k++}>{renderPlain(bold[1])}</strong>); rem = rem.slice(bold[0].length); continue; }
      const inlineCode = rem.match(/^`([^`\n]+)`/);
      if (inlineCode) { result.push(<code key={k++} className="agp-inline-code">{inlineCode[1]}</code>); rem = rem.slice(inlineCode[0].length); continue; }
      const next = rem.search(/\*\*|`/);
      if (next === -1) { result.push(...renderPlain(rem)); rem = ""; }
      else if (next > 0) { result.push(...renderPlain(rem.slice(0, next))); rem = rem.slice(next); }
      else {
        // next === 0 but pattern didn't match (unclosed marker) — emit the char and advance to avoid infinite loop
        const advance = rem.startsWith("**") ? 2 : 1;
        result.push(...renderPlain(rem.slice(0, advance)));
        rem = rem.slice(advance);
      }
    }
    return result.length === 1 ? result[0] : <React.Fragment>{result}</React.Fragment>;
  }

  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  const listItems: React.ReactNode[] = [];
  let bk = 0;
  let inFence = false;
  let fenceLang = "";
  const fenceLines: string[] = [];

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(<ol key={bk++} className="agp-md-list">{listItems.splice(0)}</ol>);
  };
  const flushFence = () => {
    if (!fenceLines.length) return;
    const codeStr = fenceLines.join("\n");
    blocks.push(
      <pre key={bk++} className="agp-code-block">
        {fenceLang && <span className="agp-code-lang">{fenceLang}</span>}
        <code><HighlightedCode code={codeStr} lang={fenceLang} /></code>
      </pre>
    );
    fenceLines.length = 0;
    fenceLang = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      if (!inFence) {
        flushList();
        inFence = true;
        fenceLang = line.trim().slice(3).trim();
      } else {
        inFence = false;
        flushFence();
      }
      continue;
    }
    if (inFence) { fenceLines.push(line); continue; }

    // Headings
    const h3 = line.match(/^###\s+(.*)/);
    if (h3) { flushList(); blocks.push(<p key={bk++} className="agp-md-h3">{renderInline(h3[1])}</p>); continue; }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) { flushList(); blocks.push(<p key={bk++} className="agp-md-h2">{renderInline(h2[1])}</p>); continue; }

    // Lists
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (numbered) { listItems.push(<li key={listItems.length}>{renderInline(numbered[1])}</li>); continue; }
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    if (bullet) { listItems.push(<li key={listItems.length}>{renderInline(bullet[1])}</li>); continue; }

    flushList();
    if (line.trim() === "") { if (blocks.length > 0) blocks.push(<div key={bk++} className="agp-md-gap" />); continue; }
    blocks.push(<p key={bk++} className="agp-md-p">{renderInline(line)}</p>);
  }
  flushList();
  if (inFence) flushFence(); // flush unclosed code block

  return <div className="agp-md">{blocks}</div>;
}

// ── Chat message types ────────────────────────────────────────────────────────

type UIMessage =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; streaming?: boolean }
  | { kind: "tool_call"; label: string; done?: boolean }
  | { kind: "action"; action: AgentFixAction };

function ToolCallRow({ label, done }: { label: string; done?: boolean }) {
  return (
    <div className={`agp-tool-call${done ? " agp-tool-call-done" : ""}`}>
      {done
        ? <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6l3 3 5-5" /></svg>
        : <svg className="agp-spin" width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M7 2a5 5 0 1 1-3.54 1.46" /></svg>
      }
      <span>{label}</span>
    </div>
  );
}

function ActionRow({ action }: { action: AgentFixAction }) {
  const [state, setState] = useState<"idle" | "confirming" | "applying" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleApply = async () => {
    if (state === "idle") { setState("confirming"); return; }
    setState("applying");
    try {
      const r = await window.electronAPI.agentApplyFix(action);
      if (r.success) setState("done"); else { setErr(r.error ?? "Failed"); setState("error"); }
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "Unknown"); setState("error"); }
  };

  const isWriteFile = action.type === "write-file";
  const previewContent = isWriteFile && action.content
    ? action.content.slice(0, 600) + (action.content.length > 600 ? "\n..." : "")
    : action.preview;
  const lang = isWriteFile && action.filePath
    ? (action.filePath.split(".").pop() ?? "")
    : "";

  return (
    <div className="agp-action-row">
      {isWriteFile && action.filePath && (
        <div className="agp-action-filepath">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2h5l3 3v5H2z" /><path d="M7 2v3h3" /></svg>
          <code>{action.filePath}</code>
        </div>
      )}
      {previewContent && (
        <pre className="agp-code-block agp-action-code">
          <code><HighlightedCode code={previewContent} lang={lang} /></code>
        </pre>
      )}
      <div className="agp-row-actions">
        {state === "done" ? <span className="agp-applied">{isWriteFile ? "File written" : "Applied"}</span>
          : state === "applying" ? <span className="agp-muted-text">Applying...</span>
          : state === "error" ? <span className="agp-error-text">{err}</span>
          : state === "confirming" ? (
            <>
              <span className="agp-muted-text">{isWriteFile ? `Write ${action.filePath?.split("/").pop()}?` : "Run this fix?"}</span>
              <button className="agp-btn agp-btn-confirm" onClick={handleApply}>Confirm</button>
              <button className="agp-btn agp-btn-ghost" onClick={() => setState("idle")}>Cancel</button>
            </>
          ) : (
            <>
              {action.type !== "copy-only" && <button className="agp-btn agp-btn-primary" onClick={handleApply}>Apply Fix</button>}
              {previewContent && (
                <button className="agp-btn agp-btn-ghost" onClick={() => { navigator.clipboard.writeText(previewContent).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1800); }}>
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
            </>
          )}
      </div>
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function AgentPanel({ nodes }: { nodes: GraphNode[] }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"findings" | "chat">("findings");
  const [findings, setFindings] = useState<AgentFinding[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [chatting, setChatting] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const hasScanned = useRef(false);
  const streamCleanup = useRef<(() => void) | null>(null);
  const chatHistoryRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const streamBufRef = useRef("");
  const rafRef = useRef<number | null>(null);

  // Build name→id map once when nodes change, not on every message render
  const nameMap = useMemo<NameMap>(() => {
    const nameToId = new Map<string, string>();
    for (const n of nodes) {
      if (!n.name) continue;
      nameToId.set(n.name, n.id);
      // Also register lowercase + short aliases: "robot-shop-rabbitmq-1" → "rabbitmq", "robot-shop-rabbitmq"
      const lower = n.name.toLowerCase();
      if (!nameToId.has(lower)) nameToId.set(lower, n.id);
      const parts = lower.split("-");
      // Strip trailing number and leading 2 segments (e.g. "robot-shop")
      if (parts.length >= 3) {
        const withoutNum = parts[parts.length - 1].match(/^\d+$/) ? parts.slice(0, -1) : parts;
        for (let i = 1; i < withoutNum.length; i++) {
          const candidate = withoutNum.slice(i).join("-");
          if (candidate.length > 2 && !nameToId.has(candidate)) nameToId.set(candidate, n.id);
        }
      }
    }
    const sorted = Array.from(nameToId.keys()).sort((a, b) => b.length - a.length);
    const pattern = sorted.length
      ? new RegExp(`(${sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi")
      : null;
    return { nameToId, pattern };
  }, [nodes]);

  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const suggestionCount = findings.filter((f) => f.severity === "suggestion").length;
  const totalIssues = criticalCount + warningCount;

  const healthScore = hasScanned.current
    ? Math.max(0, 100 - criticalCount * 15 - warningCount * 5 - suggestionCount * 1)
    : null;
  const healthGrade = healthScore === null ? null
    : healthScore >= 90 ? { label: "Excellent", color: "#16a34a" }
    : healthScore >= 75 ? { label: "Good", color: "#65a30d" }
    : healthScore >= 60 ? { label: "Fair", color: "#ca8a04" }
    : healthScore >= 40 ? { label: "Poor", color: "#ea580c" }
    : { label: "Critical", color: "#dc2626" };

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await window.electronAPI.agentScan(nodes.map((n) => n.id));
      if (result.success) setFindings(result.findings);
      else setScanError(result.error ?? "Scan failed");
    } catch (err: unknown) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }, [nodes]);

  useEffect(() => {
    if (open && !hasScanned.current) {
      hasScanned.current = true;
      runScan();
    }
  }, [open, runScan]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Register stream listener once
  useEffect(() => {
    const flushStreamBuf = () => {
      rafRef.current = null;
      const chunk = streamBufRef.current;
      if (!chunk) return;
      streamBufRef.current = "";
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind === "agent" && last.streaming) {
          return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
        }
        return [...prev, { kind: "agent", text: chunk, streaming: true }];
      });
    };

    const cleanup = window.electronAPI.onAgentStream((event: AgentStreamEvent) => {
      if (event.type === "text_delta") {
        streamBufRef.current += event.text;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(flushStreamBuf);
        }
      } else if (event.type === "tool_call") {
        setMessages((prev) => [...prev, { kind: "tool_call", label: event.label, done: false }]);
      } else if (event.type === "tool_result") {
        // Mark the last unfinished tool_call as done
        setMessages((prev) => {
          const idx = [...prev].reverse().findIndex((m) => m.kind === "tool_call" && !m.done);
          if (idx === -1) return prev;
          const realIdx = prev.length - 1 - idx;
          const updated = [...prev];
          updated[realIdx] = { ...updated[realIdx], kind: "tool_call", done: true } as UIMessage;
          return updated;
        });
      } else if (event.type === "action") {
        setMessages((prev) => [...prev, { kind: "action", action: event.action as AgentFixAction }]);
      } else if (event.type === "done") {
        // Flush any remaining buffered text synchronously before marking done
        if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        const remaining = streamBufRef.current;
        streamBufRef.current = "";
        setChatting(false);
        // Mark last agent message as no longer streaming, record to history
        setMessages((prev) => {
          const withRemaining = remaining
            ? (() => { const last = prev[prev.length - 1]; return last?.kind === "agent" && last.streaming ? [...prev.slice(0, -1), { ...last, text: last.text + remaining }] : prev; })()
            : prev;
          const updated = withRemaining.map((m, i) =>
            i === withRemaining.length - 1 && m.kind === "agent" ? { ...m, streaming: false } : m
          );
          const lastAgent = Array.from(updated).reverse().find((m) => m.kind === "agent");
          if (lastAgent?.kind === "agent") {
            chatHistoryRef.current.push({ role: "assistant", content: lastAgent.text });
          }
          return updated;
        });
      } else if (event.type === "error") {
        setChatting(false);
        setMessages((prev) => [...prev, { kind: "agent", text: `Error: ${event.error}` }]);
      }
    });
    streamCleanup.current = cleanup;
    return () => { cleanup(); if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatting) return;

    chatHistoryRef.current.push({ role: "user", content: trimmed });
    setMessages((prev) => [...prev, { kind: "user", text: trimmed }]);
    setChatInput("");
    setChatting(true);
    setTab("chat");

    await window.electronAPI.agentChat({
      messages: chatHistoryRef.current,
      nodeIds: nodes.map((n) => n.id),
    });
  }, [chatting, nodes]);

  const handleInvestigate = useCallback((finding: AgentFinding) => {
    const prompt = `Investigate this issue and fix it if you can: "${finding.summary}" on ${finding.service}. ${finding.detail}`;
    sendMessage(prompt);
  }, [sendMessage]);

  const handleStop = () => {
    window.electronAPI.agentStopChat();
    setChatting(false);
  };

  const handleInputChange = (val: string) => {
    setChatInput(val);
    // Detect @mention: find the last @ and extract query after it
    const atIdx = val.lastIndexOf("@");
    if (atIdx !== -1 && (atIdx === 0 || val[atIdx - 1] === " ")) {
      setMentionQuery(val.slice(atIdx + 1).toLowerCase());
    } else {
      setMentionQuery(null);
    }
  };

  const mentionMatches = mentionQuery !== null
    ? nodes.filter((n) => n.name.toLowerCase().includes(mentionQuery)).slice(0, 6)
    : [];

  const selectMention = (node: GraphNode) => {
    // Replace @query with the service name
    const atIdx = chatInput.lastIndexOf("@");
    const before = chatInput.slice(0, atIdx);
    // Build rich context snippet to inject into the message
    const portList = (node.ports ?? []).map((p) => p.port).join(", ") || "none";
    const context = `[Service context: ${node.name} | type: ${node.type} | health: ${node.healthStatus} | ports: ${portList}${node.projectPath ? ` | path: ${node.projectPath}` : ""}]`;
    setChatInput(`${before}${node.name} ${context} `);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  const issues = findings.filter((f) => f.severity !== "suggestion");
  const suggestions = findings.filter((f) => f.severity === "suggestion");

  return (
    <>
      {/* Trigger button — lives in top-right alongside header */}
      <button
        className={`agp-trigger-btn${open ? " agp-trigger-btn-active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Fere Agent"
      >
        <img src={logo} alt="Fere" className="agp-trigger-logo" />
        {totalIssues > 0 && !open && (
          <span className="agp-trigger-badge">{totalIssues}</span>
        )}
      </button>

      {/* Popup */}
      {open && (
        <div className="agp-popup">
          {/* Header */}
          <div className="agp-header">
            <div className="agp-header-left">
              <img src={logo} alt="Fere" className="agp-avatar-logo" />
              <div className="agp-header-text">
                <span className="agp-header-title">Fere Agent</span>
                <span className="agp-header-sub">
                  {chatting ? "Thinking..."
                    : scanning ? "Scanning..."
                    : scanError ? "Scan failed"
                    : totalIssues > 0 ? `${totalIssues} issue${totalIssues !== 1 ? "s" : ""} detected`
                    : findings.length > 0 ? `${findings.length} suggestion${findings.length !== 1 ? "s" : ""}`
                    : hasScanned.current ? "All clear" : "Ready"}
                </span>
              </div>
            </div>
            <div className="agp-header-right">
              <button className="agp-scan-btn" onClick={runScan} disabled={scanning || chatting} title="Re-scan">
                <svg className={scanning ? "agp-spin" : ""} width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M7 2a5 5 0 1 1-3.54 1.46" />
                </svg>
              </button>
              <button className="agp-close" onClick={() => setOpen(false)}>×</button>
            </div>
          </div>

          {/* Tabs */}
          <div className="agp-tabs">
            <button className={`agp-tab${tab === "findings" ? " agp-tab-active" : ""}`} onClick={() => setTab("findings")}>
              Findings
              {findings.length > 0 && <span className="agp-tab-count">{findings.length}</span>}
            </button>
            <button className={`agp-tab${tab === "chat" ? " agp-tab-active" : ""}`} onClick={() => setTab("chat")}>
              Chat
              {chatting && <span className="agp-tab-live" />}
            </button>
          </div>

          {/* Body */}
          <div className="agp-body">
            {tab === "findings" ? (
              scanning ? (
                <div className="agp-empty">
                  <svg className="agp-spin" width="22" height="22" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M7 2a5 5 0 1 1-3.54 1.46" /></svg>
                  <span>Scanning your stack...</span>
                  <span className="agp-empty-sub">Checking health, connections, env vars, containers</span>
                </div>
              ) : scanError ? (
                <div className="agp-empty">
                  <span>{scanError}</span>
                  <button className="agp-btn agp-btn-ghost" onClick={runScan}>Retry</button>
                </div>
              ) : findings.length === 0 ? (
                <div className="agp-empty agp-all-clear">
                  <div className="agp-clear-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 12l2.5 2.5 4.5-4.5" /></svg>
                  </div>
                  <span className="agp-clear-title">All systems nominal</span>
                  <span className="agp-empty-sub">No issues, misconfigs, or unhealthy services detected</span>
                </div>
              ) : (
                <div className="agp-findings">
                  {/* Health score bar */}
                  {healthScore !== null && healthGrade !== null && (
                    <div className="agp-score-bar">
                      <div className="agp-score-header">
                        <span className="agp-score-label">Environment Health</span>
                        <span className="agp-score-value" style={{ color: healthGrade.color }}>{healthScore}% — {healthGrade.label}</span>
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
                      {issues.map((f) => <FindingRow key={f.id} finding={f} onDismiss={(id) => setFindings((p) => p.filter((x) => x.id !== id))} onInvestigate={handleInvestigate} />)}
                    </div>
                  )}
                  {suggestions.length > 0 && (
                    <div className="agp-section">
                      <span className="agp-section-label">Suggestions</span>
                      {suggestions.map((f) => <FindingRow key={f.id} finding={f} onDismiss={(id) => setFindings((p) => p.filter((x) => x.id !== id))} onInvestigate={handleInvestigate} />)}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="agp-chat">
                {messages.length === 0 && (
                  <div className="agp-chat-empty">
                    <span>Ask anything about your stack</span>
                    <div className="agp-chat-chips">
                      {["What's broken and how do I fix it?", "Why aren't my services connecting?", "Walk me through my entire stack"].map((s) => (
                        <button key={s} className="agp-chat-chip" onClick={() => sendMessage(s)}>{s}</button>
                      ))}
                    </div>
                  </div>
                )}
                {messages.map((m, i) => {
                  if (m.kind === "user") return <div key={i} className="agp-msg agp-msg-user"><span>{m.text}</span></div>;
                  if (m.kind === "agent") return (
                    <div key={i} className="agp-msg agp-msg-agent">
                      {renderMarkdown(m.text, nameMap)}
                      {m.streaming && <span className="agp-cursor" />}
                    </div>
                  );
                  if (m.kind === "tool_call") return <ToolCallRow key={i} label={m.label} done={m.done} />;
                  if (m.kind === "action") return <ActionRow key={i} action={m.action} />;
                  return null;
                })}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="agp-input-wrap">
            {mentionMatches.length > 0 && (
              <div className="agp-mention-list">
                {mentionMatches.map((n) => (
                  <button key={n.id} className="agp-mention-item" onMouseDown={(e) => { e.preventDefault(); selectMention(n); }}>
                    <span className="agp-mention-dot" style={{ background: n.healthStatus === "green" ? "#22c55e" : n.healthStatus === "yellow" ? "#f59e0b" : "#ef4444" }} />
                    <span className="agp-mention-name">{n.name}</span>
                    <span className="agp-mention-type">{n.type}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="agp-input-row">
              <input
                ref={inputRef}
                className="agp-input"
                placeholder={tab === "findings" ? "Ask about findings... (type @ to mention a service)" : "Ask anything... (type @ to mention a service)"}
                value={chatInput}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setMentionQuery(null); return; }
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (mentionMatches.length === 0) sendMessage(chatInput); }
                }}
                disabled={chatting}
              />
              {chatting ? (
                <button className="agp-send agp-send-stop" onClick={handleStop} title="Stop">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1" /></svg>
                </button>
              ) : (
                <button className={`agp-send${chatInput.trim() ? " agp-send-active" : ""}`} onClick={() => { setMentionQuery(null); sendMessage(chatInput); }} disabled={!chatInput.trim()}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 2v10M2 7l5-5 5 5" /></svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
