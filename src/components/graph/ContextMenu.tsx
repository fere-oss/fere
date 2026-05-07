import type { GraphNode } from "../../types/electron";

interface ContextMenuProps {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  onClose: () => void;
  onTraceRequest?: (node: GraphNode) => void;
}

export function ContextMenu({
  node,
  x,
  y,
  width,
  height,
  onClose,
  onTraceRequest,
}: ContextMenuProps) {
  const isNotRunning =
    !!node.isGhost ||
    node.healthStatus === "red" ||
    (node.isDockerContainer && node.containerState !== "running");
  const hasPort = !isNotRunning && node.ports.length > 0;
  const hasProjectPath = !!node.projectPath;
  const isExternal = node.type === "external";
  const isRemoteAccessNode = Boolean(node.remoteAccess?.host || node.remoteAccess?.tool);
  const isDockerContainerNode = Boolean(node.isDockerContainer && node.containerId);
  const canStartService = Boolean(
    isNotRunning &&
    (isDockerContainerNode ||
      ((node.startCommand || node.command) && (node.startProjectPath || node.projectPath))),
  );
  const canKillProcess =
    !isExternal && !isNotRunning && !isRemoteAccessNode && (isDockerContainerNode || node.pid > 0);
  const canKillRemoteSession =
    isRemoteAccessNode && !isDockerContainerNode && !isNotRunning && node.pid > 0;
  const canViewLogs = isDockerContainerNode && node.containerState === "running";
  const canCopyRemoteHost = Boolean(node.remoteAccess?.host);
  const canCopyRemoteCommand = Boolean(node.command);
  const remoteHostText = node.remoteAccess?.host
    ? `${node.remoteAccess.user ? `${node.remoteAccess.user}@` : ""}${node.remoteAccess.host}${node.remoteAccess.port ? `:${node.remoteAccess.port}` : ""}`
    : null;
  const canTrace = hasPort && (node.routes?.length ?? 0) > 0 && !!onTraceRequest;
  const mainPort = node.ports[0]?.port;

  const menuWidth = 200;
  let menuItems = 1; // copy pid
  if (hasPort) menuItems += 2; // open browser + copy port
  if (hasProjectPath) menuItems += 1; // open terminal
  if (canViewLogs) menuItems += 1; // view logs
  if (canTrace) menuItems += 1; // trace request
  if (canStartService) menuItems += 1; // start service
  if (canCopyRemoteHost) menuItems += 1; // copy remote host
  if (canCopyRemoteCommand) menuItems += 1; // copy full command
  if (canKillRemoteSession) menuItems += 1; // kill remote session
  if (canKillProcess) menuItems += 1; // kill
  const menuHeight = 32 + menuItems * 34;
  const menuStyle: React.CSSProperties = {
    position: "absolute",
    left: Math.min(x, width - menuWidth),
    top: Math.min(y, height - menuHeight),
    zIndex: 201,
  };

  const handleAction = (action: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const ensureSuccess = (
      result: { success?: boolean; error?: string } | undefined,
      label: string,
    ): boolean => {
      if (result?.success) return true;
      console.error(`${label} failed:`, result?.error);
      window.alert(result?.error || `${label} failed`);
      return false;
    };

    const performAction = async () => {
      let needsRefresh = false;
      try {
        switch (action) {
          case "open-browser":
            if (hasPort) {
              const result = await window.electronAPI.openUrl(`http://localhost:${mainPort}`);
              ensureSuccess(result, "Open in Browser");
            }
            break;
          case "open-terminal":
            if (hasProjectPath) {
              const result = await window.electronAPI.openTerminal(node.projectPath!);
              ensureSuccess(result, "Open in Terminal");
            }
            break;
          case "kill-process":
            if (isDockerContainerNode && node.containerId) {
              const result = await window.electronAPI.stopContainer(node.containerId);
              needsRefresh = ensureSuccess(result, "Kill Process");
            } else if (canKillProcess) {
              const result = await window.electronAPI.killProcess(node.pid);
              needsRefresh = ensureSuccess(result, "Kill Process");
            }
            break;
          case "kill-remote-session":
            if (canKillRemoteSession) {
              const result = await window.electronAPI.killProcess(node.pid);
              needsRefresh = ensureSuccess(result, "Kill Session");
            }
            break;
          case "start-service":
            if (isDockerContainerNode && node.containerId) {
              const result = await window.electronAPI.startContainer(node.containerId);
              needsRefresh = ensureSuccess(result, "Start Service");
            } else {
              const command = node.startCommand || node.command;
              const cwd = node.startProjectPath || node.projectPath;
              if (command && cwd) {
                const result = await window.electronAPI.startProcess(command, cwd);
                needsRefresh = ensureSuccess(result, "Start Service");
              }
            }
            break;
          case "view-logs":
            window.dispatchEvent(
              new CustomEvent("fere:view-container-logs", {
                detail: { containerId: node.containerId },
              }),
            );
            break;
          case "copy-port":
            if (hasPort) {
              const result = await window.electronAPI.copyText(String(mainPort));
              ensureSuccess(result, "Copy Port");
            }
            break;
          case "copy-pid":
            if (isNotRunning) {
              const result = await window.electronAPI.copyText(node.name);
              ensureSuccess(result, "Copy Service Name");
            } else {
              const result = await window.electronAPI.copyText(String(node.pid));
              ensureSuccess(result, "Copy PID");
            }
            break;
          case "copy-remote-host":
            if (canCopyRemoteHost && remoteHostText) {
              const result = await window.electronAPI.copyText(remoteHostText);
              ensureSuccess(result, "Copy Remote Host");
            }
            break;
          case "copy-remote-command":
            if (canCopyRemoteCommand) {
              const result = await window.electronAPI.copyText(node.command);
              ensureSuccess(result, "Copy Session Command");
            }
            break;
        }
      } catch (error) {
        console.error("Context menu action failed:", error);
      } finally {
        if (needsRefresh) {
          window.dispatchEvent(
            new CustomEvent("fere:optimistic-mark-down", {
              detail: { node },
            }),
          );
          window.dispatchEvent(new CustomEvent("fere:refresh-snapshot"));
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
          <div className="context-menu-item" onClick={handleAction("open-browser")}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M3.5 10h13M10 3.5c2.2 2 2.2 11 0 13M10 3.5c-2.2 2-2.2 11 0 13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span>Open in Browser</span>
          </div>
        )}
        {hasProjectPath && (
          <div className="context-menu-item" onClick={handleAction("open-terminal")}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect
                  x="2.5"
                  y="4"
                  width="15"
                  height="12"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M6 8l3 2-3 2M10 12h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>Open in Terminal</span>
          </div>
        )}
        {canViewLogs && (
          <div className="context-menu-item" onClick={handleAction("view-logs")}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect
                  x="3"
                  y="3"
                  width="14"
                  height="14"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M6 7h8M6 10h6M6 13h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span>View Logs</span>
          </div>
        )}
        {canTrace && (
          <div
            className="context-menu-item"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onTraceRequest!(node);
              onClose();
            }}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <circle
                  cx="5"
                  cy="10"
                  r="2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle
                  cx="15"
                  cy="5"
                  r="2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle
                  cx="15"
                  cy="15"
                  r="2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M7.5 9l5-3M7.5 11l5 3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span>Trace Request</span>
          </div>
        )}
        {canStartService && (
          <div className="context-menu-item" onClick={handleAction("start-service")}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <path d="M6 4l10 6-10 6V4z" fill="currentColor" />
              </svg>
            </span>
            <span>Start Service</span>
          </div>
        )}
        {canKillProcess && (
          <div
            className="context-menu-item context-menu-item-danger"
            onClick={handleAction("kill-process")}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <circle
                  cx="10"
                  cy="10"
                  r="6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span>Kill Process</span>
          </div>
        )}
        {canKillRemoteSession && (
          <div
            className="context-menu-item context-menu-item-danger"
            onClick={handleAction("kill-remote-session")}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <circle
                  cx="10"
                  cy="10"
                  r="6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span>Kill Session</span>
          </div>
        )}
        {(hasPort ||
          hasProjectPath ||
          !isExternal ||
          canCopyRemoteHost ||
          canCopyRemoteCommand) && <div className="context-menu-divider" />}
        {hasPort && (
          <div className="context-menu-item" onClick={handleAction("copy-port")}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect
                  x="6"
                  y="5"
                  width="10"
                  height="12"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <rect
                  x="3"
                  y="3"
                  width="10"
                  height="12"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
            </span>
            <span>Copy Port ({mainPort})</span>
          </div>
        )}
        <div className="context-menu-item" onClick={handleAction("copy-pid")}>
          <span className="context-menu-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="14" height="14">
              <rect
                x="6"
                y="5"
                width="10"
                height="12"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <rect
                x="3"
                y="3"
                width="10"
                height="12"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
          </span>
          <span>
            {isNotRunning ? `Copy Service Name (${node.name})` : `Copy PID (${node.pid})`}
          </span>
        </div>
        {canCopyRemoteHost && remoteHostText && (
          <div className="context-menu-item" onClick={handleAction("copy-remote-host")}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect
                  x="3"
                  y="4"
                  width="14"
                  height="12"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M6 10h8M10 7v6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span>Copy Remote Host ({remoteHostText})</span>
          </div>
        )}
        {canCopyRemoteCommand && (
          <div className="context-menu-item" onClick={handleAction("copy-remote-command")}>
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect
                  x="2.5"
                  y="4"
                  width="15"
                  height="12"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M6 8l2 2-2 2M10 12h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>Copy Session Command</span>
          </div>
        )}
      </div>
    </>
  );
}
