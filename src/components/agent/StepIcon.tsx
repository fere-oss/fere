import React, { useEffect, useState } from "react";
import type { ChatStep } from "../../types/electron";

const STEP_ICON_BASE_PATH = `${process.env.PUBLIC_URL || ""}/sentinel-step-icons`;

function getStepIconPngPath(stepType: ChatStep["type"]): string | null {
  switch (stepType) {
    case "list_directory":
      return `${STEP_ICON_BASE_PATH}/folder.png`;
    case "run_command":
      return `${STEP_ICON_BASE_PATH}/terminal.png`;
    case "get_node_details":
      return `${STEP_ICON_BASE_PATH}/search.png`;
    case "docker_logs":
    case "docker_exec":
    case "docker_control":
      return `${STEP_ICON_BASE_PATH}/docker-box.png`;
    case "read_file":
      return `${STEP_ICON_BASE_PATH}/file.png`;
    default:
      return null;
  }
}

function renderDefaultStepIcon(stepType: ChatStep["type"]): React.ReactElement {
  if (stepType === "list_directory") {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1 3.5C1 2.95 1.45 2.5 2 2.5h2.5l1 1H10c.55 0 1 .45 1 1v4.5c0 .55-.45 1-1 1H2c-.55 0-1-.45-1-1V3.5z" />
      </svg>
    );
  }

  if (stepType === "run_command") {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="1" y="1.5" width="10" height="9" rx="1.5" />
        <path d="M3.5 4.5l2 2-2 2" />
        <path d="M7.5 8.5h1" />
      </svg>
    );
  }

  if (stepType === "get_node_details") {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="5" cy="5" r="2.5" />
        <path d="M7 7l2.5 2.5" />
      </svg>
    );
  }

  if (stepType === "docker_logs" || stepType === "docker_exec" || stepType === "docker_control") {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="1.5" y="3" width="9" height="7" rx="1" />
        <path d="M4 3V2M8 3V2" />
        <path d="M4 6.5h4M4 8.5h2" />
      </svg>
    );
  }

  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 1.5h5.5L10 4v7H2V1.5z" />
      <path d="M7.5 1.5V4H10" />
      <path d="M4 6.5h4M4 8.5h2.5" />
    </svg>
  );
}

export function StepIcon({ stepType }: { stepType: ChatStep["type"] }): React.ReactElement {
  const pngPath = getStepIconPngPath(stepType);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [pngPath]);

  if (pngPath && !imageFailed) {
    return (
      <img
        src={pngPath}
        alt=""
        aria-hidden="true"
        className="agp-step-icon-image"
        onError={() => setImageFailed(true)}
      />
    );
  }

  return renderDefaultStepIcon(stepType);
}
