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

const PROVIDER_ALIAS_MAP: Record<string, string> = {
  gemini: "google gemini",
  aws: "aws bedrock",
  bedrock: "aws bedrock",
};

const RAW_LOGO_TOKEN = (window.electronAPI.logoDevToken || "").trim();
const LOGO_TOKEN = RAW_LOGO_TOKEN.startsWith("pk_") ? RAW_LOGO_TOKEN : "";
const STEP_ICON_BASE_PATH = `${process.env.PUBLIC_URL || ""}/sentinel-step-icons`;

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function getAvatarFallbackText(label: string | null | undefined): string {
  const source = (label || "").trim();
  if (!source) return "?";

  const parts = source
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }

  const condensed = source.replace(/[^a-zA-Z0-9]/g, "");
  return (condensed.slice(0, 2) || source.slice(0, 2)).toUpperCase();
}

function AuthAvatar({
  avatarUrl,
  label,
}: {
  avatarUrl: string | null;
  label: string | null;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  if (!avatarUrl || failed) {
    return (
      <div className="agp-auth-avatar agp-auth-avatar-fallback" aria-hidden="true">
        {getAvatarFallbackText(label)}
      </div>
    );
  }

  return (
    <img
      src={avatarUrl}
      alt=""
      className="agp-auth-avatar"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function getStepIconPngPath(stepType: ChatStep["type"]): string | null {
  switch (stepType) {
    case "list_directory":
      return `${STEP_ICON_BASE_PATH}/folder.png`;
    case "run_command":
      return `${STEP_ICON_BASE_PATH}/terminal.png`;
    case "get_node_details":
      return `${STEP_ICON_BASE_PATH}/search.png`;
    case "docker_logs":
    case "docker_exec":
    case "docker_control":
      return `${STEP_ICON_BASE_PATH}/docker-box.png`;
    case "read_file":
      return `${STEP_ICON_BASE_PATH}/file.png`;
    default:
      return null;
  }
}

function renderDefaultStepIcon(stepType: ChatStep["type"]): React.ReactElement {
  if (stepType === "list_directory") {
    return (
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
    );
  }

  if (stepType === "run_command") {
    return (
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
        <rect x="1" y="1.5" width="10" height="9" rx="1.5" />
        <path d="M3.5 4.5l2 2-2 2" />
        <path d="M7.5 8.5h1" />
      </svg>
    );
  }

  if (stepType === "get_node_details") {
    return (
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
    );
  }

  if (
    stepType === "docker_logs" ||
    stepType === "docker_exec" ||
    stepType === "docker_control"
  ) {
    return (
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
        <rect x="1.5" y="3" width="9" height="7" rx="1" />
        <path d="M4 3V2M8 3V2" />
        <path d="M4 6.5h4M4 8.5h2" />
      </svg>
    );
  }

  return (
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
  );
}

function StepIcon({ stepType }: { stepType: ChatStep["type"] }): React.ReactElement {
  const pngPath = getStepIconPngPath(stepType);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [pngPath]);

  if (pngPath && !imageFailed) {
    return (
      <img
        src={pngPath}
        alt=""
        aria-hidden="true"
        className="agp-step-icon-image"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return renderDefaultStepIcon(stepType);
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

type ContextService = {
  name: string;
  type: string;
  pid: number;
  ports: number[];
  healthStatus: string;
  cpu?: number;
  memory?: number;
  isDockerContainer?: boolean;
  containerState?: string;
  projectPath?: string;
  externalApis?: string[];
  routes?: Array<{ method?: string; path: string }>;
};
type ContextFinding = {
  severity: string;
  service: string;
  summary: string;
  stage: string;
};
type ContextConnection = {
  from: string;
  to: string;
  port: number;
};
type ContextSnapshot = {
  scope: string;
  timestamp: string;
  services: ContextService[];
  connections: ContextConnection[];
  findings: ContextFinding[];
};
type FeedMessage = {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  copyable?: boolean;
};
type FeedContext = {
  kind: "context";
  snapshot: ContextSnapshot;
  copyText: string;
};
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
type FeedItem = FeedMessage | FeedContext | FeedFinding;
type IncidentStage = "detected" | "fixing" | "fixed" | "verified" | "escalated";
type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  feed: FeedItem[];
};

function renderMirrorContent(text: string, nodes: GraphNode[]): React.ReactNode {
  const parts = text.split(/(@[\w\-.:]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const name = part.slice(1);
      const node = nodes.find((n) => n.name === name);
      if (node) {
        const color = getServiceColor(node.type);
        return (
          <span key={i} style={{ background: `${color}35`, borderRadius: "3px" }}>
            {part}
          </span>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
}

function renderMentions(text: string, nodes: GraphNode[]): React.ReactNode {
  const parts = text.split(/(@[\w\-.:]+)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const name = part.slice(1);
      const node = nodes.find((n) => n.name === name);
      if (node) {
        const color = getServiceColor(node.type);
        return (
          <span
            key={i}
            className="agp-mention-chip"
            style={{
              background: `${color}20`,
              color,
              border: `1px solid ${color}40`,
            }}
          >
            {part}
          </span>
        );
      }
    }
    return part;
  });
}

function MentionDropdown({
  query,
  nodes,
  onSelect,
}: {
  query: string;
  nodes: GraphNode[];
  onSelect: (node: GraphNode) => void;
}) {
  const filtered = nodes
    .filter((n) => n.type !== "external")
    .filter((n) => n.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  if (filtered.length === 0) return null;

  return (
    <div className="agp-mention-dropdown">
      {filtered.map((node) => {
        const color = getServiceColor(node.type);
        return (
          <button
            key={node.id}
            className="agp-mention-item"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(node);
            }}
          >
            <span className="agp-mention-dot" style={{ background: color }} />
            <span className="agp-mention-name">{node.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (window.electronAPI?.copyText) {
        const result = await window.electronAPI.copyText(text);
        if (!result.success) throw new Error(result.error || "Copy failed");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No-op
    }
  }, [text]);

  return (
    <button className="agp-copy-btn" onClick={() => void handleCopy()}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function ContextBlock({
  snapshot,
  copyText,
}: {
  snapshot: ContextSnapshot;
  copyText: string;
}) {
  const HEALTH_DOT: Record<string, string> = {
    green: "#22C55E",
    yellow: "#EAB308",
    red: "#EF4444",
  };

  return (
    <div className="agp-context-block">
      <div className="agp-context-header">
        <span className="agp-context-title">Runtime Context</span>
        <span className="agp-context-meta">{snapshot.scope} · {snapshot.timestamp}</span>
      </div>

      <div className="agp-context-scrollable">
        {snapshot.services.length > 0 && (
          <div className="agp-context-section">
            <div className="agp-context-section-label">Services ({snapshot.services.length})</div>
            {snapshot.services.map((svc, i) => {
              const color = getServiceColor(svc.type);
              const healthColor = HEALTH_DOT[svc.healthStatus] ?? "#6B7280";
              const ports = svc.ports.length ? svc.ports.join(", ") : "no port";
              const cpu = svc.cpu != null ? `${svc.cpu.toFixed(1)}% CPU` : null;
              const mem = svc.memory != null ? `${svc.memory.toFixed(0)} MB` : null;
              const docker = svc.isDockerContainer
                ? `container · ${svc.containerState ?? "?"}`
                : null;
              return (
                <div key={i} className="agp-context-service">
                  <div className="agp-context-service-row">
                    <span
                      className="agp-context-service-badge"
                      style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
                    >
                      {svc.type}
                    </span>
                    <span className="agp-context-service-name">{svc.name}</span>
                    <span className="agp-context-service-health" style={{ background: healthColor }} />
                    <span className="agp-context-service-meta">:{ports}</span>
                    {cpu && <span className="agp-context-service-meta">{cpu}</span>}
                    {mem && <span className="agp-context-service-meta">{mem}</span>}
                    {docker && <span className="agp-context-service-meta">{docker}</span>}
                  </div>
                  {svc.externalApis && svc.externalApis.length > 0 && (
                    <div className="agp-context-service-detail">
                      calls: {svc.externalApis.join(", ")}
                    </div>
                  )}
                  {svc.routes && svc.routes.length > 0 && (
                    <div className="agp-context-service-detail">
                      routes: {svc.routes.slice(0, 4).map((r) => `${r.method ?? "?"} ${r.path}`).join(", ")}
                      {svc.routes.length > 4 ? ` +${svc.routes.length - 4} more` : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {(snapshot.connections ?? []).length > 0 && (
          <div className="agp-context-section">
            <div className="agp-context-section-label">Connections ({snapshot.connections.length})</div>
            {snapshot.connections.map((c, i) => (
              <div key={i} className="agp-context-service-detail" style={{ padding: "2px 0" }}>
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{c.from}</span>
                <span style={{ margin: "0 4px", color: "var(--text-muted)" }}>→</span>
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{c.to}</span>
                <span className="agp-context-service-meta" style={{ marginLeft: 4 }}>:{c.port}</span>
              </div>
            ))}
          </div>
        )}

        {snapshot.findings.length > 0 && (
          <div className="agp-context-section">
            <div className="agp-context-section-label">Findings ({snapshot.findings.length})</div>
            {snapshot.findings.map((f, i) => {
              const sev = f.severity.toLowerCase();
              const sevColor =
                sev === "critical" ? "#EF4444" : sev === "high" ? "#F97316" : sev === "medium" ? "#EAB308" : "#6B7280";
              return (
                <div key={i} className="agp-context-finding">
                  <span className="agp-context-finding-sev" style={{ color: sevColor }}>
                    [{f.severity.toUpperCase()}]
                  </span>
                  <span className="agp-context-finding-service">{f.service}</span>
                  <span className="agp-context-finding-summary">{f.summary}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <CopyButton text={copyText} />
    </div>
  );
}

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

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/^[-*]\s+/gm, "");
}

function deriveThreadTitle(feed: FeedItem[]): string {
  const firstUser = feed.find(
    (item): item is FeedMessage =>
      item.kind === "message" && item.role === "user" && item.content.trim().length > 0,
  );
  if (!firstUser) return "New chat";
  const clean = stripMarkdown(firstUser.content).replace(/\s+/g, " ").trim();
  return clean.length > 56 ? `${clean.slice(0, 56)}…` : clean;
}

function sanitizeFeed(input: unknown): FeedItem[] {
  if (!Array.isArray(input)) return [];
  const items: FeedItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    // Old format: { role, content } without kind — migrate
    if (
      !m.kind &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
    ) {
      items.push({
        kind: "message",
        role: m.role as "user" | "assistant",
        content: m.content,
      });
      continue;
    }
    // New message format
    if (
      m.kind === "message" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
    ) {
      const msg: FeedMessage = {
        kind: "message",
        role: m.role as "user" | "assistant",
        content: m.content,
        copyable: m.copyable === true,
      };
      items.push(msg);
      continue;
    }
    if (
      m.kind === "context" &&
      m.snapshot &&
      typeof m.snapshot === "object" &&
      typeof m.copyText === "string"
    ) {
      items.push({
        kind: "context",
        snapshot: m.snapshot as ContextSnapshot,
        copyText: m.copyText,
      });
      continue;
    }
    if (
      m.kind === "message" &&
      m.contextSnapshot &&
      typeof m.contextSnapshot === "object" &&
      typeof m.content === "string"
    ) {
      items.push({
        kind: "context",
        snapshot: m.contextSnapshot as ContextSnapshot,
        copyText: m.content,
      });
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
      id:
        typeof maybe.id === "string" && maybe.id.trim()
          ? maybe.id
          : createThreadId(),
      title:
        typeof maybe.title === "string" && maybe.title.trim()
          ? maybe.title.trim()
          : deriveThreadTitle(feed),
      updatedAt,
      feed,
    });
  }
  return threads.slice(0, MAX_CHAT_THREADS);
}

function createThread(feed: FeedItem[] = []): ChatThread {
  return {
    id: createThreadId(),
    title: deriveThreadTitle(feed),
    updatedAt: Date.now(),
    feed,
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

type AgentProviderInfoLite = {
  id: string;
  displayName: string;
  binary: string;
  installHint: string;
  detected: boolean;
};

function AgentErrorToast({
  providerName,
  message,
  onDismiss,
}: {
  providerName: string;
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="agp-agent-toast" role="alert">
      <div className="agp-agent-toast-title">{providerName} couldn't run</div>
      <div className="agp-agent-toast-msg">{message}</div>
      <button
        className="agp-agent-toast-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function InvestigateButton({
  item,
  investigation,
  isStreaming,
  agentProviders,
  agentLoadState,
  agentLoadError,
  onRefreshAgents,
  activeProvider,
  menuOpen,
  setMenuOpen,
  onInvestigate,
  onChooseDefault,
}: {
  item: FeedFinding;
  investigation?: {
    status: "running" | "done" | "error";
    lastTool?: string;
    result?: string;
    error?: string;
    providerName?: string;
    providerId?: string;
  };
  isStreaming: boolean;
  agentProviders: AgentProviderInfoLite[];
  agentLoadState: "idle" | "loading" | "ready" | "error";
  agentLoadError: string | null;
  onRefreshAgents: () => void | Promise<void>;
  activeProvider: AgentProviderInfoLite | null;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onInvestigate: (finding: FeedFinding, providerId?: string) => void;
  onChooseDefault: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen, setMenuOpen]);

  const running = investigation?.status === "running";
  const disabled = isStreaming || running;
  const detected = agentProviders.filter((p) => p.detected);
  const hasAny = detected.length > 0;

  const label = running
    ? "Investigating…"
    : hasAny
      ? `Investigate${activeProvider ? ` (${activeProvider.displayName})` : ""}`
      : "Investigate";

  return (
    <div className="agp-finding-investigate-split" ref={ref}>
      <button
        className="agp-finding-claudecode-btn agp-finding-investigate-main"
        onClick={() => {
          if (!hasAny) {
            setMenuOpen(true);
            return;
          }
          onInvestigate(item, activeProvider?.id);
        }}
        disabled={disabled}
        title={
          activeProvider
            ? `Run a headless ${activeProvider.displayName} investigation here`
            : "No agent CLI detected — click the caret to see install options"
        }
      >
        {label}
      </button>
      <button
        className="agp-finding-claudecode-btn agp-finding-investigate-caret"
        onClick={() => setMenuOpen(!menuOpen)}
        disabled={isStreaming}
        title="Choose an agent"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        ▾
      </button>
      {menuOpen && (
        <div className="agp-finding-agent-menu" role="menu">
          {(agentLoadState === "loading" || agentLoadState === "idle") && (
            <div className="agp-finding-agent-menu-empty">
              Detecting agents…
            </div>
          )}
          {agentLoadState === "error" && (
            <>
              <div className="agp-finding-agent-menu-empty">
                Failed to detect: {agentLoadError ?? "unknown error"}
              </div>
              <button
                className="agp-finding-agent-menu-item"
                onClick={() => { void onRefreshAgents(); }}
              >
                <span className="agp-finding-agent-menu-name">Retry</span>
              </button>
            </>
          )}
          {agentLoadState === "ready" && agentProviders.length === 0 && (
            <div className="agp-finding-agent-menu-empty">
              No agent CLI detected. Install Claude Code or OpenAI Codex,
              then click Retry.
            </div>
          )}
          {agentLoadState === "ready" && agentProviders.map((p) => (
            <div key={p.id} className="agp-finding-agent-menu-row">
              {p.detected ? (
                <button
                  className="agp-finding-agent-menu-item"
                  role="menuitem"
                  onClick={() => {
                    onChooseDefault(p.id);
                    onInvestigate(item, p.id);
                  }}
                >
                  <span className="agp-finding-agent-menu-name">
                    {p.displayName}
                  </span>
                  {activeProvider?.id === p.id && (
                    <span className="agp-finding-agent-menu-check">✓</span>
                  )}
                </button>
              ) : (
                <div className="agp-finding-agent-menu-item agp-finding-agent-menu-disabled">
                  <span className="agp-finding-agent-menu-name">
                    {p.displayName}
                  </span>
                  <span
                    className="agp-finding-agent-menu-install"
                    title={p.installHint}
                  >
                    not installed
                  </span>
                </div>
              )}
            </div>
          ))}
          {agentLoadState === "ready" && (
            <button
              className="agp-finding-agent-menu-item agp-finding-agent-menu-refresh"
              onClick={() => { void onRefreshAgents(); }}
              title="Re-run detection"
            >
              <span className="agp-finding-agent-menu-name">Refresh</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FindingCard({
  item,
  onFix,
  onExplain,
  onDismiss,
  onOpenInClaudeCode,
  onInvestigate,
  investigation,
  agentProviders,
  agentLoadState,
  agentLoadError,
  onRefreshAgents,
  defaultAgentId,
  setDefaultAgentId,
  isStreaming,
}: {
  item: FeedFinding;
  onFix: (id: string) => void;
  onExplain: (finding: FeedFinding) => void;
  onDismiss: (id: string) => void;
  onOpenInClaudeCode: (finding: FeedFinding) => void;
  onInvestigate: (finding: FeedFinding, providerId?: string) => void;
  investigation?: {
    status: "running" | "done" | "error";
    lastTool?: string;
    result?: string;
    error?: string;
    providerName?: string;
    providerId?: string;
  };
  agentProviders: {
    id: string;
    displayName: string;
    binary: string;
    installHint: string;
    detected: boolean;
  }[];
  agentLoadState: "idle" | "loading" | "ready" | "error";
  agentLoadError: string | null;
  onRefreshAgents: () => void | Promise<void>;
  defaultAgentId: string | null;
  setDefaultAgentId: (id: string | null) => void;
  isStreaming: boolean;
}) {
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const detectedProviders = agentProviders.filter((p) => p.detected);
  const activeProvider =
    detectedProviders.find((p) => p.id === defaultAgentId) ??
    detectedProviders[0] ??
    null;
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
          <button
            className="agp-finding-dismiss"
            onClick={() => onDismiss(item.id)}
            title="Dismiss"
          >
            ×
          </button>
        )}
      </div>
      <div className="agp-finding-summary">{item.summary}</div>

      {item.stage === "detected" && (
        <div className="agp-finding-actions">
          {item.fix &&
            (item.fix.type === "restart-container" ||
              item.fix.type === "kill-port") && (
              <button
                className="agp-finding-fix-btn"
                onClick={() => onFix(item.id)}
                disabled={isStreaming}
                title={
                  item.fix.type === "restart-container"
                    ? "Restart this container"
                    : `Kill the process on port ${item.fix.port}`
                }
              >
                {item.fix.type === "restart-container"
                  ? "Restart"
                  : `Kill :${item.fix.port}`}
              </button>
            )}
          <button
            className="agp-finding-explain-btn"
            onClick={() => onExplain(item)}
            disabled={isStreaming}
            title="Explain this finding in chat"
          >
            Explain
          </button>
          <InvestigateButton
            item={item}
            investigation={investigation}
            isStreaming={isStreaming}
            agentProviders={agentProviders}
            agentLoadState={agentLoadState}
            agentLoadError={agentLoadError}
            onRefreshAgents={onRefreshAgents}
            activeProvider={activeProvider}
            menuOpen={agentMenuOpen}
            setMenuOpen={setAgentMenuOpen}
            onInvestigate={onInvestigate}
            onChooseDefault={(id) => {
              setDefaultAgentId(id);
              setAgentMenuOpen(false);
            }}
          />
          <button
            className="agp-finding-claudecode-btn"
            onClick={() => onOpenInClaudeCode(item)}
            disabled={isStreaming}
            title="Open Terminal at this project with the investigation brief"
          >
            Hand off
          </button>
        </div>
      )}

      {investigation && (() => {
        const trimmed = (investigation.result ?? "").trim();
        const isMeaningful =
          trimmed.length > 0 &&
          trimmed !== "(no output)" &&
          trimmed !== "()";
        const showResult = investigation.status === "done" && isMeaningful;
        const showEmptyDone = investigation.status === "done" && !isMeaningful;
        const showRunning = investigation.status === "running";
        const showError = investigation.status === "error";
        if (!showResult && !showEmptyDone && !showRunning && !showError) {
          return null;
        }
        return (
          <div className="agp-finding-investigation">
            {showRunning && (() => {
              const who = investigation.providerName || "Agent";
              return (
                <div className="agp-finding-status">
                  <span className="agp-step-spinner" />
                  {investigation.lastTool
                    ? `${who} → ${investigation.lastTool}`
                    : `${who} is investigating…`}
                </div>
              );
            })()}
            {showResult && (
              <pre className="agp-finding-investigation-result">
                {trimmed}
              </pre>
            )}
            {showEmptyDone && (
              <div className="agp-finding-status">
                Investigation finished with no output.
              </div>
            )}
            {showError && (
              <div className="agp-finding-status agp-finding-status-escalated">
                {investigation.error}
              </div>
            )}
          </div>
        );
      })()}

      {(item.stage === "fixing" || item.stage === "fixed") && (
        <div className="agp-finding-status">
          <span className="agp-step-spinner" />
          {item.stage === "fixing" ? "Applying fix…" : "Verifying…"}
        </div>
      )}

      {item.stage === "verified" && (
        <div className="agp-finding-status agp-finding-status-verified">
          Fixed
        </div>
      )}

      {item.stage === "escalated" && (
        <div className="agp-finding-escalated">
          <div className="agp-finding-status agp-finding-status-escalated">
            {item.error ?? "Needs manual review"}
          </div>
          <div className="agp-finding-actions">
            <button
              className="agp-finding-explain-btn"
              onClick={() => onExplain(item)}
              disabled={isStreaming}
              title="Explain this finding in chat"
            >
              Explain
            </button>
            <InvestigateButton
              item={item}
              investigation={investigation}
              isStreaming={isStreaming}
              agentProviders={agentProviders}
              agentLoadState={agentLoadState}
              agentLoadError={agentLoadError}
              onRefreshAgents={onRefreshAgents}
              activeProvider={activeProvider}
              menuOpen={agentMenuOpen}
              setMenuOpen={setAgentMenuOpen}
              onInvestigate={onInvestigate}
              onChooseDefault={(id) => {
                setDefaultAgentId(id);
                setAgentMenuOpen(false);
              }}
            />
            <button
              className="agp-finding-claudecode-btn"
              onClick={() => onOpenInClaudeCode(item)}
              disabled={isStreaming}
              title="Open Terminal at this project with the investigation brief"
            >
              Hand off
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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

  // Transient popup for agent failures (e.g. provider not installed,
  // codex not authed). Auto-dismisses after a few seconds.
  type AgentToast = { providerName: string; message: string };
  const [agentToast, setAgentToast] = useState<AgentToast | null>(null);

  // Headless agent investigations keyed by finding id. Populated by
  // investigateFinding() and updated as IPC step/complete events arrive.
  type InvestigationState = {
    status: "running" | "done" | "error";
    lastTool?: string;
    result?: string;
    error?: string;
    providerName?: string;
    providerId?: string;
  };
  const [investigations, setInvestigations] = useState<
    Record<string, InvestigationState>
  >({});

  // Available agent CLIs detected on the user's machine + the persisted default.
  type AgentProviderInfo = {
    id: string;
    displayName: string;
    binary: string;
    installHint: string;
    detected: boolean;
  };
  const AGENT_PREF_KEY = "fere.defaultAgentProvider";
  const [agentProviders, setAgentProviders] = useState<AgentProviderInfo[]>([]);
  const [agentLoadState, setAgentLoadState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("loading");
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null);
  const [defaultAgentId, setDefaultAgentIdState] = useState<string | null>(() => {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(AGENT_PREF_KEY);
  });
  const setDefaultAgentId = useCallback((id: string | null) => {
    setDefaultAgentIdState(id);
    if (typeof localStorage !== "undefined") {
      if (id) localStorage.setItem(AGENT_PREF_KEY, id);
      else localStorage.removeItem(AGENT_PREF_KEY);
    }
  }, []);

  const refreshAgentProviders = useCallback(async () => {
    setAgentLoadState("loading");
    setAgentLoadError(null);
    try {
      const api = window.electronAPI as unknown as {
        listAgentProviders?: (opts?: { fresh?: boolean }) => Promise<{
          providers: AgentProviderInfo[];
          error?: string;
        }>;
      };
      if (typeof api.listAgentProviders !== "function") {
        throw new Error(
          "listAgentProviders is not exposed on electronAPI. Restart the Fere app (preload.js changes don't hot-reload).",
        );
      }
      const res = await api.listAgentProviders({ fresh: true });
      setAgentProviders(res.providers ?? []);
      setAgentLoadState("ready");
      if (res.error) setAgentLoadError(res.error);
      const detected = (res.providers ?? []).filter((p) => p.detected);
      const stillValid =
        defaultAgentId && detected.some((p) => p.id === defaultAgentId);
      if (!stillValid && detected.length > 0) {
        setDefaultAgentId(detected[0].id);
      } else if (!stillValid) {
        setDefaultAgentId(null);
      }
    } catch (err) {
      setAgentLoadState("error");
      setAgentLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [defaultAgentId, setDefaultAgentId]);

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

  // Detect installed agent CLIs (Claude Code, Codex, ...) once on mount.
  // refreshAgentProviders() also runs on demand from the dropdown menu.
  useEffect(() => {
    void refreshAgentProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Headless agent investigation events. Always on — independent of Sentinel
  // detection state, since users can trigger investigations manually.
  useEffect(() => {
    window.electronAPI.onInvestigationStep((step) => {
      const id = step.investigationId;
      if (!id) return;
      if (step.kind === "tool_use") {
        setInvestigations((prev) => ({
          ...prev,
          [id]: {
            ...(prev[id] ?? { status: "running" as const }),
            status: "running",
            lastTool: step.tool,
          },
        }));
      }
    });
    window.electronAPI.onInvestigationComplete((evt) => {
      const id = evt.investigationId;
      if (!id) return;
      let providerNameForToast: string | undefined;
      setInvestigations((prev) => {
        const existing = prev[id];
        providerNameForToast = existing?.providerName;
        return {
          ...prev,
          [id]: evt.success
            ? { ...existing, status: "done", result: evt.result }
            : {
                ...existing,
                status: "error",
                error: evt.error || "Investigation failed",
              },
        };
      });
      if (!evt.success) {
        // Surface a popup so the user can't miss it — inline error text in the
        // finding card is easy to overlook for off-screen findings.
        setAgentToast({
          providerName: providerNameForToast || "Agent",
          message: evt.error || "Investigation failed",
        });
      }
    });
    return () => {
      window.electronAPI.offInvestigationStep();
      window.electronAPI.offInvestigationComplete();
    };
  }, []);

  const investigateFinding = useCallback(
    (finding: FeedFinding, providerId?: string) => {
      const investigationId = finding.id;
      const chosenProviderId = providerId ?? defaultAgentId ?? undefined;
      const chosenProvider = chosenProviderId
        ? agentProviders.find((p) => p.id === chosenProviderId)
        : agentProviders.find((p) => p.detected);

      // If the user explicitly picked a provider that isn't installed/detected,
      // surface a popup immediately rather than spawning and failing late.
      if (chosenProviderId && chosenProvider && !chosenProvider.detected) {
        setAgentToast({
          providerName: chosenProvider.displayName,
          message: `${chosenProvider.displayName} isn't set up on this machine. Install it with: ${chosenProvider.installHint}`,
        });
        return;
      }

      setInvestigations((prev) => ({
        ...prev,
        [investigationId]: {
          status: "running",
          providerId: chosenProvider?.id,
          providerName: chosenProvider?.displayName,
        },
      }));
      const findingForBridge: AgentFinding = {
        id: finding.id,
        severity: finding.severity,
        // FeedFinding doesn't carry category/detail/impact/affected — main
        // process re-runs scan and matches by id, so these are best-effort.
        category: "health",
        service: finding.service,
        summary: finding.summary,
        detail: finding.error ?? "",
        impact: null,
        affectedServices: [],
        fix: finding.fix,
      };
      void window.electronAPI
        .investigateFinding(findingForBridge, investigationId, chosenProviderId)
        .catch((err: unknown) => {
          setInvestigations((prev) => ({
            ...prev,
            [investigationId]: {
              ...(prev[investigationId] ?? { status: "running" as const }),
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            },
          }));
        });
    },
    [agentProviders, defaultAgentId],
  );

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
      {agentToast && (
        <AgentErrorToast
          providerName={agentToast.providerName}
          message={agentToast.message}
          onDismiss={() => setAgentToast(null)}
        />
      )}
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
                        onInvestigate={investigateFinding}
                        investigation={investigations[item.id]}
                        agentProviders={agentProviders}
                        agentLoadState={agentLoadState}
                        agentLoadError={agentLoadError}
                        onRefreshAgents={refreshAgentProviders}
                        defaultAgentId={defaultAgentId}
                        setDefaultAgentId={setDefaultAgentId}
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
