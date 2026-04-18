import { useState } from 'react';
import type { SystemSnapshot, BlueprintGapItem, GapStatus } from '../types/electron';
import { useBlueprintManager } from '../hooks/useBlueprintManager';
import './BlueprintPanel.css';

interface BlueprintPanelProps {
  onClose: () => void;
  snapshot: SystemSnapshot | null;
  projectPath: string | null;
  label: string;
}

function GapIcon({ status }: { status: GapStatus }) {
  if (status === 'ok') return <span className="blueprint-gap-icon" aria-label="ok">✓</span>;
  if (status === 'missing') return <span className="blueprint-gap-icon" aria-label="missing">✗</span>;
  return <span className="blueprint-gap-icon" aria-label={status}>⚠</span>;
}

function GapBadge({ status }: { status: GapStatus }) {
  const label =
    status === 'ok' ? 'ok' :
    status === 'missing' ? 'missing' :
    status === 'wrong-version' ? 'wrong ver' :
    status === 'wrong-port' ? 'wrong port' :
    'not running';
  const cls =
    status === 'ok' ? 'blueprint-gap-badge--ok' :
    status === 'missing' ? 'blueprint-gap-badge--missing' :
    'blueprint-gap-badge--wrong';
  return <span className={`blueprint-gap-badge ${cls}`}>{label}</span>;
}

function GapRow({ item }: { item: BlueprintGapItem }) {
  const cls =
    item.status === 'ok' ? 'blueprint-gap-ok' :
    item.status === 'missing' ? 'blueprint-gap-missing' :
    item.status === 'not-running' ? 'blueprint-gap-not-running' :
    'blueprint-gap-wrong';

  return (
    <div className={`blueprint-gap-row ${cls}`}>
      <GapIcon status={item.status} />
      <div className="blueprint-gap-content">
        <div className="blueprint-gap-name">{item.name}</div>
        {item.detail && <div className="blueprint-gap-detail">{item.detail}</div>}
      </div>
      <GapBadge status={item.status} />
    </div>
  );
}

