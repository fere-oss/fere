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
  const mainPort = node.ports[0]?.port;

  const menuWidth = 200;
  const menuHeight = 250;
  const menuStyle: React.CSSProperties = {
    position: 'absolute',
    left: Math.min(x, width - menuWidth),
    top: Math.min(y, height - menuHeight),
    zIndex: 201,
  };

  const handleAction = (action: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('Context menu action clicked:', action, { hasPort, mainPort, hasProjectPath, projectPath: node.projectPath, pid: node.pid });

    const performAction = async () => {
      try {
        switch (action) {
          case 'open-browser':
            if (hasPort) {
              console.log('Opening browser:', `http://localhost:${mainPort}`);
              const result = await window.electronAPI.openUrl(`http://localhost:${mainPort}`);
              console.log('Open browser result:', result);
            }
            break;
          case 'open-terminal':
            if (hasProjectPath) {
              console.log('Opening terminal:', node.projectPath);
              const result = await window.electronAPI.openTerminal(node.projectPath!);
              console.log('Open terminal result:', result);
            }
            break;
          case 'restart':
            if (!isExternal) {
              console.log('Killing process:', node.pid);
              const result = await window.electronAPI.killProcess(node.pid);
              console.log('Kill process result:', result);
            }
            break;
          case 'copy-port':
            if (hasPort) {
              console.log('Copying port:', mainPort);
              await navigator.clipboard.writeText(String(mainPort));
              console.log('Port copied');
            }
            break;
          case 'copy-pid':
            console.log('Copying PID:', node.pid);
            await navigator.clipboard.writeText(String(node.pid));
            console.log('PID copied');
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
        {!isExternal && (
          <div
            className="context-menu-item context-menu-item-danger"
            onClick={handleAction('restart')}
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
