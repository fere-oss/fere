import { useState, useEffect, useRef } from "react";

interface Props {
  onKeyChanged: () => void;
}

export function ApiKeySetup({ onKeyChanged }: Props) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.electronAPI.getApiKeyStatus().then((s) => setHasKey(s.hasKey));
  }, []);

  async function handleSave() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    setError("");
    const result = await window.electronAPI.setApiKey(trimmed);
    setSaving(false);
    if (result.success) {
      setKeyInput("");
      setHasKey(true);
      onKeyChanged();
    } else {
      setError(result.error || "Failed to save key");
    }
  }

  async function handleClear() {
    const result = await window.electronAPI.clearApiKey();
    if (result.success) {
      setHasKey(false);
      onKeyChanged();
    }
  }

  if (hasKey === null) return null;

  const keyStorageDetails = (
    <ul className="agp-key-details agp-key-details-inline">
      <li>Encrypted at rest using macOS Keychain</li>
      <li>Never leaves your machine</li>
      <li>Used only for direct API calls to <code>api.openai.com</code></li>
    </ul>
  );

  return (
    <div className="agp-key-setup">
      {hasKey ? (
        <>
          <div className="agp-key-status">
            <div className="agp-key-status-row">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span className="agp-key-saved-label">API key saved</span>
            </div>
            <div className="agp-key-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Encrypted with macOS Keychain
            </div>
          </div>
          <div className="agp-key-actions">
            <button
              className="agp-key-details-toggle"
              onClick={() => setShowDetails(!showDetails)}
            >
              {showDetails ? "Hide" : "How is my key stored?"}
            </button>
            <button className="agp-key-remove-btn" onClick={handleClear}>
              Remove key
            </button>
          </div>
          {showDetails && (
            <ul className="agp-key-details">
              <li>Encrypted at rest using macOS Keychain — same mechanism used by 1Password and VS Code</li>
              <li>Never leaves your machine — no Fere servers, no proxies</li>
              <li>Used only for direct API calls to <code>api.openai.com</code></li>
              <li>You can verify this with any network inspector (e.g. Charles, Proxyman)</li>
              <li>Alternatively, set <code>OPENAI_API_KEY</code> in your shell profile to skip in-app storage entirely</li>
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="agp-key-prompt">
            <span className="agp-key-prompt-label">Add your OpenAI API key for unlimited calls</span>
          </div>
          {keyStorageDetails}
          <div className="agp-key-input-row">
            <div className="agp-key-input-wrap">
              <input
                ref={inputRef}
                className="agp-key-input"
                type={showKey ? "text" : "password"}
                placeholder="sk-..."
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                disabled={saving}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="agp-key-show-toggle"
                onClick={() => setShowKey(!showKey)}
                tabIndex={-1}
                title={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <button
              className="agp-key-save-btn"
              onClick={handleSave}
              disabled={saving || !keyInput.trim()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {error && <div className="agp-key-error">{error}</div>}
          <div className="agp-key-alt-hint">
            Or set <code>OPENAI_API_KEY</code> in your environment
          </div>
        </>
      )}
    </div>
  );
}
