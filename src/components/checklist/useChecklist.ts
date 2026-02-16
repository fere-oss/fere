import { useState, useMemo, useCallback, useEffect } from "react";
import type { GraphNode } from "../../types/electron";
import type { ChecklistItem, EvaluatedChecklistItem, OverallStatus } from "./types";
import { evaluateChecklist, getOverallStatus } from "./evaluateChecklist";

const STORAGE_KEY = "fere.checklistItems";

function loadItems(): ChecklistItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistItems(items: ChecklistItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export function useChecklist(nodes: GraphNode[]) {
  const [items, setItems] = useState<ChecklistItem[]>(loadItems);

  useEffect(() => {
    persistItems(items);
  }, [items]);

  const evaluated: EvaluatedChecklistItem[] = useMemo(
    () => evaluateChecklist(items, nodes),
    [items, nodes],
  );

  const overallStatus: OverallStatus = useMemo(
    () => getOverallStatus(evaluated),
    [evaluated],
  );

  const healthyCount = useMemo(
    () => evaluated.filter((e) => e.status === "healthy").length,
    [evaluated],
  );

  const addItem = useCallback(
    (item: Omit<ChecklistItem, "id">) => {
      setItems((prev) => [...prev, { ...item, id: crypto.randomUUID() }]);
    },
    [],
  );

  const updateItem = useCallback(
    (id: string, updates: Partial<Omit<ChecklistItem, "id">>) => {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...updates } : item)),
      );
    },
    [],
  );

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  return {
    items,
    evaluated,
    overallStatus,
    healthyCount,
    addItem,
    updateItem,
    removeItem,
  };
}
