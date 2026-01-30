interface DatabaseErrorStateProps {
  error: string;
  onRetry: () => void;
}

export function DatabaseErrorState({ error, onRetry }: DatabaseErrorStateProps) {
  return (
    <div className="db-error-state">
      <div className="db-error-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
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
