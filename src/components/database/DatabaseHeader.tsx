import type { GraphNode } from "../../types/electron";

interface DatabaseHeaderProps {
  node: GraphNode;
  dbTypeLabel: string;
  activeTab: "data" | "query";
  onBack: () => void;
  onTabChange: (tab: "data" | "query") => void;
}

export function DatabaseHeader({
  node,
  dbTypeLabel,
  activeTab,
  onBack,
  onTabChange,
}: DatabaseHeaderProps) {
  const isRemote = (node.containerStatus || "").startsWith("saved-uri:");

  return (
    <header className="db-header">
      <div className="db-header-left">
        <button className="db-back-btn" onClick={onBack}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="db-header-info">
          <div className="db-header-title">
            <span className="db-name">{node.name}</span>
            {isRemote ? (
              <span className="db-status db-status-remote">remote</span>
            ) : node.containerState ? (
              <span className={`db-status db-status-${node.containerState}`}>
                {node.containerState}
              </span>
            ) : null}
          </div>
          <span className="db-type-badge">{dbTypeLabel}</span>
        </div>
      </div>
      <div className="db-header-tabs">
        <button
          className={`db-header-tab ${activeTab === "data" ? "active" : ""}`}
          onClick={() => onTabChange("data")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          Browse Data
        </button>
        <button
          className={`db-header-tab ${activeTab === "query" ? "active" : ""}`}
          onClick={() => onTabChange("query")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="16,18 22,12 16,6" />
            <polyline points="8,6 2,12 8,18" />
          </svg>
          Query Editor
        </button>
      </div>
    </header>
  );
}
