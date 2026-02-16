import { useState, useCallback, useRef, useEffect } from "react";
import { HEALTH_COLORS } from "../graph/constants";
import { SERVICE_COLORS } from "../graph/constants";
import { BrandIcon, inferServiceBrand } from "../graph/brandIcons";
import type { GraphNode } from "../../types/electron";
import type { KnownService, ServiceStatus } from "./useKnownServices";

interface ServiceDropdownProps {
  services: ServiceStatus[];
  dismissedServices: KnownService[];
  onDismiss: (name: string, type: string) => void;
  onRestore: (name: string, type: string) => void;
  onRemove: (name: string, type: string) => void;
  onAdd: (name: string, type: string) => void;
  allNodes: GraphNode[];
  onClose: () => void;
}

function typeLabel(type: string) {
  return (
    SERVICE_COLORS[type]?.label || type.charAt(0).toUpperCase() + type.slice(1)
  );
}

function AddServicesModal({
  addableNodes,
  onAdd,
  onClose,
}: {
  addableNodes: GraphNode[];
  onAdd: (name: string, type: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    for (const node of addableNodes) {
      const key = `${node.name}::${node.type}`;
      if (selected.has(key)) {
        onAdd(node.name, node.type);
      }
    }
    onClose();
  }, [addableNodes, selected, onAdd, onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content add-services-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">Add Services</h2>
          <button className="modal-close" onClick={onClose} type="button">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body add-services-modal-body">
          {addableNodes.length === 0 ? (
            <div className="add-services-empty">
              All active services are already tracked
            </div>
          ) : (
            <div className="add-services-list">
              {addableNodes.map((node) => {
                const key = `${node.name}::${node.type}`;
                const checked = selected.has(key);
                return (
                  <label
                    className={`add-services-row ${checked ? "add-services-row-selected" : ""}`}
                    key={key}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(key)}
                      className="add-services-checkbox"
                    />
                    <span
                      className="service-dropdown-dot"
                      style={{
                        backgroundColor:
                          node.healthStatus !== "red"
                            ? HEALTH_COLORS.green.color
                            : HEALTH_COLORS.red.color,
                        boxShadow:
                          node.healthStatus !== "red"
                            ? HEALTH_COLORS.green.glow
                            : HEALTH_COLORS.red.glow,
                      }}
                    />
                    <BrandIcon
                      value={inferServiceBrand(node)}
                      className="add-services-brand-icon"
                      size={16}
                    />
                    <span className="add-services-name">{node.name}</span>
                    <span className="service-dropdown-type">
                      {typeLabel(node.type)}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="modal-actions add-services-actions">
          <button className="modal-btn modal-btn-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleConfirm}
            disabled={selected.size === 0}
            type="button"
          >
            Add {selected.size > 0 ? `(${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ServiceDropdown({
  services,
  dismissedServices,
  onDismiss,
  onRestore,
  onRemove,
  onAdd,
  allNodes,
  onClose,
}: ServiceDropdownProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (showAddModal) return; // modal handles its own clicks
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        const target = e.target as HTMLElement;
        if (target.closest(".app-tab")) return;
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, showAddModal]);

  // Nodes available to add (not already tracked)
  const trackedKeys = new Set([
    ...services.map((s) => `${s.service.name}::${s.service.type}`),
    ...dismissedServices.map((s) => `${s.name}::${s.type}`),
  ]);
  const addableNodes = allNodes.filter(
    (n) => n.type !== "external" && !trackedKeys.has(`${n.name}::${n.type}`),
  );

  return (
    <>
      <div className="service-dropdown" ref={dropdownRef}>
        {services.length === 0 && dismissedServices.length === 0 && (
          <div className="service-dropdown-empty">No tracked services</div>
        )}

        {services.map((s) => (
          <div
            className="service-dropdown-row"
            key={`${s.service.name}::${s.service.type}`}
          >
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
            <span className="service-dropdown-type">
              {typeLabel(s.service.type)}
            </span>
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
                  transform: showDismissed
                    ? "rotate(0deg)"
                    : "rotate(-90deg)",
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
                  <span className="service-dropdown-type">
                    {typeLabel(s.type)}
                  </span>
                  <button
                    className="service-dropdown-restore"
                    onClick={() => onRestore(s.name, s.type)}
                  >
                    Restore
                  </button>
                  <button
                    className="service-dropdown-remove"
                    title="Remove permanently"
                    onClick={() => onRemove(s.name, s.type)}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
                    </svg>
                  </button>
                </div>
              ))}
          </>
        )}

        {/* Add service button */}
        <button
          className="service-dropdown-add"
          onClick={() => setShowAddModal(true)}
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
      </div>

      {/* Add services modal */}
      {showAddModal && (
        <AddServicesModal
          addableNodes={addableNodes}
          onAdd={onAdd}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </>
  );
}
