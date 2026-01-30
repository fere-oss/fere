import type { GraphNode } from '../../types/electron';

interface ContextMenuProps {
  node: GraphNode;
  x: number;
  y: number;
  onClose: () => void;
}

export function ContextMenu({ node, x, y, onClose }: ContextMenuProps) {
  const hasPort = node.ports.length > 0;
  const hasProjectPath = !!node.projectPath;
  const isExternal = node.type === 'external';
  const mainPort = node.ports[0]?.port;

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 250),
    zIndex: 201,
  };

  const handleAction = (action: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const performAction = async () => {
      try {
        switch (action) {
          case 'open-browser':
            if (hasPort) {
              await window.electronAPI.openUrl(`http://localhost:${mainPort}`);
            }
            break;
          case 'open-terminal':
            if (hasProjectPath) {
              await window.electronAPI.openTerminal(node.projectPath!);
            }
            break;
          case 'restart':
            if (!isExternal) {
              await window.electronAPI.killProcess(node.pid);
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
          <div className="context-menu-item" onClick={handleAction('open-browser')}>
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
          <div className="context-menu-item" onClick={handleAction('open-terminal')}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <path d="M3.5 4.5h13v11h-13z" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6 7.5l2.5 2.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10.5 12.5h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </span>
            <span>Open in Terminal</span>
          </div>
        )}
        {!isExternal && (
          <div className="context-menu-item" onClick={handleAction('restart')}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <path d="M14.5 5.5a6 6 0 1 0 1.1 6.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M13.5 3.5v4h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>Restart Service</span>
          </div>
        )}
        {hasPort && (
          <div className="context-menu-item" onClick={handleAction('copy-port')}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect x="6" y="6" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <rect x="4" y="4" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
            <span>Copy Port</span>
          </div>
        )}
        <div className="context-menu-item" onClick={handleAction('copy-pid')}>
          <span className="context-menu-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="14" height="14">
              <rect x="5" y="4" width="10" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M7 4V2.5h6V4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </span>
          <span>Copy PID</span>
        </div>
      </div>
    </>
  );
}