function AccordionSection({
  title,
  items,
  open,
  onToggle,
}: {
  title: string;
  items: BlueprintGapItem[];
  open: boolean;
  onToggle: () => void;
}) {
  if (items.length === 0) return null;

  const issueCount = items.filter(i => i.status !== 'ok').length;

  return (
    <div className="blueprint-section">
      <button
        className="blueprint-section-header"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="blueprint-section-title">
          {title}
          {issueCount > 0 && (
            <span className={`blueprint-section-badge${issueCount > 0 && items.some(i => i.status === 'missing') ? '' : ' blueprint-section-badge--warn'}`}>
              {issueCount}
            </span>
          )}
        </span>
        <svg
          className={`blueprint-section-chevron${open ? ' blueprint-section-chevron--open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="2 4 6 8 10 4" />
        </svg>
      </button>
      {open && (
        <div className="blueprint-section-items">
          {items.map((item) => (
            <GapRow key={item.name} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BlueprintPanel({ onClose, snapshot, projectPath, label }: BlueprintPanelProps) {
  const {
    blueprint,
    checkResult,
    saving,
    checking,
    save,
    check,
    deleteBlueprint,
  } = useBlueprintManager(snapshot, projectPath);

  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(['services', 'containers', 'env'])
  );
  const [deletingConfirm, setDeletingConfirm] = useState(false);

  function toggleSection(key: string) {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasBlueprint = !!blueprint;

  // Determine completion bar color class
  const barColorClass = checkResult
    ? checkResult.completionPct >= 80
      ? ''
      : checkResult.completionPct >= 50
        ? 'blueprint-completion-bar-fill--warn'
        : 'blueprint-completion-bar-fill--danger'
    : '';

  function handleDelete() {
    if (!deletingConfirm) {
      setDeletingConfirm(true);
      return;
    }
    deleteBlueprint();
    setDeletingConfirm(false);
  }

  return (
    <div className="blueprint-panel" role="complementary" aria-label="Service Blueprint">
      {/* Header */}
      <div className="blueprint-panel-header">
        <div className="blueprint-panel-title">
          <svg
            className="blueprint-panel-title-icon"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="5" y1="6" x2="11" y2="6" />
            <line x1="5" y1="9" x2="9" y2="9" />
          </svg>
          Blueprint
        </div>
        <button
          className="blueprint-panel-close"
          onClick={onClose}
          aria-label="Close blueprint panel"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <line x1="2" y1="2" x2="12" y2="12" />
            <line x1="12" y1="2" x2="2" y2="12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="blueprint-panel-body">
        {/* Empty state */}
        {!hasBlueprint && (
          <div className="blueprint-empty">
            <svg
              className="blueprint-empty-icon"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <line x1="7" y1="9" x2="17" y2="9" />
              <line x1="7" y1="13" x2="13" y2="13" />
            </svg>
            <div className="blueprint-empty-title">No blueprint saved yet</div>
            <div className="blueprint-empty-desc">
              Save your current working stack as the canonical dev setup for this project.
            </div>
            <button
              className="blueprint-btn blueprint-btn--primary"
              onClick={() => save(label)}
              disabled={saving || !snapshot}
            >
              {saving ? 'Saving…' : 'Save Current Stack'}
            </button>
          </div>
        )}

        {/* Loading state */}
        {hasBlueprint && checking && (
          <div className="blueprint-loading">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="5" opacity="0.3" />
              <path d="M7 2a5 5 0 0 1 5 5" />
            </svg>
            Checking…
          </div>
        )}

        {/* Check result */}
        {hasBlueprint && checkResult && !checking && (
          <>
            {/* Completion header */}
            <div className="blueprint-completion">
              <div className="blueprint-completion-pct">{checkResult.completionPct}%</div>
              <div className="blueprint-completion-bar-container">
                <div
                  className={`blueprint-completion-bar-fill ${barColorClass}`}
                  style={{ width: `${checkResult.completionPct}%` }}
                />
              </div>
              <div className="blueprint-summary-row">
                <span className="blueprint-summary-ok">{checkResult.okCount} ok</span>
                {' · '}
                <span className="blueprint-summary-missing">{checkResult.missingCount} missing</span>
                {' · '}
                <span className="blueprint-summary-wrong">{checkResult.wrongCount} wrong</span>
              </div>
            </div>

            {/* Services section */}
            <AccordionSection
              title="Services"
              items={checkResult.services}
              open={openSections.has('services')}
              onToggle={() => toggleSection('services')}
            />

            {/* Containers section */}
            <AccordionSection
              title="Containers"
              items={checkResult.containers}
              open={openSections.has('containers')}
              onToggle={() => toggleSection('containers')}
            />

            {/* Env Variables section */}
            <AccordionSection
              title="Env Variables"
              items={checkResult.envKeys}
              open={openSections.has('env')}
              onToggle={() => toggleSection('env')}
            />
          </>
        )}
      </div>

      {/* Footer (only if blueprint exists) */}
      {hasBlueprint && (
        <div className="blueprint-footer">
          <div className="blueprint-footer-row">
            <button
              className="blueprint-btn"
              onClick={() => check()}
              disabled={checking || !snapshot || !blueprint}
            >
              {checking ? 'Checking…' : 'Re-check'}
            </button>
            <button
              className="blueprint-btn"
              onClick={() => save(label)}
              disabled={saving || !snapshot}
            >
              {saving ? 'Saving…' : 'Update Blueprint'}
            </button>
          </div>
          <div className="blueprint-footer-row">
            {deletingConfirm ? (
              <>
                <button
                  className="blueprint-btn blueprint-btn--confirm"
                  onClick={handleDelete}
                >
                  Confirm Delete
                </button>
                <button
                  className="blueprint-btn"
                  onClick={() => setDeletingConfirm(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="blueprint-btn blueprint-btn--danger"
                onClick={handleDelete}
                disabled={!blueprint}
              >
                Delete Blueprint
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
