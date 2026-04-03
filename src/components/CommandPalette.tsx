import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { GraphNode, GraphEdge } from "../types/electron";
import { HEALTH_COLORS } from "./graph/constants";
import "./CommandPalette.css";

type ViewMode = "graph" | "containers" | "api-tester" | "database";

interface Tab {
  id: string;
  label: string;
  count: number;
  stackLabel: string | null;
}

interface CommandPaletteProps {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  tabs: Tab[];
  selectedTab: string;
  setSelectedTab: (id: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setIsAgentOpen: (open: boolean) => void;
}

type ResultCategory =
  | "Services"
  | "Ports"
  | "Routes"
  | "Projects"
  | "Actions"
  | "Service Actions";

interface SearchResult {
  id: string;
  category: ResultCategory;
  label: string;
  meta?: string;
  healthColor?: string;
  action: () => void;
}

export interface CommandPaletteHandle {
  focus: () => void;
}

function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function focusNode(nodeId: string, select = false) {
  window.dispatchEvent(
    new CustomEvent("fere:debug-focus-node", { detail: { nodeId, select } })
  );
}

const STATIC_ACTIONS: { label: string; mode: ViewMode | "agent" }[] = [
  { label: "Switch to Localhost Map", mode: "graph" },
  { label: "Switch to Containers", mode: "containers" },
  { label: "Switch to Requests", mode: "api-tester" },
  { label: "Switch to Database", mode: "database" },
  { label: "Open Fere AI", mode: "agent" },
];

export const CommandPalette = forwardRef<
  CommandPaletteHandle,
  CommandPaletteProps
>(function CommandPalette(
  { graph, tabs, selectedTab, setSelectedTab, setViewMode, setIsAgentOpen },
  ref
) {
  const SYSTEM_TAB_ID = "__system__";

  // Find which tab contains a node by matching its paths against tab IDs
  const findTabForNode = useCallback((node: GraphNode): string => {
    if (!node.projectPath) return SYSTEM_TAB_ID;
    // Check repoPath and projectPath against all tab IDs
    for (const tab of tabs) {
      if (tab.id === SYSTEM_TAB_ID) continue;
      if (node.repoPath && tab.id === node.repoPath) return tab.id;
      if (tab.id === node.projectPath) return tab.id;
      // Also check if the node's path is a subdirectory of a tab path
      if (node.projectPath.startsWith(tab.id + '/')) return tab.id;
      if (node.repoPath && node.repoPath.startsWith(tab.id + '/')) return tab.id;
    }
    return SYSTEM_TAB_ID;
  }, [tabs]);

  // Focus a node, switching tabs first if needed
  const focusServiceNode = useCallback((node: GraphNode) => {
    const nodeTab = findTabForNode(node);
    setViewMode("graph");
    if (nodeTab !== selectedTab) {
      setSelectedTab(nodeTab);
      // Longer delay to let the tab switch and graph re-render
      setTimeout(() => focusNode(node.id, true), 200);
    } else {
      setTimeout(() => focusNode(node.id, true), 50);
    }
  }, [findTabForNode, selectedTab, setSelectedTab, setViewMode]);

  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
    },
  }));

  // Debounce query
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 100);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // Build search results
  const results = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return [];

    const items: SearchResult[] = [];
    const categoryCounts: Record<ResultCategory, number> = {
      Services: 0,
      Ports: 0,
      Routes: 0,
      Projects: 0,
      Actions: 0,
      "Service Actions": 0,
    };
    const MAX_PER_CATEGORY = 3;
    const MAX_TOTAL = 8;

    const canAdd = (cat: ResultCategory) =>
      categoryCounts[cat] < MAX_PER_CATEGORY && items.length < MAX_TOTAL;

    // Score helper: lower is better, -1 means no match
    const score = (text: string): number => {
      const lower = text.toLowerCase();
      if (lower.startsWith(q)) return 0; // prefix
      const words = lower.split(/[\s\-_./]/);
      if (words.some((w) => w.startsWith(q))) return 1; // word start
      if (lower.includes(q)) return 2; // substring
      return -1;
    };

    // Services
    const serviceResults: (SearchResult & { score: number })[] = [];
    for (const node of graph.nodes) {
      const s = score(node.name);
      if (s === -1) continue;
      const portStr = node.ports.map((p) => p.port).join(", ");
      serviceResults.push({
        score: s,
        id: `service-${node.id}`,
        category: "Services",
        label: node.name,
        meta: portStr ? `:${portStr}` : node.type,
        healthColor:
          (HEALTH_COLORS[node.healthStatus] || HEALTH_COLORS.yellow).color,
        action: () => focusServiceNode(node),
      });
    }
    serviceResults.sort((a, b) => a.score - b.score);
    for (const r of serviceResults) {
      if (!canAdd("Services")) break;
      items.push(r);
      categoryCounts["Services"]++;
    }

    // Ports — match ":PORT" patterns
    if (/^\d+$/.test(q) || q.startsWith(":")) {
      const portQuery = q.replace(/^:/, "");
      for (const node of graph.nodes) {
        if (!canAdd("Ports")) break;
        for (const p of node.ports) {
          if (!canAdd("Ports")) break;
          if (String(p.port).startsWith(portQuery)) {
            items.push({
              id: `port-${node.id}-${p.port}`,
              category: "Ports",
              label: `:${p.port}`,
              meta: node.name,
              action: () => focusServiceNode(node),
            });
            categoryCounts["Ports"]++;
          }
        }
      }
    }

    // Routes
    for (const node of graph.nodes) {
      if (!canAdd("Routes")) break;
      if (!node.routes) continue;
      for (const route of node.routes) {
        if (!canAdd("Routes")) break;
        const routeStr = `${route.method} ${route.path}`;
        if (score(routeStr) === -1 && score(route.path) === -1) continue;
        items.push({
          id: `route-${node.id}-${route.method}-${route.path}`,
          category: "Routes",
          label: routeStr,
          meta: node.name,
          action: () => focusServiceNode(node),
        });
        categoryCounts["Routes"]++;
      }
    }

    // Projects
    for (const tab of tabs) {
      if (!canAdd("Projects")) break;
      if (score(tab.label) === -1) continue;
      items.push({
        id: `project-${tab.id}`,
        category: "Projects",
        label: tab.label,
        meta: tab.stackLabel || undefined,
        action: () => {
          setSelectedTab(tab.id);
          setViewMode("graph");
        },
      });
      categoryCounts["Projects"]++;
    }

    // Static actions
    for (const act of STATIC_ACTIONS) {
      if (!canAdd("Actions")) break;
      if (score(act.label) === -1) continue;
      items.push({
        id: `action-${act.mode}`,
        category: "Actions",
        label: act.label,
        action: () => {
          if (act.mode === "agent") {
            setIsAgentOpen(true);
          } else {
            setViewMode(act.mode);
          }
        },
      });
      categoryCounts["Actions"]++;
    }

    // Service actions (contextual)
    for (const node of graph.nodes) {
      if (!canAdd("Service Actions")) break;
      // Kill / stop
      if (node.isDockerContainer && node.containerId) {
        const containerId = node.containerId;
        if (score(`Stop ${node.name}`) !== -1 || score(node.name) !== -1) {
          if (canAdd("Service Actions")) {
            items.push({
              id: `kill-${node.id}`,
              category: "Service Actions",
              label: `Stop ${node.name}`,
              meta: "container",
              action: () => {
                window.electronAPI.stopContainer(containerId);
              },
            });
            categoryCounts["Service Actions"]++;
          }
        }
        // View logs
        if (
          score(`View ${node.name} logs`) !== -1 ||
          score(node.name) !== -1
        ) {
          if (canAdd("Service Actions")) {
            items.push({
              id: `logs-${node.id}`,
              category: "Service Actions",
              label: `View ${node.name} logs`,
              meta: "container",
              action: () => {
                setViewMode("containers");
                window.dispatchEvent(
                  new CustomEvent("fere:view-container-logs", {
                    detail: { containerId },
                  })
                );
              },
            });
            categoryCounts["Service Actions"]++;
          }
        }
      } else if (node.pid > 0) {
        const pid = node.pid;
        if (score(`Kill ${node.name}`) !== -1 || score(node.name) !== -1) {
          if (canAdd("Service Actions")) {
            items.push({
              id: `kill-${node.id}`,
              category: "Service Actions",
              label: `Kill ${node.name}`,
              meta: `pid ${pid}`,
              action: () => {
                window.electronAPI.killProcess(pid);
              },
            });
            categoryCounts["Service Actions"]++;
          }
        }
      }
      // Investigate
      if (
        score(`Investigate ${node.name}`) !== -1 ||
        score(node.name) !== -1
      ) {
        if (canAdd("Service Actions")) {
          const name = node.name;
          items.push({
            id: `investigate-${node.id}`,
            category: "Service Actions",
            label: `Investigate ${name}`,
            action: () => {
              setIsAgentOpen(true);
              window.dispatchEvent(
                new CustomEvent("fere:investigate-node", {
                  detail: {
                    nodeId: node.id,
                    nodeName: node.name,
                    healthStatus: node.healthStatus,
                    ports: (node.ports ?? []).map((port) => port.port),
                    command: node.command,
                  },
                }),
              );
            },
          });
          categoryCounts["Service Actions"]++;
        }
      }
    }

    return items;
  }, [
    debouncedQuery,
    focusServiceNode,
    graph.nodes,
    tabs,
    setViewMode,
    setSelectedTab,
    setIsAgentOpen,
  ]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Scroll selected item into view
  useEffect(() => {
    if (!dropdownRef.current) return;
    const selected = dropdownRef.current.querySelector(
      ".command-palette-item-selected"
    );
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setDebouncedQuery("");
    inputRef.current?.blur();
  }, []);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      result.action();
      close();
    },
    [close]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && results[selectedIndex]) {
        e.preventDefault();
        handleSelect(results[selectedIndex]);
      }
    },
    [results, selectedIndex, handleSelect, close]
  );

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest(".command-palette");
      if (!el) close();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen, close]);

  // Group results by category for display
  const grouped = useMemo(() => {
    const groups: { category: ResultCategory; items: SearchResult[] }[] = [];
    let currentCat: ResultCategory | null = null;
    for (const r of results) {
      if (r.category !== currentCat) {
        currentCat = r.category;
        groups.push({ category: r.category, items: [] });
      }
      groups[groups.length - 1].items.push(r);
    }
    return groups;
  }, [results]);

  // Track flat index for keyboard navigation
  let flatIndex = 0;

  return (
    <div className="command-palette">
      <div className="command-palette-input-wrapper">
        <span className="command-palette-icon">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11L14 14" strokeLinecap="round" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Search services, ports, actions..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => {
            if (query) setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {!isOpen && (
          <span className="command-palette-shortcut">
            {navigator.userAgent.toLowerCase().includes("mac") ? "⌘K" : "Ctrl+K"}
          </span>
        )}
      </div>

      {isOpen && query.trim() && (
        <div className="command-palette-dropdown" ref={dropdownRef}>
          {results.length === 0 ? (
            <div className="command-palette-empty">No results found</div>
          ) : (
            grouped.map((group) => (
              <div key={group.category}>
                <div className="command-palette-category">
                  {group.category}
                </div>
                {group.items.map((item) => {
                  const idx = flatIndex++;
                  return (
                    <button
                      key={item.id}
                      className={`command-palette-item${idx === selectedIndex ? " command-palette-item-selected" : ""}`}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={() => handleSelect(item)}
                    >
                      <span className="command-palette-item-icon">
                        {item.healthColor ? (
                          <span
                            className="command-palette-health"
                            style={{ background: item.healthColor }}
                          />
                        ) : (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path
                              d="M5 3L11 8L5 13"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      <span className="command-palette-item-label">
                        {highlightMatch(item.label, debouncedQuery)}
                      </span>
                      {item.meta && (
                        <span className="command-palette-item-meta">
                          {item.meta}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});
