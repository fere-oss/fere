import type { GraphNode } from "../types/electron";
import {
  STACK_FRAMEWORK_LABELS,
  BACKEND_FRAMEWORK_ORDER,
  type TabGrouping,
} from "../constants/tabs";

export function normalizeProjectTabPath(projectPath: string): string {
  if (!projectPath) return projectPath;
  return projectPath.replace(/\/services\/[^/]+$/, "");
}

export function getNodeTabPath(node: GraphNode, grouping: TabGrouping): string | null {
  if (!node.projectPath) return null;
  if (grouping === "repo") {
    return node.repoPath || node.projectPath;
  }
  return normalizeProjectTabPath(node.projectPath);
}

function detectDbLabel(command: string, name: string): string {
  if (command.includes("postgres") || name.includes("postgres")) return "Postgres";
  if (command.includes("mysql") || name.includes("mysql") || command.includes("mariadb"))
    return "MySQL";
  if (command.includes("mongo") || name.includes("mongo")) return "MongoDB";
  if (command.includes("sqlite") || name.includes("sqlite")) return "SQLite";
  return "Database";
}

function detectCacheLabel(command: string, name: string): string {
  if (command.includes("redis") || name.includes("redis")) return "Redis";
  if (command.includes("memcached") || name.includes("memcached")) return "Memcached";
  return "Cache";
}

function detectBrokerLabel(command: string, name: string): string {
  if (command.includes("nats") || name.includes("nats")) return "NATS";
  if (command.includes("kafka") || name.includes("kafka")) return "Kafka";
  if (command.includes("rabbit") || name.includes("rabbit")) return "RabbitMQ";
  return "Broker";
}

export function detectProjectStack(nodes: GraphNode[]): string | null {
  const frameworks = new Set<string>();
  const dbLabels = new Set<string>();
  const cacheLabels = new Set<string>();
  const brokerLabels = new Set<string>();
  let hasFrontend = false;
  let hasBackend = false;

  nodes.forEach((node) => {
    const command = (node.command || "").toLowerCase();
    const name = (node.name || "").toLowerCase();

    node.routes?.forEach((route) => {
      if (route.framework) frameworks.add(route.framework);
    });

    if (command.includes("next")) frameworks.add("nextjs");
    if (command.includes("express")) frameworks.add("express");
    if (command.includes("nestjs")) frameworks.add("nestjs");
    if (command.includes("fastapi") || command.includes("uvicorn")) frameworks.add("fastapi");
    if (command.includes("flask")) frameworks.add("flask");
    if (command.includes("django")) frameworks.add("django");
    if (command.includes("koa")) frameworks.add("koa");
    if (command.includes("hono")) frameworks.add("hono");

    if (node.type === "frontend") hasFrontend = true;
    if (node.type === "backend" || node.type === "nodejs" || node.type === "python")
      hasBackend = true;

    if (node.type === "database") dbLabels.add(detectDbLabel(command, name));
    if (node.type === "cache") cacheLabels.add(detectCacheLabel(command, name));
    if (node.type === "broker") brokerLabels.add(detectBrokerLabel(command, name));
  });

  const parts: string[] = [];

  if (frameworks.has("nextjs")) {
    parts.push("Next");
  } else if (hasFrontend) {
    parts.push("Frontend");
  }

  BACKEND_FRAMEWORK_ORDER.forEach((framework) => {
    if (frameworks.has(framework)) {
      parts.push(STACK_FRAMEWORK_LABELS[framework]);
    }
  });

  if (!BACKEND_FRAMEWORK_ORDER.some((f) => frameworks.has(f)) && hasBackend) {
    parts.push("Backend");
  }

  parts.push(...Array.from(dbLabels), ...Array.from(cacheLabels), ...Array.from(brokerLabels));

  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  if (unique.length === 0) return null;
  return unique.slice(0, 4).join(" + ");
}
