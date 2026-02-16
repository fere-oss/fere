import { useState, useCallback, useRef, useEffect } from "react";
import { HEALTH_COLORS } from "../graph/constants";
import { SERVICE_COLORS } from "../graph/constants";
import type { GraphNode } from "../../types/electron";
import type { KnownService, ServiceStatus } from "./useKnownServices";

interface ServiceDropdownProps {
  services: ServiceStatus[];
  dismissedServices: KnownService[];
  onDismiss: (name: string, type: string) => void;
  onRestore: (name: string, type: string) => void;
  onAdd: (name: string, type: string) => void;
  allNodes: GraphNode[];
  onClose: () => void;
}

export function ServiceDropdown({
  services,
  dismissedServices,
  onDismiss,
  onRestore,
  onAdd,
  allNodes,
  onClose,
}: ServiceDropdownProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        // Check if the click is on the parent tab button (handled by App.tsx)
        const target = e.target as HTMLElement;
        if (target.closest(".app-tab")) return;
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Nodes available to add (not already tracked)
  const trackedKeys = new Set([
    ...services.map((s) => `${s.service.name}::${s.service.type}`),
    ...dismissedServices.map((s) => `${s.name}::${s.type}`),
  ]);
  const addableNodes = allNodes.filter(
    (n) => n.type !== "external" && !trackedKeys.has(`${n.name}::${n.type}`),
  );

  const handleAdd = useCallback(
    (node: GraphNode) => {
      onAdd(node.name, node.type);
      setShowAddPicker(false);
    },
    [onAdd],
  );

  const typeLabel = (type: string) =>
    SERVICE_COLORS[type]?.label || type.charAt(0).toUpperCase() + type.slice(1);

  return (
    <div className="service-dropdown" ref={dropdownRef}>
      {services.length === 0 && dismissedServices.length === 0 && (
        <div className="service-dropdown-empty">No tracked services</div>
      )}

      {services.map((s) => (
        <div className="service-dropdown-row" key={`${s.service.name}::${s.service.type}`}>
          <span
            className="service-dropdown-dot"
            style={{
              backgroundColor: s.running
                ? HEALTH_COLORS.green.color
                : HEALTH_COLORS.red.color,
              boxShadow: s.running
                ? HEALTH_COLORS.green.glow
                : HEALTH_COLORS.red.glow,
            }}
          />
          <span className="service-dropdown-name">{s.service.name}</span>
          <span className="service-dropdown-type">{typeLabel(s.service.type)}</span>
          <button
            className="service-dropdown-dismiss"
            title="Dismiss"
            onClick={() => onDismiss(s.service.name, s.service.type)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M4 4L12 12M12 4L4 12" />
            </svg>
          </button>
        </div>
      ))}

      {/* Dismissed section */}
      {dismissedServices.length > 0 && (
        <>
          <button
            className="service-dropdown-dismissed-toggle"
            onClick={() => setShowDismissed(!showDismissed)}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{
                transform: showDismissed ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
              }}
            >
              <path d="M4 6L8 10L12 6" />
            </svg>
            {dismissedServices.length} dismissed
          </button>
          {showDismissed &&
            dismissedServices.map((s) => (
              <div
                className="service-dropdown-row service-dropdown-row-dismissed"
                key={`dismissed-${s.name}::${s.type}`}
              >
                <span className="service-dropdown-dot service-dropdown-dot-dismissed" />
                <span className="service-dropdown-name service-dropdown-name-dismissed">
                  {s.name}
                </span>
                <span className="service-dropdown-type">{typeLabel(s.type)}</span>
                <button
                  className="service-dropdown-restore"
                  onClick={() => onRestore(s.name, s.type)}
                >
                  Restore
                </button>
              </div>
            ))}
        </>
      )}

      {/* Add service */}
      {!showAddPicker ? (
        <button
          className="service-dropdown-add"
          onClick={() => setShowAddPicker(true)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M8 3V13M3 8H13" />
          </svg>
          Add service
        </button>
      ) : (
        <div className="service-dropdown-picker">
          {addableNodes.length > 0 ? (
            addableNodes.map((node) => (
              <button
                key={node.id}
                className="service-dropdown-picker-item"
                onClick={() => handleAdd(node)}
              >
                <span className="service-dropdown-name">{node.name}</span>
                <span className="service-dropdown-type">
                  {typeLabel(node.type)}
                </span>
              </button>
            ))
          ) : (
            <div className="service-dropdown-picker-empty">
              All running services are tracked
            </div>
          )}
          <button
            className="service-dropdown-picker-cancel"
            onClick={() => setShowAddPicker(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
