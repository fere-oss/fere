import { useState, useMemo } from 'react';
import type { GraphNode } from '../types/electron';
import { ContainerLogsPanel } from './ContainerLogsPanel';

interface ContainerLogsTabProps {
  containers: GraphNode[];
}

export function ContainerLogsTab({ containers }: ContainerLogsTabProps) {
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);

  // Group containers by project for better organization
  const containersByProject = useMemo(() => {
    const groups = new Map<string, GraphNode[]>();

    containers.forEach(container => {
      const project = container.projectPath?.split('/').pop() || 'Other';
      if (!groups.has(project)) {
        groups.set(project, []);
      }
      groups.get(project)!.push(container);
    });

    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [containers]);

  const selectedContainer = useMemo(() =>
    containers.find(c => c.containerId === selectedContainerId),
    [containers, selectedContainerId]
  );

  if (containers.length === 0) {
    return (
      <div className="logs-tab-empty">
        <div className="logs-tab-empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </div>
        <p>No containers available</p>
        <span>Start some Docker containers to view logs</span>
      </div>
    );
  }

  return (
    <div className="logs-tab">
      {/* Container Selector */}
      <div className="logs-tab-header">
        <div className="logs-tab-selector">
          <label>Container</label>
          <select
            value={selectedContainerId || ''}
            onChange={(e) => setSelectedContainerId(e.target.value || null)}
          >
            <option value="">Select a container...</option>
            {containersByProject.map(([project, projectContainers]) => (
              <optgroup key={project} label={project}>
                {projectContainers.map(container => (
                  <option key={container.containerId} value={container.containerId}>
                    {container.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {selectedContainer && (
          <div className="logs-tab-info">
            <span className="logs-tab-container-id">
              {selectedContainer.containerId?.substring(0, 12)}
            </span>
            {selectedContainer.type && (
              <span className={`logs-tab-type logs-tab-type-${selectedContainer.type}`}>
                {selectedContainer.type}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Logs Panel */}
      <div className="logs-tab-content">
        {selectedContainer && selectedContainer.containerId ? (
          <ContainerLogsPanel
            key={selectedContainer.containerId}
            containerId={selectedContainer.containerId}
            containerName={selectedContainer.name}
          />
        ) : (
          <div className="logs-tab-placeholder">
            <div className="logs-tab-placeholder-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <h3>Select a container</h3>
            <p>Choose a container from the dropdown above to view its logs in real-time</p>
          </div>
        )}
      </div>
    </div>
  );
}
