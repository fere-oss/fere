import { useState, useEffect, useCallback } from "react";
import type { Blueprint, BlueprintCheckResult, SystemSnapshot } from "../types/electron";

export function useBlueprintManager(snapshot: SystemSnapshot | null, projectPath: string | null) {
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [checkResult, setCheckResult] = useState<BlueprintCheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  const loadBlueprint = useCallback(async () => {
    if (!projectPath) {
      setBlueprint(null);
      return;
    }
    try {
      const bp = await window.electronAPI.loadBlueprint(projectPath);
      setBlueprint(bp);
    } catch (_) {
      setBlueprint(null);
    }
  }, [projectPath]);

  useEffect(() => {
    loadBlueprint();
  }, [loadBlueprint]);

  const check = useCallback(async () => {
    if (!snapshot || !projectPath) return;
    setChecking(true);
    try {
      const result = await window.electronAPI.checkBlueprint({ projectPath, snapshot });
      setCheckResult(result);
    } catch (err) {
      console.error("[useBlueprintManager] Failed to check:", err);
    } finally {
      setChecking(false);
    }
  }, [snapshot, projectPath]);

  // Auto-check when blueprint is present
  useEffect(() => {
    if (blueprint && snapshot) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprint?.repoPath]);

  const save = useCallback(
    async (label?: string) => {
      if (!snapshot || !projectPath) return;
      setSaving(true);
      try {
        await window.electronAPI.saveBlueprint({ snapshot, projectPath, label });
        await loadBlueprint();
      } catch (err) {
        console.error("[useBlueprintManager] Failed to save:", err);
      } finally {
        setSaving(false);
      }
    },
    [snapshot, projectPath, loadBlueprint],
  );

  const deleteBp = useCallback(async () => {
    if (!projectPath) return;
    try {
      await window.electronAPI.deleteBlueprint(projectPath);
      setBlueprint(null);
      setCheckResult(null);
    } catch (err) {
      console.error("[useBlueprintManager] Failed to delete:", err);
    }
  }, [projectPath]);

  return { blueprint, checkResult, saving, checking, save, check, deleteBlueprint: deleteBp };
}
