import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { List } from "react-window";
import type { RowComponentProps } from "react-window";
import type {
  ActivityEvent,
  ActivityCategory,
  GraphNode,
  MetricHistory,
} from "../types/electron";
import { getServiceColor, getTypeBadge } from "./graph/constants";
import { BrandIcon, inferServiceBrand } from "./graph/brandIcons";

// --- Constants ---
const EVENT_ROW_HEIGHT = 56;
const POLL_INTERVAL = 5000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ALL_REPOS = "__all__";

const CATEGORY_ICONS: Record<ActivityCategory, string> = {
  crash: "\u25CF",
  recovery: "\u25B2",
  anomaly: "\u26A0",
  sentinel: "\u2699",
  discovery: "\u002B",
  removal: "\u2212",
  topology: "\u21C4",
  "user-action": "\u270E",
};


const SEVERITY_COLORS: Record<string, string> = {
  critical: "#dc2626",
  warning: "#d97706",
  info: "#a3a3a3",
};

const ALL_CATEGORIES: ActivityCategory[] = [
  "crash", "recovery", "anomaly", "sentinel",
  "discovery", "removal", "topology", "user-action",
];

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  crash: "Crash",
  recovery: "Recovery",
  anomaly: "Anomaly",
  sentinel: "Sentinel",
  discovery: "Discovery",
  removal: "Removal",
  topology: "Topology",
  "user-action": "User Action",
};

const CATEGORY_COLORS: Record<ActivityCategory, string> = {
  crash: "#d14a87",
  recovery: "#8bd226",
  anomaly: "#f4b400",
  sentinel: "#9b9b9b",
  discovery: "#1ea7e1",
  removal: "#bf5a00",
  topology: "#3420df",
  "user-action": "#118c87",
};

// --- Tab type from App.tsx ---
interface TabInfo {
  id: string;
  label: string;
  count: number;
  stackLabel: string | null;
}

// --- Helpers ---

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getCategoryAccentStyles(color: string): React.CSSProperties {
  return {
    "--activity-category-color": color,
    "--activity-category-soft": hexToRgba(color, 0.06),
    "--activity-category-soft-strong": hexToRgba(color, 0.1),
  } as React.CSSProperties;
}

function getServiceCompositionType(node: GraphNode): string {
  switch (node.type) {
    case "frontend":
    case "client":
      return "frontend";
    case "backend":
    case "webserver":
    case "nodejs":
    case "python":
    case "service":
      return "backend";
    case "database":
      return "database";
    case "cache":
      return "cache";
    case "broker":
      return "broker";
    case "worker":
      return "worker";
    case "realtime":
      return "realtime";
    case "container":
      return "container";
    default:
      return "other";
  }
}

function getServiceCompositionLabel(type: string): string {
  if (type === "other") return "Other";
  return getTypeBadge(type);
}


// System total RAM in MB — navigator.deviceMemory gives GB (capped at 8 in some browsers).
// Falls back to 8GB if unavailable.
const SYSTEM_RAM_MB = ((navigator as any).deviceMemory || 8) * 1024;

/** Convert a %mem value (from ps) to MB using estimated system RAM. */
function pctToMb(pct: number): number {
  return (pct / 100) * SYSTEM_RAM_MB;
}

/** Parse Docker memoryUsage string like "123.4MiB / 8GiB" → MB, or return null. */
function parseDockerMemUsage(usage: string | undefined): number | null {
  if (!usage) return null;
  const match = usage.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "gib" || unit === "gb") return val * 1024;
  if (unit === "mib" || unit === "mb") return val;
  if (unit === "kib" || unit === "kb") return val / 1024;
  return val / (1024 * 1024); // bytes
}

/**
 * Build a map from service name → repo tab label.
 * Each node maps to exactly one repo — no overlap.
 */
function buildServiceRepoMap(graphNodes: GraphNode[], tabs: TabInfo[]): Map<string, string> {
  const tabPathToLabel = new Map<string, string>();
  for (const tab of tabs) {
    if (tab.id === "__system__") continue;
    tabPathToLabel.set(tab.id, tab.label);
  }

  const serviceToRepo = new Map<string, string>();
  for (const node of graphNodes) {
    if (!node.name || node.type === "external") continue;
    const tabPath = node.repoPath || node.projectPath;
    if (!tabPath) continue;
    const label = tabPathToLabel.get(tabPath);
    if (label) {
      serviceToRepo.set(node.name, label);
    }
  }
  return serviceToRepo;
}

