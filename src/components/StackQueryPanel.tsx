import React, { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { QueryProgress } from "../types/electron";

interface StackQueryPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StackQueryPanel({ isOpen, onClose }: StackQueryPanelProps) {
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    window.electronAPI.debugGetApiKeyStatus().then((result) => {
      setHasApiKey(result.hasKey);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onQueryProgress(
      (progress: QueryProgress) => {
        switch (progress.type) {
          case "thinking":
            setLoading(true);
            setAnswer("");
            setError("");
            break;
          case "answer_delta":
            setAnswer((prev) => prev + progress.text);
            break;
          case "complete":
            setAnswer(progress.answer);
            setLoading(false);
            break;
          case "error":
            setError(progress.error);
            setLoading(false);
            break;
        }
      },
    );
    return unsubscribe;
  }, []);

  const handleSaveApiKey = useCallback(async () => {
    setApiKeyError("");
    const trimmed = apiKeyInput.trim();
    if (!trimmed || trimmed.length < 10) {
      setApiKeyError("Please enter a valid API key");
      return;
    }

    const result = await window.electronAPI.debugSetApiKey(trimmed);
    if (!result.success) {
      setApiKeyError(result.error || "Failed to save API key");
      return;
    }

    setHasApiKey(true);
  }, [apiKeyInput]);

  const handleSubmit = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setAnswer("");
    setError("");
    setLoading(true);
    const result = await window.electronAPI.queryStart({ query: trimmed });
    if (!result.success) {
      setError(result.error || "Failed to start query");
      setLoading(false);
    }
  }, [query]);

  const handleClose = useCallback(() => {
    window.electronAPI.queryStop();
    onClose();
  }, [onClose]);

  if (!isOpen || hasApiKey === null) return null;

  return (
    <div className="stack-query-panel">
      <div className="stack-query-panel-header">
        <div className="stack-query-panel-title-wrap">
          <div className="stack-query-panel-title">Ask Fere</div>
        </div>
        <button
          type="button"
          className="debug-panel-close stack-query-panel-close"
          onClick={handleClose}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>
      </div>

      {!hasApiKey ? (
        <div className="debug-panel-setup">
          <p className="debug-panel-setup-text">
            Enter your OpenAI API key to enable stack queries.
          </p>
          <input
            type="password"
            className="debug-panel-api-input"
            placeholder="sk-..."
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSaveApiKey();
            }}
          />
          {apiKeyError ? <p className="debug-panel-error">{apiKeyError}</p> : null}
          <button
            className="debug-panel-submit"
            onClick={handleSaveApiKey}
            disabled={!apiKeyInput.trim()}
          >
            Save Key
          </button>
        </div>
      ) : (
        <>
          <div className="stack-query-panel-composer">
            <textarea
              className="stack-query-panel-textarea"
              placeholder="What is using port 3001? What depends on Redis? Which services are idle?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              rows={3}
            />
            <div className="stack-query-panel-footer">
              <div className="stack-query-panel-suggestions">
                <button
                  type="button"
                  className="stack-query-panel-suggestion"
                  onClick={() => setQuery("What is using port 3001?")}
                >
                  Port 3001
                </button>
                <button
                  type="button"
                  className="stack-query-panel-suggestion"
                  onClick={() => setQuery("What depends on Redis?")}
                >
                  Redis deps
                </button>
                <button
                  type="button"
                  className="stack-query-panel-suggestion"
                  onClick={() => setQuery("Which services are idle right now?")}
                >
                  Idle services
                </button>
              </div>
              <button
                type="button"
                className="debug-panel-submit stack-query-panel-submit"
                onClick={handleSubmit}
                disabled={!query.trim() || loading}
              >
                Ask
              </button>
            </div>
          </div>

          {loading ? <div className="stack-query-panel-status">Thinking…</div> : null}
          {error ? <div className="debug-panel-error">{error}</div> : null}

          {answer ? (
            <div className="stack-query-panel-answer">
              <ReactMarkdown>{answer}</ReactMarkdown>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
