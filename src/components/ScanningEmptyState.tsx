export function ScanningEmptyState() {
  return (
    <div className="scanning-empty-state">
      <div className="scanning-radar">
        <div className="scanning-radar-ring scanning-radar-ring-1" />
        <div className="scanning-radar-ring scanning-radar-ring-2" />
        <div className="scanning-radar-ring scanning-radar-ring-3" />
        <div className="scanning-radar-dot" />
      </div>
      <p className="scanning-message">
        Start any local server and Fere will find it automatically
      </p>
      <p className="scanning-hint">
        Try running <code>npm start</code>, <code>python app.py</code>, or{" "}
        <code>docker-compose up</code>
      </p>
    </div>
  );
}