// --- Repo Selector ---

interface RepoSelectorProps {
  tabs: TabInfo[];
  selectedRepo: string;
  onSelectRepo: (repo: string) => void;
  serviceCounts: Map<string, number>;
}

function RepoSelector({ tabs, selectedRepo, onSelectRepo, serviceCounts }: RepoSelectorProps) {
  const repoTabs = tabs.filter((t) => t.id !== "__system__");

  return (
    <div className="analytics-repo-bar">
      <button
        className={`analytics-repo-chip ${selectedRepo === ALL_REPOS ? "analytics-repo-chip-active" : ""}`}
        onClick={() => onSelectRepo(ALL_REPOS)}
      >
        All
        <span className="analytics-repo-chip-count">
          ({Array.from(serviceCounts.values()).reduce((a, b) => a + b, 0)})
        </span>
      </button>
      {repoTabs.map((tab) => (
        <button
          key={tab.id}
          className={`analytics-repo-chip ${selectedRepo === tab.label ? "analytics-repo-chip-active" : ""}`}
          onClick={() => onSelectRepo(tab.label)}
        >
          {tab.label}
          {tab.stackLabel && (
            <span className="analytics-repo-chip-count">{tab.stackLabel}</span>
          )}
          <span className="analytics-repo-chip-count">
            ({serviceCounts.get(tab.label) || 0})
          </span>
        </button>
      ))}
    </div>
  );
}

// --- Stack Overview Cards ---

interface StackOverviewProps {
  graphNodes: GraphNode[];
  events: ActivityEvent[];
  metricHistory: MetricHistory;
}

