import { useState, useMemo, useCallback } from "react";
import type {
  StackFingerprint,
  StackDiffResult,
  StackDiffItem,
  FingerprintService,
  FingerprintContainer,
} from "../types/electron";
import "./StackDiffModal.css";

interface Props {
  onClose: () => void;
}

// ── Pure diff computation ─────────────────────────────────────────────────────

function computeDiff(mine: StackFingerprint, theirs: StackFingerprint): StackDiffResult {
  const services = diffServices(mine.services, theirs.services);
  const containers = diffContainers(mine.containers, theirs.containers);
  const envKeys = diffEnvKeys(mine.envKeys, theirs.envKeys);

  const allItems = [...services, ...containers, ...envKeys];
  const matching = allItems.filter((i) => i.status === "present").length;
  const onlyMine = allItems.filter((i) => i.status === "missing" && i.side === "mine").length;
  const onlyTheirs = allItems.filter((i) => i.status === "missing" && i.side === "theirs").length;
  const different = allItems.filter((i) => i.status === "different").length;

  return { services, containers, envKeys, summary: { matching, onlyMine, onlyTheirs, different } };
}

function diffServices(
  mine: FingerprintService[],
  theirs: FingerprintService[],
): StackDiffItem[] {
  const mineMap = new Map(mine.map((s) => [s.name, s]));
  const theirsMap = new Map(theirs.map((s) => [s.name, s]));
  const names = Array.from(new Set([...mineMap.keys(), ...theirsMap.keys()])).sort();

  return names.map((name): StackDiffItem => {
    const m = mineMap.get(name);
    const t = theirsMap.get(name);

    if (m && t) {
      const differences: string[] = [];
      const myPorts = m.ports.slice().sort((a, b) => a - b).join(",");
      const theirPorts = t.ports.slice().sort((a, b) => a - b).join(",");
      if (myPorts !== theirPorts) {
        differences.push(`ports: mine [${myPorts || "none"}] vs theirs [${theirPorts || "none"}]`);
      }
      if (m.type !== t.type) {
        differences.push(`type: mine "${m.type}" vs theirs "${t.type}"`);
      }
      if (differences.length > 0) {
        return { name, status: "different", differences };
      }
      return { name, status: "present" };
    }
    if (m && !t) return { name, status: "missing", side: "mine" };
    return { name, status: "missing", side: "theirs" };
  });
}

function diffContainers(
  mine: FingerprintContainer[],
  theirs: FingerprintContainer[],
): StackDiffItem[] {
  const mineMap = new Map(mine.map((c) => [c.name, c]));
  const theirsMap = new Map(theirs.map((c) => [c.name, c]));
  const names = Array.from(new Set([...mineMap.keys(), ...theirsMap.keys()])).sort();

  return names.map((name): StackDiffItem => {
    const m = mineMap.get(name);
    const t = theirsMap.get(name);

    if (m && t) {
      const differences: string[] = [];
      if (m.imageTag !== t.imageTag) {
        differences.push(`image tag: mine "${m.imageTag}" vs theirs "${t.imageTag}"`);
      }
      if (m.state !== t.state) {
        differences.push(`state: mine "${m.state}" vs theirs "${t.state}"`);
      }
      const myPorts = m.ports.slice().sort((a, b) => a - b).join(",");
      const theirPorts = t.ports.slice().sort((a, b) => a - b).join(",");
      if (myPorts !== theirPorts) {
        differences.push(`ports: mine [${myPorts || "none"}] vs theirs [${theirPorts || "none"}]`);
      }
      if (differences.length > 0) {
        return { name, status: "different", differences };
      }
      return { name, status: "present" };
    }
    if (m && !t) return { name, status: "missing", side: "mine" };
    return { name, status: "missing", side: "theirs" };
  });
}

