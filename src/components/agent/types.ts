import type { AgentFixAction, AgentSeverity } from "../../types/electron";

export type ContextService = {
  name: string;
  type: string;
  pid: number;
  ports: number[];
  healthStatus: string;
  cpu?: number;
  memory?: number;
  isDockerContainer?: boolean;
  containerState?: string;
  projectPath?: string;
  externalApis?: string[];
  routes?: Array<{ method?: string; path: string }>;
};

export type ContextFinding = {
  severity: string;
  service: string;
  summary: string;
  stage: string;
};

export type ContextConnection = {
  from: string;
  to: string;
  port: number;
};

export type ContextSnapshot = {
  scope: string;
  timestamp: string;
  services: ContextService[];
  connections: ContextConnection[];
  findings: ContextFinding[];
};

export type FeedMessage = {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  copyable?: boolean;
};

export type FeedContext = {
  kind: "context";
  snapshot: ContextSnapshot;
  copyText: string;
};

export type FeedFinding = {
  kind: "finding";
  id: string;
  service: string;
  summary: string;
  severity: AgentSeverity;
  fix: AgentFixAction | null;
  stage: IncidentStage;
  error?: string;
  insertedAt: number;
};

export type FeedItem = FeedMessage | FeedContext | FeedFinding;

export type IncidentStage = "detected" | "fixing" | "fixed" | "verified" | "escalated";

export type ChatThread = {
  id: string;
  title: string;
  updatedAt: number;
  feed: FeedItem[];
};

export type PersistedChatState = {
  open: boolean;
  activeThreadId: string;
  threads: ChatThread[];
  input: string;
};
