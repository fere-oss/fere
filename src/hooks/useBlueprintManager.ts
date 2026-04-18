import { useState, useEffect, useCallback } from 'react';
import type {
  BlueprintListItem,
  BlueprintCheckResult,
  SystemSnapshot,
} from '../types/electron';

export function useBlueprintManager(snapshot: SystemSnapshot | null, projectPath: string | null) {
  const [blueprints, setBlueprints] = useState<BlueprintListItem[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<BlueprintCheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const refreshList = useCallback(async () => {
    try {
      const list = await window.electronAPI.listBlueprints();
      setBlueprints(list);
      // Auto-select the blueprint for current project if none selected
      if (projectPath && !selectedHash) {
        const match = list.find((b) => b.repoPath === projectPath);
        if (match) setSelectedHash(match.repoHash);
      }
    } catch (err) {
      console.error('[useBlueprintManager] Failed to list blueprints:', err);
    }
  }, [projectPath, selectedHash]);

  useEffect(() => {
    refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(async (label?: string) => {
    if (!snapshot) return;
    setSaving(true);
    try {
      const result = await window.electronAPI.saveBlueprint({
        snapshot,
        projectPath: projectPath ?? '__system__',
        label,
      });
      await refreshList();
      setSelectedHash(result.repoHash);
    } catch (err) {
      console.error('[useBlueprintManager] Failed to save blueprint:', err);
    } finally {
      setSaving(false);
    }
  }, [snapshot, projectPath, refreshList]);

  const check = useCallback(async (hash?: string) => {
    if (!snapshot) return;
    const h = hash ?? selectedHash;
    if (!h) return;
    setChecking(true);
    try {
      const result = await window.electronAPI.checkBlueprint({ hash: h, snapshot });
      setCheckResult(result);
    } catch (err) {
      console.error('[useBlueprintManager] Failed to check blueprint:', err);
    } finally {
      setChecking(false);
    }
  }, [snapshot, selectedHash]);

  const deleteBp = useCallback(async (hash: string) => {
    try {
      await window.electronAPI.deleteBlueprint(hash);
      if (selectedHash === hash) {
        setSelectedHash(null);
        setCheckResult(null);
      }
      await refreshList();
    } catch (err) {
      console.error('[useBlueprintManager] Failed to delete blueprint:', err);
    }
  }, [selectedHash, refreshList]);

  // Auto-check when selectedHash changes (and snapshot is available)
  useEffect(() => {
    if (selectedHash && snapshot) {
      check(selectedHash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHash]);

  return {
    blueprints,
    selectedHash,
    setSelectedHash,
    checkResult,
    saving,
    checking,
    save,
    check,
    deleteBlueprint: deleteBp,
  };
}
