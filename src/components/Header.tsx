import React from 'react';

interface HeaderProps {
  serviceCount: number;
  connectionCount: number;
  onRefresh: () => void;
}

export function Header({ serviceCount, connectionCount, onRefresh }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-drag-region" />
      <div className="header-content">
        <h1 className="header-title">Fere</h1>
        <div className="header-stats">
          <div className="stat">
            <span className="stat-value">{serviceCount}</span>
            <span className="stat-label">Services</span>
          </div>
          <div className="stat">
            <span className="stat-value">{connectionCount}</span>
            <span className="stat-label">Connections</span>
          </div>
        </div>
        <button className="refresh-btn" onClick={onRefresh} title="Refresh">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z"/>
          </svg>
        </button>
      </div>
    </header>
  );
}