type DonutSegment = {
  key: string;
  label: string;
  value: number;
  color: string;
};

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number,
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) {
  const start = polarToCartesian(centerX, centerY, radius, endAngle);
  const end = polarToCartesian(centerX, centerY, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return [
    "M",
    start.x,
    start.y,
    "A",
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y,
  ].join(" ");
}

function StackHealthDonut({
  total,
  segments,
}: {
  total: number;
  segments: DonutSegment[];
}) {
  const size = 176;
  const strokeWidth = 28;
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  let currentAngle = 0;

  return (
    <div className="activity-donut-wrap">
      <svg
        className="activity-donut-chart"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="rgba(10, 10, 10, 0.07)"
          strokeWidth={strokeWidth}
        />
        {segments.map((segment) => {
          const sweep = total > 0 ? (segment.value / total) * 360 : 0;
          const startAngle = currentAngle;
          const endAngle = currentAngle + sweep;
          currentAngle = endAngle;

          if (sweep <= 0) return null;

          if (sweep >= 359.999) {
            return (
              <circle
                key={segment.key}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth={strokeWidth}
              />
            );
          }

          return (
            <path
              key={segment.key}
              d={describeArc(center, center, radius, startAngle, endAngle)}
              fill="none"
              stroke={segment.color}
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
              strokeLinejoin="round"
            />
          );
        })}
      </svg>
      <div className="activity-donut-center">
        <span className="activity-donut-total">{total}</span>
        <span className="activity-donut-label">
          {total === 1 ? "service" : "services"}
        </span>
      </div>
    </div>
  );
}

function StackOverview({ graphNodes, events, metricHistory }: StackOverviewProps) {
  const serviceStats = useMemo(() => {
    const nonExternal = graphNodes.filter((n) => n.type !== "external" && !n.isGhost);
    const counts = new Map<string, number>();
    nonExternal.forEach((node) => {
      const type = getServiceCompositionType(node);
      counts.set(type, (counts.get(type) || 0) + 1);
    });
    const segments = Array.from(counts.entries())
      .map(([type, value]) => ({
        key: type,
        label: getServiceCompositionLabel(type),
        value,
        color: type === "other" ? "#9b9b9b" : getServiceColor(type),
      }))
      .sort((a, b) => b.value - a.value);

    return {
      total: nonExternal.length,
      segments,
    };
  }, [graphNodes]);

  const issueStats = useMemo(() => {
    const now = Date.now();
    const cutoff = now - FIFTEEN_MINUTES;
    const issueCats = new Set(["crash", "anomaly", "sentinel"]);
    const recentIssues = events.filter(
      (e) => issueCats.has(e.category) && e.timestamp >= cutoff
    );
    const recoveredServices = new Set<string>();
    for (const e of events) {
      if (e.category === "recovery" && e.timestamp >= cutoff && e.serviceName) {
        recoveredServices.add(e.serviceName);
      }
    }
    const active = recentIssues.filter(
      (e) => !e.serviceName || !recoveredServices.has(e.serviceName)
    );
    const critical = active.filter((e) => e.severity === "critical").length;
    const warning = active.filter((e) => e.severity === "warning").length;
    return { total: active.length, critical, warning };
  }, [events]);

  const resourceStats = useMemo(() => {
    let totalMemMb = 0;
    let processCount = 0;
    const nonExternal = graphNodes.filter((n) => n.type !== "external" && !n.isGhost);
    for (const node of nonExternal) {
      totalMemMb += getServiceMemMb(node, metricHistory);
      processCount++;
    }
    const totalGb = totalMemMb / 1024;
    return { totalGb, processCount };
  }, [graphNodes, metricHistory]);

  const sentinelStats = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const count = events.filter(
      (e) => e.category === "sentinel" && e.timestamp >= startOfDay
    ).length;
    return { count };
  }, [events]);

  return (
    <div className="activity-stack-overview">
      <div className="activity-stack-health-card">
        <div className="activity-stack-health-header">
          <div>
            <div className="activity-stack-section-title">Service Mix</div>
            <div className="activity-stack-section-subtitle">
              Live breakdown by service type
            </div>
          </div>
        </div>
        <div className="activity-stack-health-body">
          <StackHealthDonut
            total={serviceStats.total}
            segments={serviceStats.segments}
          />
          <div className="activity-stack-health-legend">
            {serviceStats.segments.map((segment) => (
              <div key={segment.key} className="activity-stack-health-legend-item">
                <span
                  className="activity-stack-health-legend-swatch"
                  style={{ backgroundColor: segment.color }}
                />
                <div className="activity-stack-health-legend-copy">
                  <span className="activity-stack-health-legend-label">
                    {segment.label}
                  </span>
                  <span className="activity-stack-health-legend-value">
                    {segment.value}
                    {serviceStats.total > 0
                      ? ` · ${Math.round((segment.value / serviceStats.total) * 100)}%`
                      : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="activity-stack-summary-grid">
        <div className="activity-stack-summary-card">
          <div className="activity-stack-summary-label">Issues</div>
          <div className="activity-stack-summary-value">{issueStats.total}</div>
          <div className="activity-stack-summary-detail">
            {issueStats.total === 0
              ? "All clear"
              : `${issueStats.critical} critical · ${issueStats.warning} warning`}
          </div>
        </div>
        <div className="activity-stack-summary-card">
          <div className="activity-stack-summary-label">Resources</div>
          <div className="activity-stack-summary-value">
            {resourceStats.totalGb.toFixed(1)} GB
          </div>
          <div className="activity-stack-summary-detail">
            Across {resourceStats.processCount} processes
          </div>
        </div>
        <div className="activity-stack-summary-card">
          <div className="activity-stack-summary-label">Sentinel</div>
          <div className="activity-stack-summary-value">{sentinelStats.count}</div>
          <div className="activity-stack-summary-detail">
            {sentinelStats.count === 0
              ? "No actions today"
              : sentinelStats.count === 1
                ? "1 fix today"
                : `${sentinelStats.count} fixes today`}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Resource Breakdown ---

const FIVE_MINUTES = 5 * 60 * 1000;
const CPU_IDLE_THRESHOLD = 0.5;

interface ProjectGroup {
  name: string;
  nodes: GraphNode[];
  totalMemMb: number;
  serviceCount: number;
  isIdle: boolean;
  idleSince: number | null; // timestamp when group became idle
  lastActiveAgo: string; // "2m ago" or "Active" etc
}

function getServiceMemMb(node: GraphNode, metricHistory: MetricHistory): number {
  // Docker containers: prefer parsed memoryUsage (actual MB)
  if (node.isDockerContainer) {
    const parsed = parseDockerMemUsage(node.memoryUsage);
    if (parsed !== null) return parsed;
  }
  // Metric history stores %mem, convert to MB
  const history = metricHistory[node.name];
  const samples = history?.samples;
  if (samples && samples.length > 0) return pctToMb(samples[samples.length - 1].mem);
  // node.memory is %mem from ps
  return pctToMb(node.memory || 0);
}

function getServiceCpu(node: GraphNode): number {
  return node.cpu || 0;
}

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

interface ResourceBreakdownProps {
  graphNodes: GraphNode[];
  metricHistory: MetricHistory;
}

function ResourceBreakdown({ graphNodes, metricHistory }: ResourceBreakdownProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [confirmStop, setConfirmStop] = useState<string | null>(null);

  // Build project groups from all non-external nodes
  const projectGroups = useMemo(() => {
    const now = Date.now();
    const groupMap = new Map<string, GraphNode[]>();

    for (const node of graphNodes) {
      if (node.type === "external") continue;
      if (node.isGhost) continue;

      const projectName = node.project || (node.projectPath ? node.projectPath.split("/").pop()! : null);
      const key = projectName || "__ungrouped__";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(node);
    }

    const groups: ProjectGroup[] = [];
    groupMap.forEach((nodes, key) => {
      let totalMemMb = 0;
      let latestActiveCpu = 0;
      let latestActiveTs = 0;

      for (const node of nodes) {
        totalMemMb += getServiceMemMb(node, metricHistory);
        const cpu = getServiceCpu(node);
        if (cpu > CPU_IDLE_THRESHOLD) {
          latestActiveCpu = Math.max(latestActiveCpu, cpu);
          latestActiveTs = Math.max(latestActiveTs, now);
        }
        // Check metric history for recent activity
        const history = metricHistory[node.name];
        if (history?.samples) {
          for (let i = history.samples.length - 1; i >= 0; i--) {
            const s = history.samples[i];
            if (s.cpu > CPU_IDLE_THRESHOLD && s.t >= now - FIVE_MINUTES) {
              latestActiveTs = Math.max(latestActiveTs, s.t);
              break;
            }
          }
        }
      }

      const isIdle = latestActiveTs === 0 || (now - latestActiveTs) > FIVE_MINUTES;
      let lastActiveAgo: string;
      let idleSince: number | null = null;
      if (!isIdle) {
        const diff = now - latestActiveTs;
        lastActiveAgo = diff < 60000 ? "Active" : `Active ${relativeTime(latestActiveTs)}`;
      } else {
        idleSince = latestActiveTs || now;
        const diff = now - (latestActiveTs || now);
        if (diff < 60000) lastActiveAgo = "Idle";
        else lastActiveAgo = `Idle ${relativeTime(latestActiveTs || now)}`;
      }

      // Sort nodes within group by memory desc
      nodes.sort((a: GraphNode, b: GraphNode) => getServiceMemMb(b, metricHistory) - getServiceMemMb(a, metricHistory));

      groups.push({
        name: key === "__ungrouped__" ? "Ungrouped" : key,
        nodes,
        totalMemMb,
        serviceCount: nodes.length,
        isIdle,
        idleSince,
        lastActiveAgo,
      });
    });

    // Sort groups: memory desc, Ungrouped always last
    groups.sort((a, b) => {
      if (a.name === "Ungrouped") return 1;
      if (b.name === "Ungrouped") return -1;
      return b.totalMemMb - a.totalMemMb;
    });

    return groups;
  }, [graphNodes, metricHistory]);

  const toggleExpand = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleStopGroup = useCallback(async (group: ProjectGroup) => {
    setConfirmStop(null);
    for (const node of group.nodes) {
      if (node.isDockerContainer && node.containerId) {
        await window.electronAPI?.stopContainer?.(node.containerId);
      } else if (node.pid) {
        await window.electronAPI?.killProcess?.(node.pid);
      }
    }
  }, []);

  const hasAnyServices = projectGroups.length > 0;

  if (!hasAnyServices) {
    return (
      <div className="activity-breakdown">
        <div className="activity-breakdown-empty">No services running</div>
      </div>
    );
  }

  return (
    <div className="activity-breakdown">
      {projectGroups.map((group) => {
        const isExpanded = expanded.has(group.name);
        const groupPorts = Array.from(new Set(
          group.nodes.flatMap((n) => (n.ports || []).map((p) => p.port)).filter(Boolean)
        ));

        return (
          <div key={group.name} className="activity-breakdown-group">
            <div
              className="activity-breakdown-row activity-breakdown-row-project"
              onClick={() => toggleExpand(group.name)}
            >
              <span className={`activity-breakdown-arrow ${isExpanded ? "activity-breakdown-arrow-expanded" : ""}`}>
                {"\u25B8"}
              </span>
              <span className="activity-breakdown-project-name">{group.name}</span>
              <span className="activity-breakdown-meta">
                {group.serviceCount} {group.serviceCount === 1 ? "service" : "services"}
              </span>
              <span className="activity-breakdown-meta activity-breakdown-mono">
                {formatMemory(group.totalMemMb)}
              </span>
              {groupPorts.length > 0 && (
                <span className="activity-breakdown-meta activity-breakdown-mono activity-breakdown-ports">
                  {groupPorts.slice(0, 3).map((p) => `:${p}`).join(", ")}
                  {groupPorts.length > 3 && ` +${groupPorts.length - 3}`}
                </span>
              )}
              <span className={`activity-breakdown-status ${group.isIdle ? "activity-breakdown-status-idle" : ""}`}>
                {group.lastActiveAgo}
              </span>
              {group.isIdle ? (
                confirmStop === group.name ? (
                  <span className="activity-breakdown-confirm" onClick={(e) => e.stopPropagation()}>
                    Stop {group.serviceCount} {group.serviceCount === 1 ? "service" : "services"}?
                    <button className="activity-breakdown-confirm-btn activity-breakdown-confirm-yes" onClick={() => handleStopGroup(group)}>
                      Confirm
                    </button>
                    <button className="activity-breakdown-confirm-btn" onClick={() => setConfirmStop(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="activity-breakdown-stop-btn"
                    onClick={(e) => { e.stopPropagation(); setConfirmStop(group.name); }}
                  >
                    Stop
                  </button>
                )
              ) : null}
            </div>
            {isExpanded && (
              <div className="activity-breakdown-services">
                {group.nodes.map((node) => {
                  const mem = getServiceMemMb(node, metricHistory);
                  const cpu = getServiceCpu(node);
                  const port = node.ports?.[0]?.port;
                  const stateClass =
                    node.healthStatus === "green" ? "activity-breakdown-state-running" :
                    node.healthStatus === "yellow" ? "activity-breakdown-state-idle" :
                    "activity-breakdown-state-down";
                  const stateLabel =
                    node.healthStatus === "green" ? "running" :
                    node.healthStatus === "yellow" ? "idle" :
                    "down";
                  return (
                    <div key={node.id} className="activity-breakdown-row activity-breakdown-row-service">
                      <BrandIcon value={inferServiceBrand(node)} size={16} />
                      <span className="activity-breakdown-service-name">{node.name}</span>
                      <span className="activity-breakdown-meta activity-breakdown-mono">{Math.round(mem)} MB</span>
                      <span className="activity-breakdown-meta activity-breakdown-mono">{cpu.toFixed(1)}% CPU</span>
                      <span className="activity-breakdown-meta activity-breakdown-mono">
                        {port ? `:${port}` : ""}
                      </span>
                      <span className={`activity-breakdown-state ${stateClass}`}>{stateLabel}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

    </div>
  );
}

// --- Event Batching ---

const BATCH_WINDOW_MS = 10_000;
const BATCHABLE_CATEGORIES = new Set<ActivityCategory>(["discovery", "removal"]);

interface DisplayEvent {
  type: "single";
  event: ActivityEvent;
}

interface DisplayBatch {
  type: "batch";
  id: string;
  category: ActivityCategory;
  events: ActivityEvent[];
  title: string;
  detail: string;
  timestamp: number;
}

interface DisplaySubEvent {
  type: "sub-event";
  event: ActivityEvent;
}

type DisplayItem = DisplayEvent | DisplayBatch | DisplaySubEvent;

function batchEvents(events: ActivityEvent[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (!BATCHABLE_CATEGORIES.has(e.category)) {
      items.push({ type: "single", event: e });
      i++;
      continue;
    }
    // Collect consecutive events of the same batchable category within the time window
    const batchCat = e.category;
    const batch = [e];
    let j = i + 1;
    while (j < events.length && events[j].category === batchCat && Math.abs(events[j].timestamp - e.timestamp) <= BATCH_WINDOW_MS) {
      batch.push(events[j]);
      j++;
    }
    if (batch.length >= 3) {
      const label = batchCat === "discovery" ? "discovered" : "removed";
      const serviceNames = batch.map((b) => b.serviceName || b.title).filter(Boolean);
      items.push({
        type: "batch",
        id: `batch-${batch[0].id}`,
        category: batchCat,
        events: batch,
        title: `${batch.length} services ${label}`,
        detail: serviceNames.join(", "),
        timestamp: batch[0].timestamp, // most recent (events are sorted newest-first)
      });
      i = j;
    } else {
      items.push({ type: "single", event: e });
      i++;
    }
  }
  return items;
}

// --- Event Row ---

interface EventRowProps {
  items: DisplayItem[];
  expandedBatches: Set<string>;
  onToggleBatch: (id: string) => void;
  nodeByName: Map<string, GraphNode>;
}

const EventRow = memo(function EventRow({
  index,
  style,
  items,
  expandedBatches,
  onToggleBatch,
  nodeByName,
}: RowComponentProps<EventRowProps>) {
  // Build a flat list mapping: we need to figure out what row `index` maps to
  // This is handled by the parent building a flat row list, so items[index] is already resolved
  const item = items[index];
  if (!item) return null;

  if (item.type === "single") {
    const event = item.event;
    const catColor = CATEGORY_COLORS[event.category] || SEVERITY_COLORS.info;
    const hasRelated = event.relatedEvents && event.relatedEvents.length > 0;

    const brandValue = event.serviceName
      ? inferServiceBrand(nodeByName.get(event.serviceName) || { name: event.serviceName, command: "", containerImage: "" })
      : null;

    // Replace service name in title with branded badge inline
    const titleParts = event.serviceName && event.title.includes(event.serviceName)
      ? event.title.split(event.serviceName)
      : null;

    return (
      <div style={style} className="analytics-event-row">
        <div className="analytics-event-content">
          <div className="analytics-event-header">
            <span className="analytics-event-category-chip">
              <span
                className="analytics-event-category-chip-surface"
                style={getCategoryAccentStyles(catColor)}
              >
              <span
                className="analytics-event-category-dot"
                style={{ backgroundColor: catColor }}
              />
              {CATEGORY_LABELS[event.category]}
              </span>
            </span>
            <span className="analytics-event-title">
              {titleParts ? (
                <>
                  {titleParts[0]}
                  <span className="analytics-event-service-inline">
                    <BrandIcon value={brandValue} size={14} />
                    {event.serviceName}
                  </span>
                  {titleParts.slice(1).join(event.serviceName!)}
                </>
              ) : (
                <>
                  {event.serviceName && <span className="analytics-event-service-inline"><BrandIcon value={brandValue} size={14} />{event.serviceName}{" "}</span>}
                  {event.title}
                </>
              )}
            </span>
            <span className="analytics-event-time" title={new Date(event.timestamp).toLocaleString()}>
              {relativeTime(event.timestamp)}
            </span>
          </div>
          {(event.detail || hasRelated) && (
            <div className="analytics-event-detail">
              {event.detail && <span className="analytics-event-detail-text">{event.detail}</span>}
              {hasRelated && (
                <span className="analytics-event-correlated">+{event.relatedEvents.length} related</span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (item.type === "batch") {
    const batch = item as DisplayBatch;
    const isExpanded = expandedBatches.has(batch.id);
    const batchColor = CATEGORY_COLORS[batch.category] || SEVERITY_COLORS.info;

    return (
      <div style={style} className="analytics-event-row analytics-event-row-batch" onClick={() => onToggleBatch(batch.id)}>
        <div className="analytics-event-content">
          <div className="analytics-event-header">
            <span
              className={`activity-batch-arrow ${isExpanded ? "activity-batch-arrow-expanded" : ""}`}
              style={{ color: batchColor }}
            >
              {"\u25B8"}
            </span>
            <span className="analytics-event-category-chip">
              <span
                className="analytics-event-category-chip-surface"
                style={getCategoryAccentStyles(batchColor)}
              >
              <span
                className="analytics-event-category-dot"
                style={{ backgroundColor: batchColor }}
              />
              {CATEGORY_LABELS[batch.category]}
              </span>
            </span>
            <span className="analytics-event-title">{batch.title}</span>
            <span className="analytics-event-time" title={new Date(batch.timestamp).toLocaleString()}>
              {relativeTime(batch.timestamp)}
            </span>
          </div>
          <div className="analytics-event-detail">
            <span className="analytics-event-detail-text">{batch.detail}</span>
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "sub-event") {
    const event = item.event;
    return (
      <div style={style} className="analytics-event-row analytics-event-row-sub">
        <div className="analytics-event-content">
          <div className="analytics-event-header">
            <span
              className="analytics-event-category-chip"
            >
              <span
                className="analytics-event-category-chip-surface"
                style={getCategoryAccentStyles(
                  CATEGORY_COLORS[event.category] || SEVERITY_COLORS.info,
                )}
              >
              {CATEGORY_LABELS[event.category]}
              </span>
            </span>
            <span className="analytics-event-title">{event.title}</span>
            <span className="analytics-event-time" title={new Date(event.timestamp).toLocaleString()}>
              {relativeTime(event.timestamp)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return null;
});

// --- Main Component ---

interface AnalyticsViewProps {
  tabs: TabInfo[];
  graphNodes: GraphNode[];
}

export function AnalyticsView({ tabs, graphNodes }: AnalyticsViewProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [metricHistory, setMetricHistory] = useState<MetricHistory>({});
  const [selectedRepo, setSelectedRepo] = useState<string>(ALL_REPOS);
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(() => new Set());
  const [enabledCategories, setEnabledCategories] = useState<Set<ActivityCategory>>(
    () => new Set(ALL_CATEGORIES)
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);

  // Fetch data
  const fetchData = useCallback(async () => {
    try {
      const [log, metrics] = await Promise.all([
        window.electronAPI?.getActivityLog?.(),
        window.electronAPI?.getMetricHistory?.(),
      ]);
      if (log) setEvents(log);
      if (metrics) setMetricHistory(metrics);
    } catch (err) {
      console.error("[AnalyticsView] fetch error:", err);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData]);

  // Real-time push events
  useEffect(() => {
    const unsub = window.electronAPI?.onActivityEvent?.((event) => {
      setEvents((prev) => [event, ...prev].slice(0, 500));
    });
    return () => unsub?.();
  }, []);

  // Resize observer for list height
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListHeight(entry.contentRect.height);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Build service name → repo label map (each node maps to exactly one repo)
  const serviceRepoMap = useMemo(
    () => buildServiceRepoMap(graphNodes, tabs),
    [graphNodes, tabs]
  );

  // Build project path/name → tab label lookup for events whose service left the graph
  const projectToRepo = useMemo(() => {
    const map = new Map<string, string>();
    for (const tab of tabs) {
      if (tab.id === "__system__") continue;
      // tab.id is the full path, tab.label is the basename
      map.set(tab.id, tab.label);
      map.set(tab.label, tab.label);
    }
    return map;
  }, [tabs]);

  // Count services per repo
  const serviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    serviceRepoMap.forEach((label) => {
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    return counts;
  }, [serviceRepoMap]);

  // Filter nodes by selected repo — done ONCE, passed to all children
  const filteredNodes = useMemo(() => {
    if (selectedRepo === ALL_REPOS) return graphNodes;
    return graphNodes.filter((n) => {
      if (!n.name || n.type === "external") return false;
      return serviceRepoMap.get(n.name) === selectedRepo;
    });
  }, [graphNodes, selectedRepo, serviceRepoMap]);

  // Build set of all service names belonging to each repo (for title-based fallback matching)
  const repoServiceNames = useMemo(() => {
    const map = new Map<string, Set<string>>();
    serviceRepoMap.forEach((label, name) => {
      if (!map.has(label)) map.set(label, new Set());
      map.get(label)!.add(name);
    });
    return map;
  }, [serviceRepoMap]);

  // Filter events by selected repo and category
  const filteredEvents = useMemo(() => {
    let result = events;
    if (selectedRepo !== ALL_REPOS) {
      result = result.filter((e) => {
        // Check if service is in the live graph map
        if (e.serviceName && serviceRepoMap.get(e.serviceName) === selectedRepo) return true;
        // Fallback: match event's projectName against tab labels (for services that left the graph)
        if (e.projectName && projectToRepo.get(e.projectName) === selectedRepo) return true;
        // Last resort: check if the event title or detail mentions any service name from this repo
        const names = repoServiceNames.get(selectedRepo);
        if (names) {
          const text = `${e.title} ${e.detail || ""}`;
          let found = false;
          names.forEach((name) => { if (text.includes(name)) found = true; });
          if (found) return true;
        }
        // Or if the title/detail contains the repo label itself (e.g. "robot-shop" in "Stopped container robot-shop-cart-1")
        if (e.title.includes(selectedRepo)) return true;
        return false;
      });
    }
    if (enabledCategories.size < ALL_CATEGORIES.length) {
      result = result.filter((e) => enabledCategories.has(e.category));
    }
    return result;
  }, [events, selectedRepo, serviceRepoMap, enabledCategories]);

  const toggleCategory = useCallback((cat: ActivityCategory) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Batch consecutive discovery/removal events for display
  const batchedItems = useMemo(() => batchEvents(filteredEvents), [filteredEvents]);

  // Flatten batched items: expand batches that are toggled open
  const flatItems = useMemo((): DisplayItem[] => {
    const flat: DisplayItem[] = [];
    for (const item of batchedItems) {
      flat.push(item);
      if (item.type === "batch" && expandedBatches.has(item.id)) {
        for (const sub of item.events) {
          flat.push({ type: "sub-event", event: sub });
        }
      }
    }
    return flat;
  }, [batchedItems, expandedBatches]);

  const toggleBatch = useCallback((id: string) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Map service names to graph nodes for brand icon lookup
  const nodeByName = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of graphNodes) {
      if (node.name) map.set(node.name, node);
    }
    return map;
  }, [graphNodes]);

  const rowProps = useMemo(
    (): EventRowProps => ({ items: flatItems, expandedBatches, onToggleBatch: toggleBatch, nodeByName }),
    [flatItems, expandedBatches, toggleBatch, nodeByName]
  );

  return (
    <div className="analytics-view">
      {/* Repo selector — full width */}
      <RepoSelector
        tabs={tabs}
        selectedRepo={selectedRepo}
        onSelectRepo={setSelectedRepo}
        serviceCounts={serviceCounts}
      />

      {/* Two-column layout */}
      <div className="activity-columns">
        {/* Left: Stack Overview + Resource Breakdown */}
        <div className="activity-col-left">
          <StackOverview
            graphNodes={filteredNodes}
            events={filteredEvents}
            metricHistory={metricHistory}
          />
          <ResourceBreakdown
            graphNodes={filteredNodes}
            metricHistory={metricHistory}
          />
        </div>

        {/* Right: Event Timeline */}
        <div className="activity-col-right">
          <div className="activity-timeline-filters">
            {ALL_CATEGORIES.map((cat) => (
              <button
                key={cat}
                className={`activity-filter-chip ${enabledCategories.has(cat) ? "activity-filter-chip-active" : ""}`}
                onClick={() => toggleCategory(cat)}
                aria-pressed={enabledCategories.has(cat)}
                style={getCategoryAccentStyles(CATEGORY_COLORS[cat])}
              >
                <span
                  className="activity-filter-chip-dot"
                  style={{ backgroundColor: CATEGORY_COLORS[cat] }}
                />
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
          <div className="analytics-event-list" ref={listRef}>
            {flatItems.length === 0 ? (
              <div className="analytics-empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.2" opacity="0.3">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <p>
                  Fere is watching your stack. Events will appear here as services start, stop, crash, or change.
                </p>
              </div>
            ) : (
              <List
                rowComponent={EventRow}
                rowProps={rowProps}
                rowCount={flatItems.length}
                rowHeight={EVENT_ROW_HEIGHT}
                style={{ height: '100%' }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
