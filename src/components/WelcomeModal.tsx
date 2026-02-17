import { useEffect, useCallback, useState, type ReactElement } from 'react';

interface WelcomeModalProps {
  onClose: () => void;
}

interface OnboardingStep {
  title: string;
  description: string;
  icon: ReactElement;
  details: string[];
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: 'Welcome to Fere',
    description: 'Visualize and manage your local development stack in real-time',
    icon: (
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="5" cy="12" r="3" />
        <circle cx="19" cy="8" r="3" />
        <circle cx="19" cy="16" r="3" />
        <path d="M8 12h8M8 12l8-3M8 12l8 3" strokeWidth="2" />
      </svg>
    ),
    details: [
      'Automatically discovers running services on your machine',
      'Visualizes connections between your microservices',
      'Monitors Docker containers, databases, and APIs',
    ],
  },
  {
    title: 'Service Map',
    description: 'See your entire architecture at a glance',
    icon: (
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
    details: [
      'Interactive graph showing all running services',
      'Click nodes to view ports, health status, and routes',
      'Organized by repository and project',
    ],
  },
  {
    title: 'Multiple Views',
    description: 'Explore your stack from different perspectives',
    icon: (
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <line x1="14" y1="4" x2="21" y2="4" />
        <line x1="14" y1="8" x2="21" y2="8" />
        <line x1="14" y1="15" x2="21" y2="15" />
        <line x1="14" y1="19" x2="21" y2="19" />
      </svg>
    ),
    details: [
      'Containers: Manage Docker containers and view logs',
      'Requests: Build and test API calls instantly',
      'Database: Query and explore database tables',
    ],
  },
  {
    title: 'Get Started',
    description: 'Ready to visualize your services',
    icon: (
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="currentColor" strokeWidth="1" />
      </svg>
    ),
    details: [
      'Start any local server: npm run dev, docker-compose up, etc.',
      'Fere will automatically detect and display it',
      'Right-click services for quick actions like stopping or restarting',
    ],
  },
];

export function WelcomeModal({ onClose }: WelcomeModalProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const isLastStep = currentStep === ONBOARDING_STEPS.length - 1;
  const isFirstStep = currentStep === 0;

  // Close on ESC key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowRight' && !isLastStep) {
      setCurrentStep((prev) => prev + 1);
    } else if (e.key === 'ArrowLeft' && !isFirstStep) {
      setCurrentStep((prev) => prev - 1);
    }
  }, [onClose, isLastStep, isFirstStep]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
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
                className={`welcome-progress-dot${index === currentStep ? ' active' : ''}${index < currentStep ? ' completed' : ''}`}
                onClick={() => setCurrentStep(index)}
                aria-label={`Go to step ${index + 1}`}
              />
            ))}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close welcome modal">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="modal-body welcome-body">
          <div className="welcome-icon">
            {step.icon}
          </div>

          <h2 className="welcome-title" id="welcome-title">{step.title}</h2>
          <p className="welcome-description">{step.description}</p>

          <ul className="welcome-details">
            {step.details.map((detail, index) => (
              <li key={index}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>{detail}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-actions">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={onClose}
          >
            Skip
          </button>
          <div className="welcome-nav-buttons">
            {!isFirstStep && (
              <button
                className="modal-btn modal-btn-secondary"
                onClick={handlePrev}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              {isLastStep ? 'Get Started' : 'Next'}
              {!isLastStep && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
