const https = require("https");

const MODEL = "gpt-4.1";
const MAX_TOKENS_EXPLAIN = 700;

function findServiceNode(graphSnapshot, serviceId, serviceName) {
  const nodes = graphSnapshot.nodes || [];
  return (
    nodes.find((node) => node.id === serviceId) ||
    nodes.find(
      (node) =>
        node.type !== "external" &&
        node.name &&
        node.name.toLowerCase() === String(serviceName || "").toLowerCase(),
    ) ||
    null
  );
}

function buildExplainPrompt(graphSnapshot, node) {
  const nodes = graphSnapshot.nodes || [];
  const edges = graphSnapshot.edges || [];
  const nodeById = new Map(nodes.map((entry) => [entry.id, entry]));
  const incoming = edges.filter((edge) => edge.target === node.id);
  const outgoing = edges.filter((edge) => edge.source === node.id);
  const routes = node.routes || [];
  const externalApis = node.externalApis || [];
  const ports = (node.ports || []).map((entry) => `${entry.host}:${entry.port}`);

  const incomingSummary =
    incoming.length > 0
      ? incoming
          .map((edge) => {
            const source = nodeById.get(edge.source);
            return `- ${source?.name || edge.source} -> ${node.name} (:${edge.sourcePort || "?"} -> :${edge.targetPort || "?"})`;
          })
          .join("\n")
      : "None";

  const outgoingSummary =
    outgoing.length > 0
      ? outgoing
          .map((edge) => {
            const target = nodeById.get(edge.target);
            return `- ${node.name} -> ${target?.name || edge.target} (:${edge.sourcePort || "?"} -> :${edge.targetPort || "?"})`;
          })
          .join("\n")
      : "None";

  const routeSummary =
    routes.length > 0
      ? routes
          .slice(0, 20)
          .map((route) => `- ${route.method} ${route.path}${route.framework ? ` [${route.framework}]` : ""}`)
          .join("\n")
      : "None";

  const externalSummary =
    externalApis.length > 0
      ? externalApis
          .slice(0, 12)
          .map((api) => `- ${api.name}${api.hosts?.length ? ` (${api.hosts.slice(0, 3).join(", ")})` : ""}`)
          .join("\n")
      : "None";

  return `You are Fere's service explainer. Explain one local service in a concise, useful way.

Write 3 short sections:
1. What it is
2. How it fits into the stack
3. What stands out right now

Rules:
- stay concrete
- do not invent behavior not supported by the provided context
- mention uncertainty when needed
- keep it under 220 words
- use backticks for service names, ports, routes, and files

## Service
- Name: ${node.name}
- Type: ${node.type}
- Health: ${node.healthStatus || "unknown"}
- CPU: ${typeof node.cpu === "number" ? `${node.cpu.toFixed(1)}%` : "unknown"}
- Memory: ${typeof node.memory === "number" ? `${node.memory.toFixed(1)}%` : "unknown"}
- Ports: ${ports.length > 0 ? ports.join(", ") : "none"}
- Project: ${node.projectPath || node.project || "unknown"}
- Command: ${node.command || "unknown"}

## Incoming Connections
${incomingSummary}

## Outgoing Connections
${outgoingSummary}

## Routes
${routeSummary}

## External APIs
${externalSummary}
`;
}

function callOpenAI(apiKey, systemPrompt) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS_EXPLAIN,
    messages: [{ role: "system", content: systemPrompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`OpenAI API error ${res.statusCode}: ${data}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.choices?.[0]?.message?.content || "");
          } catch (error) {
            reject(
              new Error(
                `Failed to parse OpenAI API response: ${error.message}`,
              ),
            );
          }
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("OpenAI API timeout (60s)"));
    });
    req.write(body);
    req.end();
  });
}

async function explainService(options) {
  const { graphSnapshot, serviceId, serviceName, apiKey } = options;
  const node = findServiceNode(graphSnapshot, serviceId, serviceName);
  if (!node) {
    throw new Error("Service not found");
  }

  const prompt = buildExplainPrompt(graphSnapshot, node);
  const explanation = await callOpenAI(apiKey, prompt);
  return {
    serviceId: node.id,
    serviceName: node.name,
    explanation,
  };
}

module.exports = {
  explainService,
};
