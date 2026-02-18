import type { GraphNode } from '../../types/electron';

interface ContextMenuProps {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  onClose: () => void;
}

export function ContextMenu({ node, x, y, width, height, onClose }: ContextMenuProps) {
  const hasPort = node.ports.length > 0;
  const hasProjectPath = !!node.projectPath;
  const isExternal = node.type === 'external';
  const isDockerContainerNode = Boolean(node.isDockerContainer && node.containerId);
  const canKillProcess = !isExternal && (isDockerContainerNode || node.pid > 0);
  const mainPort = node.ports[0]?.port;

  const menuWidth = 200;
  let menuItems = 1; // copy pid
  if (hasPort) menuItems += 2; // open browser + copy port
  if (hasProjectPath) menuItems += 1; // open terminal
  if (canKillProcess) menuItems += 1; // kill
  const menuHeight = 32 + menuItems * 34;
  const menuStyle: React.CSSProperties = {
    position: 'absolute',
    left: Math.min(x, width - menuWidth),
    top: Math.min(y, height - menuHeight),
    zIndex: 201,
  };

  const handleAction = (action: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const ensureSuccess = (result: { success?: boolean; error?: string } | undefined, label: string): boolean => {
      if (!result || result.success !== false) return true;
      console.error(`${label} failed:`, result.error);
      window.alert(result.error || `${label} failed`);
      return false;
    };

    const performAction = async () => {
      let needsRefresh = false;
      try {
        switch (action) {
          case 'open-browser':
            if (hasPort) {
              const result = await window.electronAPI.openUrl(`http://localhost:${mainPort}`);
              ensureSuccess(result, 'Open in Browser');
            }
            break;
          case 'open-terminal':
            if (hasProjectPath) {
              const result = await window.electronAPI.openTerminal(node.projectPath!);
              ensureSuccess(result, 'Open in Terminal');
            }
            break;
          case 'kill-process':
            if (isDockerContainerNode && node.containerId) {
              const result = await window.electronAPI.stopContainer(node.containerId);
              needsRefresh = ensureSuccess(result, 'Kill Process');
            } else if (canKillProcess) {
              const result = await window.electronAPI.killProcess(node.pid);
              needsRefresh = ensureSuccess(result, 'Kill Process');
            }
            break;
          case 'copy-port':
            if (hasPort) {
              await navigator.clipboard.writeText(String(mainPort));
            }
            break;
          case 'copy-pid':
            await navigator.clipboard.writeText(String(node.pid));
            break;
        }
      } catch (error) {
        console.error('Context menu action failed:', error);
      } finally {
        if (needsRefresh) {
          window.dispatchEvent(
            new CustomEvent("fere:optimistic-mark-down", {
              detail: { node },
            }),
          );
          window.dispatchEvent(new CustomEvent('fere:refresh-snapshot'));
        }
      }
    };

    performAction();
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  return (
    <>
      <div className="context-menu-backdrop" onClick={handleBackdropClick} />
      <div className="context-menu" style={menuStyle}>
        {hasPort && (
          <div
            className="context-menu-item"
            onClick={handleAction('open-browser')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M3.5 10h13M10 3.5c2.2 2 2.2 11 0 13M10 3.5c-2.2 2-2.2 11 0 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
            <span>Open in Browser</span>
          </div>
        )}
        {hasProjectPath && (
          <div
            className="context-menu-item"
            onClick={handleAction('open-terminal')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect x="2.5" y="4" width="15" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6 8l3 2-3 2M10 12h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>Open in Terminal</span>
          </div>
        )}
        {canKillProcess && (
          <div
            className="context-menu-item context-menu-item-danger"
            onClick={handleAction('kill-process')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </span>
            <span>Kill Process</span>
          </div>
        )}
        {(hasPort || hasProjectPath || !isExternal) && (
          <div className="context-menu-divider" />
        )}
        {hasPort && (
          <div
            className="context-menu-item"
            onClick={handleAction('copy-port')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect x="6" y="5" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <rect x="3" y="3" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
            <span>Copy Port ({mainPort})</span>
          </div>
        )}
        <div
          className="context-menu-item"
          onClick={handleAction('copy-pid')}
        >
          <span className="context-menu-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="14" height="14">
              <rect x="6" y="5" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <rect x="3" y="3" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </span>
          <span>Copy PID ({node.pid})</span>
        </div>
      </div>
    </>
  );
}
