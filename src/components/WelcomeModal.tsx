import { useEffect, useCallback } from 'react';

interface WelcomeModalProps {
  onClose: () => void;
}

export function WelcomeModal({ onClose }: WelcomeModalProps) {
  // Close on ESC key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="welcome-title" aria-modal="true">
        <div className="modal-header">
          <h2 className="modal-title" id="welcome-title">Welcome to Fere</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close welcome modal">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <p style={{ fontSize: '15px', lineHeight: '1.6', color: '#525252', marginBottom: '24px' }}>
            Fere visualizes your running services. Start a local server to see it appear.
          </p>

          <div className="modal-actions" style={{ borderTop: 'none', padding: 0 }}>
            <button
              className="modal-btn modal-btn-primary"
              onClick={onClose}
              style={{ width: '100%' }}
              autoFocus
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
