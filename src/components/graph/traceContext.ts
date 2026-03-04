import { createContext, useContext } from "react";
import type { TraceResult } from "../../types/electron";

export type TracePhase = "idle" | "capturing" | "animating" | "complete";

export interface TraceState {
  phase: TracePhase;
  activeHopIndex: number;
  traceNodeIds: Set<string>;
  traceEdgeIds: Set<string>;
  result: TraceResult | null;
}

const defaultState: TraceState = {
  phase: "idle",
  activeHopIndex: -1,
  traceNodeIds: new Set(),
  traceEdgeIds: new Set(),
  result: null,
};

export const TraceContext = createContext<TraceState>(defaultState);

export function useTraceState() {
  return useContext(TraceContext);
}

export type TraceDispatch = (action: TraceAction) => void;

export type TraceAction =
  | { type: "start-capture" }
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
      };

    case "set-result": {
      const { result } = action;
      if (!result || result.hops.length === 0) {
        // No hops — go straight to complete with just the target node
        const nodeIds = new Set<string>();
        if (result?.hops.length === 0) {
          // Still show something — will be handled by the component
        }
        return {
          phase: "complete",
          activeHopIndex: -1,
          traceNodeIds: nodeIds,
          traceEdgeIds: new Set(),
          result,
        };
      }
      // Start animating from first hop
      const firstHop = result.hops[0];
      const nodeIds = new Set([firstHop.sourceNodeId, firstHop.targetNodeId]);
      const edgeKey = `${firstHop.sourceNodeId}->${firstHop.targetNodeId}`;
      return {
        phase: "animating",
        activeHopIndex: 0,
        traceNodeIds: nodeIds,
        traceEdgeIds: new Set([edgeKey]),
        result,
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
      };

    default:
      return state;
  }
}
