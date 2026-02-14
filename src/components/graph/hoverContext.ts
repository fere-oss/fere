import { createContext, useContext } from "react";

type HoverState = {
  hoveredNodeId: string | null;
  connectedNodeIds: Set<string>;
};

const defaultState: HoverState = {
  hoveredNodeId: null,
  connectedNodeIds: new Set(),
};

export const HoverContext = createContext<HoverState>(defaultState);

export function useHoverState() {
  return useContext(HoverContext);
}

export const ExternalApiVersionContext = createContext<number>(0);

export function useExternalApiVersion() {
  return useContext(ExternalApiVersionContext);
}
