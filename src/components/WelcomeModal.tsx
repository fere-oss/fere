import {
  useEffect,
  useCallback,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import fereLogo from "../assets/fere.png";

interface WelcomeModalProps {
  onClose: () => void;
}

interface OnboardingStep {
  title: string;
  description: string;
  icon?: ReactElement;
  iconClassName?: string;
  details: string[];
}

const RAW_LOGO_DEV_TOKEN = (process.env.REACT_APP_LOGO_DEV_TOKEN || "").trim();
const LOGO_DEV_TOKEN = RAW_LOGO_DEV_TOKEN.startsWith("pk_")
  ? RAW_LOGO_DEV_TOKEN
  : "";
const APP_LOGO_SRC = fereLogo;

function getLogoDevUrl(domain: string): string {
  const params = new URLSearchParams({
    size: "64",
    format: "png",
    fallback: "monogram",
  });
  if (LOGO_DEV_TOKEN) {
    params.set("token", LOGO_DEV_TOKEN);
  }
  return `https://img.logo.dev/${domain}?${params.toString()}`;
}

function ServiceMapNode({
  label,
  domain,
  className,
}: {
  label: string;
  domain: string;
  className: string;
}) {
  return (
    <div className={`service-map-node ${className}`}>
      <span className="service-map-node-mark">
        <img
          src={getLogoDevUrl(domain)}
          alt={`${label} logo`}
          className="service-map-node-logo"
          loading="lazy"
          decoding="async"
          referrerPolicy="origin"
        />
      </span>
      <span className="service-map-node-name">{label}</span>
    </div>
  );
}

function ServiceMapPreview() {
  return (
    <div className="service-map-preview" aria-hidden="true">
      <svg
        className="service-map-streams"
        viewBox="0 0 420 220"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path className="service-map-stream stream-a" d="M86 44 C138 52 176 74 210 102" />
        <path className="service-map-stream stream-b" d="M330 44 C292 62 248 76 210 102" />
        <path className="service-map-stream stream-c" d="M330 176 C286 158 248 136 210 102" />
        <path className="service-map-stream stream-d" d="M86 176 C126 152 166 132 210 102" />
      </svg>

      <div className="service-map-node service-map-core">
        <span className="service-map-node-mark">
          <img
            src={APP_LOGO_SRC}
            alt="Fere logo"
            className="service-map-node-logo service-map-core-logo"
            loading="lazy"
            decoding="async"
          />
        </span>
      </div>

      <ServiceMapNode
        label="Node.js"
        domain="nodejs.org"
        className="service-map-node-web"
      />
      <ServiceMapNode
        label="Docker"
        domain="docker.com"
        className="service-map-node-pay"
      />
      <ServiceMapNode
        label="RabbitMQ"
        domain="rabbitmq.com"
        className="service-map-node-db"
      />
      <ServiceMapNode
        label="Redis"
        domain="redis.io"
        className="service-map-node-cache"
      />
    </div>
  );
}

function WelcomeIntroPreview() {
  return (
    <div className="welcome-intro-preview" aria-hidden="true">
      <img
        src={APP_LOGO_SRC}
        alt="Fere logo"
        className="welcome-intro-logo"
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

function ContainerLogsPreview() {
  const logLines = [
    {
      tone: "ms-blue",
      node: "analytics-api-1",
      time: "06:14:21",
      message: "GET /health 200",
    },
    {
      tone: "pink",
      node: "mongodb-primary-1",
      time: "06:14:26",
      message: "checkpoint snapshot saved",
    },
    {
      tone: "nvidia-green",
      node: "event-bus",
      time: "06:14:32",
      message: "accepting AMQP connection",
    },
    {
      tone: "pink",
      node: "inventory-api-2",
      time: "06:14:33",
      message: "rabbitmq connection timeout",
    },
    {
      tone: "nvidia-green",
      node: "python-worker",
      time: "06:14:34",
      message: "queue payments synced",
    },
    {
      tone: "ms-blue",
      node: "docker-engine",
      time: "06:14:36",
      message: "container orders-api restarted",
    },
  ];

  return (
    <div className="multi-views-preview" aria-hidden="true">
      <div className="multi-views-code-block">
        <div className="multi-views-code-scroll">
          {logLines.map((line, index) => {
            const chars = line.node.length + line.time.length + line.message.length + 4;
            return (
              <div
                key={`line-${index}`}
                className={`multi-views-code-line tone-${line.tone}`}
                style={
                  {
                    "--chars": chars,
                    "--line-delay": `${index * 1.2}s`,
                  } as CSSProperties
                }
              >
                <span className="multi-views-token-node">{line.node}</span>
                <span className="multi-views-token-time">{line.time}</span>
                {line.message}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RequestsPreview() {
  return (
    <div className="requests-preview" aria-hidden="true">
      <div className="requests-preview-card">
        <div className="requests-preview-method">
          <span className="requests-method-badge">GET</span>
          <span className="requests-url">localhost:3000/api/users</span>
        </div>
        <div className="requests-preview-divider" />
        <div className="requests-preview-response">
          <span className="requests-status-badge">200</span>
          <div className="requests-json">
            <span className="requests-json-bracket">{"{"}</span>
            <span className="requests-json-line">
              <span className="requests-json-key">"users"</span>
              <span className="requests-json-colon">: </span>
              <span className="requests-json-bracket">[</span>
              <span className="requests-json-value">...</span>
              <span className="requests-json-bracket">]</span>
            </span>
            <span className="requests-json-bracket">{"}"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SharePreview() {
  return (
    <div className="share-preview" aria-hidden="true">
      <div className="share-preview-card">
        <div className="share-preview-header">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#171717" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="3" r="2" />
            <circle cx="4" cy="8" r="2" />
            <circle cx="12" cy="13" r="2" />
            <line x1="5.7" y1="7" x2="10.3" y2="4" />
            <line x1="5.7" y1="9" x2="10.3" y2="12" />
          </svg>
          <span className="share-preview-title">Share Localhost Map</span>
        </div>
        <div className="share-preview-url-row">
          <div className="share-preview-url">
            <span className="share-preview-url-text">https://gist.github.com/user/a1b2c3</span>
          </div>
          <div className="share-preview-copy">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="7" height="7" rx="1" />
              <path d="M9 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v5a1 1 0 001 1h2" />
            </svg>
          </div>
        </div>
        <div className="share-preview-status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span>Published just now</span>
        </div>
      </div>
    </div>
  );
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: "Welcome to Fere",
    description: "Your local dev environment, finally visible.",
    icon: <WelcomeIntroPreview />,
    iconClassName: "welcome-icon-service-map welcome-icon-intro",
    details: [],
  },
  {
    title: "Localhost Map",
    description: "See your entire architecture at a glance",
    icon: <ServiceMapPreview />,
    iconClassName: "welcome-icon-service-map",
    details: [
      "Auto-discovers services, ports, and connections",
      "Tracks health and alerts you when something goes down",
      "No config files — just run your stack",
    ],
  },
  {
    title: "Get Started",
    description: "You're ready to go",
    icon: <WelcomeIntroPreview />,
    iconClassName: "welcome-icon-service-map welcome-icon-intro",
    details: [
      "Start any local server or run docker-compose up",
      "Click a node to see routes, connections, and health",
      "Fere runs in the background — it'll notify you if something breaks",
    ],
  },
];

export function WelcomeModal({ onClose }: WelcomeModalProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const isLastStep = currentStep === ONBOARDING_STEPS.length - 1;
  const isFirstStep = currentStep === 0;

  // Close on ESC key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight" && !isLastStep) {
        setCurrentStep((prev) => prev + 1);
      } else if (e.key === "ArrowLeft" && !isFirstStep) {
        setCurrentStep((prev) => prev - 1);
      }
    },
    [onClose, isLastStep, isFirstStep],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleNext = () => {
    if (isLastStep) {
      onClose();
    } else {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    setCurrentStep((prev) => Math.max(0, prev - 1));
  };

  const step = ONBOARDING_STEPS[currentStep];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content welcome-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="welcome-title"
        aria-modal="true"
      >
        <div className="modal-header">
          <div className="welcome-progress">
            {ONBOARDING_STEPS.map((_, index) => (
              <button
                key={index}
                className={`welcome-progress-dot${index === currentStep ? " active" : ""}${index < currentStep ? " completed" : ""}`}
                onClick={() => setCurrentStep(index)}
                aria-label={`Go to step ${index + 1}`}
              />
            ))}
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close welcome modal"
          >
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

        <div className="modal-body welcome-body">
          {step.icon && (
            <div
              className={`welcome-icon${step.iconClassName ? ` ${step.iconClassName}` : ""}`}
            >
              {step.icon}
            </div>
          )}

          <h2 className="welcome-title" id="welcome-title">
            {step.title}
          </h2>
          <p className="welcome-description">{step.description}</p>

          {step.details.length > 0 && (
            <ul className="welcome-details">
              {step.details.map((detail, index) => (
                <li key={index}>
                  <span className="welcome-detail-bullet" aria-hidden="true" />
                  <span>{detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            Skip
          </button>
          <div className="welcome-nav-buttons">
            {!isFirstStep && (
              <button
                className="modal-btn modal-btn-secondary"
                onClick={handlePrev}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                Previous
              </button>
            )}
            <button
              className="modal-btn modal-btn-primary"
              onClick={handleNext}
              autoFocus
            >
              {isLastStep ? "Let's go" : "Next"}
              {!isLastStep && (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
