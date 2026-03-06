import { createContext, useContext } from "react";
import type { TraceResult } from "../../types/electron";

export type TracePhase = "idle" | "capturing" | "animating" | "complete";

export interface TraceState {
  phase: TracePhase;
  activeHopIndex: number;
  traceNodeIds: Set<string>;
  traceEdgeIds: Set<string>;
  result: TraceResult | null;
  entryNodeId: string | null;
}

const defaultState: TraceState = {
  phase: "idle",
  activeHopIndex: -1,
  traceNodeIds: new Set(),
  traceEdgeIds: new Set(),
  result: null,
  entryNodeId: null,
};

export const TraceContext = createContext<TraceState>(defaultState);

export function useTraceState() {
  return useContext(TraceContext);
}

export type TraceDispatch = (action: TraceAction) => void;

export type TraceAction =
  | { type: "start-capture"; entryNodeId?: string | null }
  | { type: "set-result"; result: TraceResult }
  | { type: "advance-hop" }
  | { type: "complete-animation" }
  | { type: "dismiss" };

export const TraceDispatchContext = createContext<TraceDispatch>(() => {});

export function useTraceDispatch() {
  return useContext(TraceDispatchContext);
}

export function traceReducer(state: TraceState, action: TraceAction): TraceState {
  switch (action.type) {
    case "start-capture":
      return {
        phase: "capturing",
        activeHopIndex: -1,
        traceNodeIds: new Set(),
        traceEdgeIds: new Set(),
        result: null,
        entryNodeId: action.entryNodeId ?? null,
      };

    case "set-result": {
      const { result } = action;
      const entry = result?.entryNodeId ?? state.entryNodeId;
      if (!result || result.hops.length === 0) {
        // No hops — go straight to complete with just the entry node
        const nodeIds = new Set<string>();
        if (entry) nodeIds.add(entry);
        return {
          phase: "complete",
          activeHopIndex: -1,
          traceNodeIds: nodeIds,
          traceEdgeIds: new Set(),
          result,
          entryNodeId: entry,
        };
      }
      // Start animating from first hop
      const firstHop = result.hops[0];
      const nodeIds = new Set([firstHop.sourceNodeId, firstHop.targetNodeId]);
      if (entry) nodeIds.add(entry);
      const edgeKey = `${firstHop.sourceNodeId}->${firstHop.targetNodeId}`;
      return {
        phase: "animating",
        activeHopIndex: 0,
        traceNodeIds: nodeIds,
        traceEdgeIds: new Set([edgeKey]),
        result,
        entryNodeId: entry,
      };
    }

    case "advance-hop": {
      if (!state.result || state.phase !== "animating") return state;
      const nextIndex = state.activeHopIndex + 1;
      if (nextIndex >= state.result.hops.length) {
        // All hops animated — complete
        return { ...state, phase: "complete", activeHopIndex: -1 };
      }
      const hop = state.result.hops[nextIndex];
      const nodeIds = new Set(state.traceNodeIds);
      nodeIds.add(hop.sourceNodeId);
      nodeIds.add(hop.targetNodeId);
      const edgeIds = new Set(state.traceEdgeIds);
      edgeIds.add(`${hop.sourceNodeId}->${hop.targetNodeId}`);
      return {
        ...state,
        activeHopIndex: nextIndex,
        traceNodeIds: nodeIds,
        traceEdgeIds: edgeIds,
      };
    }

    case "complete-animation":
      return { ...state, phase: "complete", activeHopIndex: -1 };

    case "dismiss":
      return {
        phase: "idle",
        activeHopIndex: -1,
        traceNodeIds: new Set(),
        traceEdgeIds: new Set(),
        result: null,
        entryNodeId: null,
      };

    default:
      return state;
  }
}
