const https = require("https");

const MODEL = "gpt-4.1";
const MAX_TOKENS_QUERY = 900;
const MAX_PROMPT_SERVICES = 20;
const MAX_PROMPT_CONNECTIONS = 28;
const MAX_PROMPT_EXTERNALS = 12;

function summarizePromptList(items, maxItems, formatter) {
  const visible = items.slice(0, maxItems).map(formatter);
  const omitted = items.length - visible.length;
  if (omitted > 0) {
    visible.push(`- ... ${omitted} more omitted for brevity`);
  }
  return visible.join("\n");
}

function extractFocusTerms(graphSnapshot, inputText) {
  const text = String(inputText || "").toLowerCase();
  if (!text) return { serviceIds: new Set(), ports: new Set() };

  const serviceIds = new Set();
  const ports = new Set();

  for (const node of graphSnapshot.nodes || []) {
    if (node.type === "external" || !node.name) continue;
    const name = node.name.toLowerCase();
    if (text.includes(`@${name}`) || text.includes(name)) {
      serviceIds.add(node.id);
    }
  }

  const portMatches = text.match(/\b\d{2,5}\b/g) || [];
  for (const token of portMatches) {
    const port = Number(token);
    if (port > 0) ports.add(port);
  }

  for (const node of graphSnapshot.nodes || []) {
    if ((node.ports || []).some((entry) => ports.has(entry.port))) {
      serviceIds.add(node.id);
    }
  }

  return { serviceIds, ports };
}

function buildQueryPrompt(graphSnapshot, query) {
  const nodes = graphSnapshot.nodes || [];
  const edges = graphSnapshot.edges || [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const focus = extractFocusTerms(graphSnapshot, query);

  const services = summarizePromptList(
    nodes
      .filter((node) => node.type !== "external")
      .sort((a, b) => {
        const aFocused = focus.serviceIds.has(a.id) ? 1 : 0;
        const bFocused = focus.serviceIds.has(b.id) ? 1 : 0;
        const aPorts = Array.isArray(a.ports) ? a.ports.length : 0;
        const bPorts = Array.isArray(b.ports) ? b.ports.length : 0;
        return bFocused - aFocused || bPorts - aPorts || a.name.localeCompare(b.name);
      }),
    MAX_PROMPT_SERVICES,
    (node) => {
      const ports = (node.ports || []).map((entry) => entry.port).join(", ");
      const status = node.healthStatus || "unknown";
      const project = node.projectPath ? ` [project: ${node.projectPath}]` : "";
      return `- ${node.name} (type: ${node.type}, ports: ${ports || "none"}, health: ${status}${project})`;
    },
  );

  const connections = summarizePromptList(
    [...edges].sort((a, b) => {
      const aFocusBoost =
        (focus.serviceIds.has(a.source) || focus.serviceIds.has(a.target) ? 2 : 0) +
        (focus.ports.has(a.sourcePort) || focus.ports.has(a.targetPort) ? 1 : 0);
      const bFocusBoost =
        (focus.serviceIds.has(b.source) || focus.serviceIds.has(b.target) ? 2 : 0) +
        (focus.ports.has(b.sourcePort) || focus.ports.has(b.targetPort) ? 1 : 0);
      const aScore = aFocusBoost + (a.confidence || 0);
      const bScore = bFocusBoost + (b.confidence || 0);
      return bScore - aScore;
    }),
    MAX_PROMPT_CONNECTIONS,
    (edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return `- ${source?.name || edge.source} -> ${target?.name || edge.target} (target port ${edge.targetPort || "?"})`;
    },
  );

  const externalApis = summarizePromptList(
    nodes.filter((node) => node.type === "external"),
    MAX_PROMPT_EXTERNALS,
    (node) => `- ${node.name}`,
  );

  return `You are Fere's stack assistant. Answer questions about the user's local development environment clearly and concisely.

You are not debugging a failure unless the user explicitly asks for diagnosis. For general questions:
- answer directly from the environment topology
- explain relationships between services
- identify likely owners of ports and dependencies
- call out uncertainty when topology alone is insufficient
- keep answers short and practical

When referencing services, ports, or files, use backticks.

## Current Services
${services || "No services detected"}

## Current Connections
${connections || "No connections detected"}

## External APIs
${externalApis || "None detected"}
`;
}

function callOpenAIStream(apiKey, systemPrompt, query, onToken) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS_QUERY,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: query },
    ],
    stream: true,
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
        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (chunk) => {
            errData += chunk;
          });
          res.on("end", () => {
            reject(new Error(`OpenAI API error ${res.statusCode}: ${errData}`));
          });
          return;
        }

        let sseBuffer = "";
        let messageContent = "";

        res.on("data", (chunk) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;
            if (typeof delta.content === "string" && delta.content) {
              messageContent += delta.content;
              onToken(delta.content);
            }
          }
        });

        res.on("end", () => resolve(messageContent));
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

async function runQueryAgent(options, onProgress) {
  const { query, graphSnapshot, apiKey } = options;
  const systemPrompt = buildQueryPrompt(graphSnapshot, query);

  onProgress({ type: "thinking" });

  const text = await callOpenAIStream(apiKey, systemPrompt, query, (delta) => {
    if (!options._cancelled) {
      onProgress({ type: "answer_delta", text: delta });
    }
  });

  if (options._cancelled) {
    return { success: false, error: "Cancelled" };
  }

  onProgress({ type: "complete", answer: text });
  return { success: true, answer: text };
}

module.exports = {
  runQueryAgent,
};