function diffEnvKeys(mine: string[], theirs: string[]): StackDiffItem[] {
  const mineSet = new Set(mine);
  const theirsSet = new Set(theirs);
  const all = Array.from(new Set([...mine, ...theirs])).sort();

  return all.map((name): StackDiffItem => {
    const inMine = mineSet.has(name);
    const inTheirs = theirsSet.has(name);
    if (inMine && inTheirs) return { name, status: "present" };
    if (inMine) return { name, status: "missing", side: "mine" };
    return { name, status: "missing", side: "theirs" };
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DiffRow({ item }: { item: StackDiffItem }) {
  let icon: string;
  let detail: string | null = null;

  if (item.status === "present") {
    icon = "✓";
  } else if (item.status === "missing") {
    icon = "✗";
    detail = item.side === "mine" ? "only mine" : "only theirs";
  } else {
    icon = "⚠";
  }

  return (
    <div className={`stack-diff-row stack-diff-row-${item.status}`}>
      <span className="stack-diff-row-icon">{icon}</span>
      <div className="stack-diff-row-body">
        <div className="stack-diff-row-name">{item.name}</div>
        {detail && <div className="stack-diff-row-detail">{detail}</div>}
        {item.differences && item.differences.length > 0 && (
          <div className="stack-diff-row-differences">
            {item.differences.map((d, i) => (
              <span key={i} className="stack-diff-row-diff-line">{d}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DiffSection({
  title,
  items,
}: {
  title: string;
  items: StackDiffItem[];
}) {
  const [open, setOpen] = useState(true);

  if (items.length === 0) return null;

  const countSuffix = items.length === 1 ? "1 item" : `${items.length} items`;

  return (
    <div className="stack-diff-section">
      <button
        className="stack-diff-section-header"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="stack-diff-section-title">{title}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="stack-diff-section-count">{countSuffix}</span>
          <svg
            className={`stack-diff-section-chevron${open ? " stack-diff-section-chevron-open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="4 6 8 10 12 6" />
          </svg>
        </span>
      </button>
      {open && (
        <div>
          {items.map((item) => (
            <DiffRow key={item.name} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────

export function StackDiffModal({ onClose }: Props) {
  const [myFingerprint, setMyFingerprint] = useState<StackFingerprint | null>(null);
  const [theirRaw, setTheirRaw] = useState("");
  const [theirFingerprint, setTheirFingerprint] = useState<StackFingerprint | null>(null);
  const [parseError, setParseError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load my fingerprint on demand (called when user clicks "Copy Fingerprint")
  const handleExportAndCopy = useCallback(async () => {
    setExporting(true);
    try {
      const fp = await window.electronAPI.exportStackFingerprint({ label: "My Stack" });
      setMyFingerprint(fp);
      await window.electronAPI.copyText(JSON.stringify(fp, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Stack fingerprint export failed:", err);
    } finally {
      setExporting(false);
    }
  }, []);

  // Also load fingerprint eagerly when modal opens (for counts display)
  const [loadedOnMount, setLoadedOnMount] = useState(false);
  if (!loadedOnMount) {
    setLoadedOnMount(true);
    window.electronAPI
      .exportStackFingerprint({ label: "My Stack" })
      .then(setMyFingerprint)
      .catch(() => {/* silently ignore */});
  }

  const handleParse = useCallback(() => {
    setParseError("");
    const trimmed = theirRaw.trim();
    if (!trimmed) {
      setParseError("Paste your teammate's fingerprint JSON above.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      setParseError("Invalid JSON — make sure you copied the full fingerprint.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      setParseError("Unexpected format — expected a JSON object.");
      return;
    }
    const fp = parsed as Record<string, unknown>;
    if (fp.version !== 1) {
      setParseError("Unrecognized fingerprint version. Make sure both sides are running the same Fere version.");
      return;
    }
    setTheirFingerprint(fp as unknown as StackFingerprint);
  }, [theirRaw]);

  const diffResult = useMemo<StackDiffResult | null>(() => {
    if (!myFingerprint || !theirFingerprint) return null;
    return computeDiff(myFingerprint, theirFingerprint);
  }, [myFingerprint, theirFingerprint]);

  return (
    <div className="stack-diff-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="stack-diff-modal">
        {/* Header */}
        <div className="stack-diff-header">
          <span className="stack-diff-title">Stack Diff</span>
          <button className="stack-diff-close" onClick={onClose} title="Close" type="button">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="3" x2="13" y2="13" />
              <line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </button>
        </div>

        {/* Two panels */}
        <div className="stack-diff-panels">
          {/* My stack */}
          <div className="stack-diff-panel">
            <span className="stack-diff-panel-label">My Stack</span>
            {myFingerprint ? (
              <>
                <span className="stack-diff-panel-meta">
                  Generated at {formatTs(myFingerprint.generatedAt)} · checksum {myFingerprint.checksum}
                </span>
                <span className="stack-diff-panel-counts">
                  {myFingerprint.services.length} services · {myFingerprint.containers.length} containers · {myFingerprint.envKeys.length} env keys
                </span>
              </>
            ) : (
              <span className="stack-diff-panel-meta">Loading…</span>
            )}
            <div className="stack-diff-panel-actions">
              <button
                className="stack-diff-btn stack-diff-btn-primary"
                onClick={handleExportAndCopy}
                disabled={exporting}
                type="button"
              >
                {exporting ? "Exporting…" : copied ? "Copied!" : "Copy Fingerprint"}
              </button>
            </div>
          </div>

          {/* Teammate's stack */}
          <div className="stack-diff-panel">
            <span className="stack-diff-panel-label">Teammate's Stack</span>
            {theirFingerprint ? (
              <>
                <span className="stack-diff-panel-meta">
                  {theirFingerprint.label} · generated at {formatTs(theirFingerprint.generatedAt)} · checksum {theirFingerprint.checksum}
                </span>
                <span className="stack-diff-panel-counts">
                  {theirFingerprint.services.length} services · {theirFingerprint.containers.length} containers · {theirFingerprint.envKeys.length} env keys
                </span>
                <div className="stack-diff-panel-actions">
                  <button
                    className="stack-diff-btn"
                    onClick={() => { setTheirFingerprint(null); setTheirRaw(""); setParseError(""); }}
                    type="button"
                  >
                    Clear
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  className="stack-diff-panel-textarea"
                  placeholder="Paste teammate's fingerprint JSON here…"
                  value={theirRaw}
                  onChange={(e) => setTheirRaw(e.target.value)}
                  spellCheck={false}
                />
                {parseError && <span className="stack-diff-error">{parseError}</span>}
                <div className="stack-diff-panel-actions">
                  <button
                    className="stack-diff-btn stack-diff-btn-primary"
                    onClick={handleParse}
                    type="button"
                  >
                    Parse
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Diff results */}
        {diffResult ? (
          <>
            {/* Summary bar */}
            <div className="stack-diff-summary">
              <span className="stack-diff-chip stack-diff-chip-matching">
                {diffResult.summary.matching} matching
              </span>
              <span className="stack-diff-chip stack-diff-chip-mine">
                {diffResult.summary.onlyMine} only mine
              </span>
              <span className="stack-diff-chip stack-diff-chip-theirs">
                {diffResult.summary.onlyTheirs} only theirs
              </span>
              <span className="stack-diff-chip stack-diff-chip-different">
                {diffResult.summary.different} different
              </span>
            </div>

            {/* Sectioned results */}
            <div className="stack-diff-results">
              {diffResult.services.length === 0 &&
                diffResult.containers.length === 0 &&
                diffResult.envKeys.length === 0 ? (
                <div className="stack-diff-empty">No items to compare.</div>
              ) : (
                <>
                  <DiffSection title="Services" items={diffResult.services} />
                  <DiffSection title="Containers" items={diffResult.containers} />
                  <DiffSection title="Env Variables" items={diffResult.envKeys} />
                </>
              )}
            </div>
          </>
        ) : (
          <div className="stack-diff-empty">
            {myFingerprint
              ? "Paste your teammate's fingerprint and click Parse to see the diff."
              : "Loading your stack fingerprint…"}
          </div>
        )}
      </div>
    </div>
  );
}
