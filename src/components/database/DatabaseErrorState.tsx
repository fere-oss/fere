interface DatabaseErrorStateProps {
  error: string;
  onRetry: () => void;
}

export function DatabaseErrorState({ error, onRetry }: DatabaseErrorStateProps) {
  return (
    <div className="db-error-state">
      <div className="db-error-icon">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
        >
          <path d="M10.7 13.3a4 4 0 0 1 0-5.6l1.7-1.7a4 4 0 1 1 5.6 5.6l-1.7 1.7" />
          <path d="M13.3 10.7a4 4 0 0 1 0 5.6l-1.7 1.7a4 4 0 1 1-5.6-5.6l1.7-1.7" />
        </svg>
      </div>
      <span className="db-error-title">Connection Error</span>
      <span className="db-error-message">{error}</span>
      <button className="db-error-retry" onClick={onRetry}>
        Try Again
      </button>
    </div>
  );
}
