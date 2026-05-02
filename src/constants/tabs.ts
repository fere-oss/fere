const isMacOS = navigator.userAgent.toLowerCase().includes("mac");

export const SYSTEM_TAB_LABEL = isMacOS ? "macOS" : "System";
export const SYSTEM_TAB_ID = "__system__";
export const TAB_GROUPING_KEY = "fere.tabGrouping";
export const WELCOME_SEEN_KEY = "fere.hasSeenWelcome";
export const THEME_KEY = "fere.theme";

export type Theme = "light" | "dark";

export type TabGrouping = "repo" | "subproject";

export const STACK_FRAMEWORK_LABELS: Record<string, string> = {
  nextjs: "Next",
  express: "Express",
  nestjs: "Nest",
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
  koa: "Koa",
  hono: "Hono",
  "node-http": "Node",
};

export const BACKEND_FRAMEWORK_ORDER = [
  "express",
  "nestjs",
  "fastapi",
  "flask",
  "django",
  "koa",
  "hono",
  "node-http",
];

export const ALERT_CATEGORIES = [
  { key: "down" as const, label: "Down", desc: "Service crashes" },
  { key: "recovery" as const, label: "Recovery", desc: "Service comes back" },
  { key: "degraded" as const, label: "Degraded", desc: "Slow / idle" },
  { key: "container" as const, label: "Container", desc: "State changes" },
] as const;

export const ALERT_EVENT_LABELS: Record<string, string> = {
  down: "went down",
  recovery: "recovered",
  degraded: "degraded",
  "container-stopped": "stopped",
  "container-running": "started running",
  "service-discovered": "appeared",
  "service-gone": "disappeared",
};
