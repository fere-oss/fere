import type { GraphNode, ApiRoute, HttpResponse, HistoryEntry } from '../../types/electron';

export interface CurlBuilderProps {
  nodes: GraphNode[];
  initialServiceId?: string;
}

export interface Header {
  key: string;
  value: string;
  enabled: boolean;
}

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

export type OutputTab = 'curl' | 'response' | 'history';

export interface CurlState {
  selectedNodeId: string;
  selectedRouteIndex: number;
  method: HttpMethod;
  customPath: string;
  headers: Header[];
  body: string;
  copied: boolean;
  outputTab: OutputTab;
  isLoading: boolean;
  response: HttpResponse | null;
  requestError: string | null;
  isCurlEditing: boolean;
  editedCurl: string;
  history: HistoryEntry[];
  historyLoading: boolean;
}

export type { GraphNode, ApiRoute, HttpResponse, HistoryEntry };
