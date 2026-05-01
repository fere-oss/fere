/**
 * Graph Exporter Service
 * Generates a self-contained, interactive HTML graph viewer.
 * Replicates the exact Fere service map visual — same layout algorithm,
 * same node cards, same hover behavior, same edge style.
 * Pure vanilla JS — no CDN dependencies (required for htmlpreview.github.io).
 */

const https = require('https');
const http = require('http');

// Node-side brand domain map (mirrors BRAND_DOMAIN_BY_KEY in brandIcons.tsx)
const NODE_BRAND_DOMAIN = {
  openai:'openai.com', anthropic:'anthropic.com', groq:'groq.com',
  gemini:'ai.google.dev', 'google gemini':'ai.google.dev',
  'azure openai':'azure.microsoft.com', 'aws bedrock':'aws.amazon.com',
  cohere:'cohere.com', mistral:'mistral.ai', together:'together.ai',
  replicate:'replicate.com', 'hugging face':'huggingface.co',
  huggingface:'huggingface.co', openrouter:'openrouter.ai',
  perplexity:'perplexity.ai', deepgram:'deepgram.com',
  elevenlabs:'elevenlabs.io', pinecone:'pinecone.io',
  weaviate:'weaviate.io', supabase:'supabase.com',
  firebase:'firebase.google.com', stripe:'stripe.com',
  twilio:'twilio.com', sendgrid:'sendgrid.com', mailgun:'mailgun.com',
  sentry:'sentry.io', posthog:'posthog.com', segment:'segment.com',
  amplitude:'amplitude.com', mixpanel:'mixpanel.com', algolia:'algolia.com',
  cloudflare:'cloudflare.com', vercel:'vercel.com',
  'storefront-web':'vercel.com', 'storefront web':'vercel.com',
  chrome:'google.com', 'google chrome':'google.com',
  onedrive:'onedrive.com', raycast:'raycast.com', ollama:'ollama.com',
  github:'github.com', gitlab:'gitlab.com',
  vscode:'code.visualstudio.com', 'vs code':'code.visualstudio.com',
  'visual studio code':'code.visualstudio.com',
  slack:'slack.com', discord:'discord.com', notion:'notion.so',
  cartesia:'cartesia.ai', deepseek:'deepseek.com', 'x.ai':'x.ai',
  mongodb:'mongodb.com', postgres:'postgresql.org', postgresql:'postgresql.org',
  postman:'postman.com', mysql:'mysql.com', redis:'redis.io',
  rabbitmq:'rabbitmq.com', kafka:'kafka.apache.org', nats:'nats.io',
  nginx:'nginx.org', apache:'apache.org', electron:'electronjs.org',
  docker:'docker.com', podman:'podman.io',
  'node.js':'nodejs.org', node:'nodejs.org',
  python:'python.org', uwsgi:'python.org', gunicorn:'python.org',
  flask:'python.org', django:'djangoproject.com',
  fastapi:'fastapi.tiangolo.com', go:'go.dev', golang:'go.dev',
  gin:'gin-gonic.com', fiber:'gofiber.io',
  java:'java.com', php:'php.net', ruby:'ruby-lang.org',
  rails:'rubyonrails.org', 'ruby on rails':'rubyonrails.org',
};

function nodeBrandMatch(haystack, lookup) {
  const escaped = lookup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'i').test(haystack); }
  catch { return haystack.includes(lookup); }
}

function nodeNormalizeBrand(value) {
  return String(value || '').trim().toLowerCase();
}

function nodeExtractDomainLike(value) {
  const match = String(value || '').match(/([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1].toLowerCase() : null;
}

function nodeIsHostLike(value) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

function nodeIsReverseDnsBundleId(value) {
  return /^(com|org|net|io|dev|app|ai)\.[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value);
}

function nodeInferServiceBrand(node) {
  const command = node.command || '';
  let runtimeCommand = command.includes(' | ')
    ? command.split(' | ').slice(1).join(' | ')
    : command;
  runtimeCommand = runtimeCommand.replace(/^docker-entrypoint\.sh\s+/i, '').trim();

  const dockerLangMatch = runtimeCommand.match(/^docker-([\w]+)-entrypoint\b/i);
  const dockerLangHint = dockerLangMatch ? dockerLangMatch[1] : null;
  if (dockerLangHint) {
    runtimeCommand = runtimeCommand.replace(/^docker-[\w]+-entrypoint\s*/i, '').trim();
  }

  const samples = [node.name, node.containerImage, dockerLangHint, runtimeCommand]
    .filter(Boolean);
  for (const sample of samples) {
    const key = nodeNormalizeBrand(sample);
    const isPathLike = key.startsWith('/') || key.startsWith('~');
    if (!isPathLike) {
      if (NODE_BRAND_DOMAIN[key]) return sample;
      for (const lookup of Object.keys(NODE_BRAND_DOMAIN)) {
        if (nodeBrandMatch(key, lookup)) return sample;
      }
    }
    const host = nodeExtractDomainLike(sample);
    if (host) return host;
  }
  return null;
}

function nodeLogoDevUrl(domain, token) {
  let url = 'https://img.logo.dev/' + domain + '?size=64&format=png&fallback=monogram';
  if (token) url += '&token=' + token;
  return url;
}

function nodeLogoDevNameUrl(name, token) {
  let url = 'https://img.logo.dev/name/' + encodeURIComponent(name) + '?size=64&format=png&fallback=monogram';
  if (token) url += '&token=' + token;
  return url;
}

function getNodeLogoUrl(node, token) {
  const serviceBrand = nodeInferServiceBrand(node);
  if (!serviceBrand) return null;

  const key = nodeNormalizeBrand(serviceBrand);
  if (NODE_BRAND_DOMAIN[key]) {
    return nodeLogoDevUrl(NODE_BRAND_DOMAIN[key], token);
  }
  for (const [lookup, domain] of Object.entries(NODE_BRAND_DOMAIN)) {
    if (nodeBrandMatch(key, lookup)) return nodeLogoDevUrl(domain, token);
  }
  const extracted = nodeExtractDomainLike(key);
  if (extracted && nodeIsHostLike(extracted) && !nodeIsReverseDnsBundleId(extracted)) {
    return nodeLogoDevUrl(extracted, token);
  }
  if (nodeIsHostLike(key) && !nodeIsReverseDnsBundleId(key)) {
    return nodeLogoDevUrl(key, token);
  }
  if (key.length <= 80) {
    return nodeLogoDevNameUrl(key, token);
  }
  return null;
}

function fetchLogoBase64(url) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 8000);

    try {
      // Electron's net module follows redirects automatically and uses the system session
      const { net } = require('electron');
      const req = net.request({ url, redirect: 'follow' });
      const chunks = [];
      req.on('response', (res) => {
        if (res.statusCode !== 200) { clearTimeout(timer); done(null); return; }
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { clearTimeout(timer); done(Buffer.concat(chunks).toString('base64')); });
        res.on('error', () => { clearTimeout(timer); done(null); });
      });
      req.on('error', () => { clearTimeout(timer); done(null); });
      req.end();
    } catch {
      // Fallback to https if net is unavailable
      clearTimeout(timer);
      const fallbackTimer = setTimeout(() => done(null), 8000);
      let parsed;
      try { parsed = new URL(url); } catch { done(null); return; }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req2 = lib.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Fere/1.0)' },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); clearTimeout(fallbackTimer); done(null); return; }
        const chunks2 = [];
        res.on('data', c => chunks2.push(c));
        res.on('end', () => { clearTimeout(fallbackTimer); done(Buffer.concat(chunks2).toString('base64')); });
        res.on('error', () => { clearTimeout(fallbackTimer); done(null); });
      });
      req2.on('error', () => { clearTimeout(fallbackTimer); done(null); });
      req2.end();
    }
  });
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeJson(obj) {
  return JSON.stringify(obj).replace(/<\/script>/gi, '<\\/script>');
}

async function generateHTML({ graphData, metadata, logoDevToken = '' }) {
  const { nodes = [], edges = [] } = graphData;

  // Strip heavy fields, keep everything the node card and detail panel need
  const cleanNodes = nodes
    .filter(n => n.type !== 'external')
    .map(n => ({
      id: n.id,
      name: n.name,
      type: n.type || 'service',
      healthStatus: n.healthStatus || 'yellow',
      ports: (n.ports || []).map(p => ({ port: p.port, host: p.host || 'localhost', description: p.description || '' })),
      isDocker: !!n.isDockerContainer,
      containerImage: n.containerImage || null,
      containerState: n.containerState || null,
      containerStatus: n.containerStatus || null,
      containerId: n.containerId || null,
      projectPath: n.projectPath || null,
      project: n.project || null,
      pid: n.pid || null,
      user: n.user || null,
      cpu: n.cpu || 0,
      memory: n.memory || 0,
      memoryUsage: n.memoryUsage || null,
      command: n.command || '',
      lastSeen: n.lastSeen || Date.now(),
      routes: (n.routes || []).map(r => ({ method: String(r.method || 'GET').toUpperCase(), path: r.path })),
      containerNetworks: (n.containerNetworks || []).slice(0, 2).map(cn => cn.name || cn),
    }));
  cleanNodes.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // Keep only edges between non-external nodes
  const cleanNodeIds = new Set(cleanNodes.map(n => n.id));
  const cleanEdges = edges
    .filter(e => cleanNodeIds.has(e.source) && cleanNodeIds.has(e.target))
    .map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourcePort: e.sourcePort || null,
      targetPort: e.targetPort || null,
      protocol: e.protocol || null,
    }));
  cleanEdges.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // Pre-fetch brand logos as base64 so the exported HTML is fully self-contained
  // (htmlpreview.github.io blocks external image requests)
  const logosMap = {};
  await Promise.all(cleanNodes.map(async (n) => {
    const url = getNodeLogoUrl(n, logoDevToken);
    if (url) {
      const b64 = await fetchLogoBase64(url);
      if (b64) logosMap[n.id] = 'data:image/png;base64,' + b64;
    }
  }));

  const payload = escapeJson({ nodes: cleanNodes, edges: cleanEdges, metadata, logos: logosMap });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>fere — ${escapeHtml(metadata.tabName)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --font-mono: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace;
      --bg-white: #ffffff;
      --bg-primary: #f5f5f5;
      --bg-muted: #fafafa;
      --border-color: #e5e5e5;
      --border-hover: #d4d4d4;
      --text-primary: #171717;
      --text-secondary: #525252;
      --text-muted: #737373;
      --text-faint: #a3a3a3;
    }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: #f8f9fa;
      font-family: var(--font-ui);
      color: #0a0a0a;
      -webkit-font-smoothing: antialiased;
    }

    #app { display: flex; flex-direction: column; height: 100vh; position: relative; }

    /* ── Viewport ── */
    #vp {
      flex: 1; overflow: hidden; position: relative; cursor: grab;
      user-select: none; -webkit-user-select: none;
      background:
        radial-gradient(circle at 30% 20%, rgba(110, 120, 150, 0.08), transparent 55%),
        radial-gradient(circle at 70% 80%, rgba(120, 160, 200, 0.06), transparent 60%),
        #f8f9fa;
    }
    #vp.dragging { cursor: grabbing; }

    /* ── Canvas ── */
    #canvas { position: absolute; transform-origin: 0 0; }

    /* ── SVG edge layer ── */
    #esv { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }

    /* Edges hidden by default — shown on hover */
    .e-group { opacity: 0; transition: opacity 0.15s; pointer-events: none; }
    .e-shadow { fill: none; stroke: rgba(10,10,10,0.13); stroke-linecap: round; }
    .e-dash {
      fill: none; stroke: rgba(10,10,10,0.85); stroke-linecap: round;
      stroke-dasharray: 4 8;
      animation: edgeFlow 0.8s linear infinite;
    }
    @keyframes edgeFlow { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -12; } }
    .e-group.connected { opacity: 1; }

    /* ── Group boxes (behind nodes, same layer, same base name) ── */
    .group-box {
      position: absolute;
      border-radius: 18px;
      background: color-mix(in srgb, var(--gc, #d6dce8) 10%, rgba(255,255,255,0.7));
      border: 1px solid color-mix(in srgb, var(--gc, #d6dce8) 35%, rgba(202,210,224,0.6));
      box-shadow: 0 12px 30px rgba(18, 27, 44, 0.08);
      pointer-events: none;
      z-index: 1;
    }
    .group-label {
      position: absolute;
      font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace;
      display: inline-flex; align-items: center;
      padding: 5px 12px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--gc, #d6dce8) 12%, #ffffff);
      color: color-mix(in srgb, #161a20 82%, #737373 18%);
      border: 1px solid color-mix(in srgb, var(--gc, #d6dce8) 55%, #ffffff);
      font-size: 11px; font-weight: 700;
      white-space: nowrap;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      pointer-events: none;
      z-index: 2;
    }
    .group-label-centered {
      transform: translateX(-50%);
      padding: 6px 18px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: color-mix(in srgb, var(--gc, #d6dce8) 12%, #ffffff);
      color: color-mix(in srgb, #161a20 82%, #737373 18%);
      border: 1.5px solid color-mix(in srgb, var(--gc, #d6dce8) 55%, #ffffff);
    }

    /* ── Tier label pill — matches .graph-tier-label ── */
    .tier-label {
      position: absolute;
      font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 8px 22px;
      border-radius: 999px;
      background: #ffffff;
      border: 1.5px solid #e5e5e5;
      font-size: 13px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.1em;
      color: #525252;
      white-space: nowrap;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      pointer-events: none;
      transform: translateX(-50%);
      z-index: 3;
    }
    .standalone-label {
      position: absolute;
      font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 8px 22px;
      border-radius: 999px;
      background: #ffffff;
      border: 1.5px solid #e5e5e5;
      font-size: 13px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.1em;
      color: #525252;
      white-space: nowrap;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      pointer-events: none;
      transform: translateX(-50%);
      z-index: 3;
    }

    /* ── Node cards — exact match to .service-node ── */
    .node {
      position: absolute;
      background: #ffffff;
      border: 1px solid #e5e5e5;
      border-radius: 12px;
      padding: 16px 20px;
      width: 260px;
      min-height: 190px;
      box-sizing: border-box;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      display: flex;
      flex-direction: column;
      gap: 8px;
      cursor: pointer;
      z-index: 5;
      transition: box-shadow 0.15s ease, border-color 0.15s ease,
                  opacity 0.2s ease, filter 0.2s ease, transform 0.2s ease;
    }
    .node.dimmed { opacity: 0.35; filter: grayscale(30%); }
    .node.highlighted { transform: scale(1.03); box-shadow: 0 4px 20px rgba(0,0,0,0.12); z-index: 10; }

    /* Header */
    .n-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .n-status { display: flex; align-items: center; gap: 6px; }
    .n-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .n-hlabel { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .n-badge {
      font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace;
      font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
      padding: 4px 10px; border-radius: 6px;
    }

    /* Brand logo */
    .brand-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
      flex-shrink: 0;
      width: 15px;
      height: 15px;
    }
    .brand-icon-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      border-radius: 3px;
    }
    .brand-icon-fallback {
      border: 1px solid var(--border-color);
      border-radius: 50%;
      font-family: var(--font-mono);
      line-height: 1;
      font-size: 9px;
      color: var(--text-secondary);
      background: #fff;
    }
    .n-logo-row { display: flex; align-items: center; gap: 8px; }
    .n-logo { width: 15px; height: 15px; object-fit: contain; flex-shrink: 0; border-radius: 3px; }

    /* Name */
    .n-name { font-size: 16px; font-weight: 500; letter-spacing: -0.01em; color: #0a0a0a; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Project label */
    .n-project { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace; font-size: 12px; font-weight: 600; color: #737373; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }

    /* Docker image */
    .n-docker-img { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace; font-size: 10px; color: #737373; margin-top: -2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Port */
    .n-port { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace; font-size: 15px; display: flex; align-items: center; gap: 6px; }
    .n-port-host { color: #a3a3a3; }

    /* Networks */
    .n-networks { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #a3a3a3; margin-top: 4px; }

    /* Routes */
    .n-routes { margin-top: 4px; padding-top: 12px; border-top: 1px dashed #e5e5e5; }
    .n-routes-hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .n-routes-title { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #a3a3a3; font-weight: 600; }
    .n-routes-count { font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace; font-size: 11px; color: #737373; }
    .n-routes-list { display: flex; flex-direction: column; gap: 6px; }
    .n-route { display: flex; align-items: center; gap: 8px; font-family: 'SF Mono', 'Menlo', 'Consolas', 'Monaco', monospace; font-size: 11px; color: #525252; }
    .n-method { font-weight: 700; font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #f5f5f5; color: #737373; min-width: 38px; text-align: center; }
    .n-method.GET    { background: #e8f5e9; color: #2e7d32; }
    .n-method.POST   { background: #fff3e0; color: #ef6c00; }
    .n-method.PUT    { background: #e3f2fd; color: #1565c0; }
    .n-method.DELETE { background: #ffebee; color: #c62828; }
    .n-method.PATCH  { background: #e3f2fd; color: #0078d4; }
    .n-route-path { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
    .n-routes-more { font-size: 11px; color: #a3a3a3; margin-top: 2px; }

    /* ── Detail sidebar (matches app NodeDetailPanel/NodeDetailContent) ── */
    #detail-backdrop {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: transparent;
      z-index: 49;
      pointer-events: none;
    }
    #detail-backdrop.open { pointer-events: auto; }
    #detail {
      position: absolute;
      top: 12px;
      right: 12px;
      bottom: 12px;
      background: var(--bg-white);
      border-radius: 12px;
      box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
      width: 320px;
      max-width: calc(100vw - 24px);
      display: flex;
      flex-direction: column;
      transform: translateX(calc(100% + 24px));
      transition: transform 0.2s ease-out;
      z-index: 50;
      overflow: hidden;
      pointer-events: none;
    }
    #detail.open {
      transform: translateX(0);
      pointer-events: auto;
    }
    .node-detail-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 20px 20px;
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-primary);
      border-radius: 12px 12px 0 0;
      flex-shrink: 0;
    }
    .node-detail-title-row { display: flex; align-items: center; gap: 14px; }
    .node-detail-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
    .node-detail-title-info { display: flex; flex-direction: column; gap: 6px; }
    .node-detail-name {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      margin: 0;
      word-break: break-word;
    }
    .node-detail-badge {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      padding: 4px 10px;
      border-radius: 6px;
      width: fit-content;
    }
    .node-detail-close {
      width: 32px;
      height: 32px;
      border: none;
      background: transparent;
      border-radius: 8px;
      font-size: 24px;
      font-weight: 400;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      line-height: 1;
    }
    .node-detail-close:hover { background: var(--bg-primary); color: var(--text-primary); }
    .node-detail-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .node-detail-section { display: flex; flex-direction: column; gap: 12px; }
    .node-detail-section-title {
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      margin: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .node-detail-health {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      background: var(--bg-primary);
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }
    .node-detail-health-indicator { display: flex; align-items: center; gap: 8px; }
    .node-detail-health-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .node-detail-health-label { font-size: 13px; font-weight: 600; }
    .node-detail-health-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
    .node-detail-count {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-faint);
      font-weight: 500;
      margin-left: 6px;
    }
    .node-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .node-detail-item { display: flex; flex-direction: column; gap: 4px; }
    .node-detail-item.full-width { grid-column: 1 / -1; }
    .node-detail-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-faint);
    }
    .node-detail-value { font-size: 14px; color: var(--text-primary); }
    .node-detail-value.mono { font-family: var(--font-mono); font-weight: 500; }
    .node-detail-value.small { font-size: 12px; word-break: break-all; }
    .node-detail-command {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-primary);
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      word-break: break-all;
      line-height: 1.5;
    }
    .node-detail-ports { display: flex; flex-direction: column; gap: 8px; }
    .node-detail-port {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-primary);
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }
    .node-detail-port-number { font-family: var(--font-mono); font-size: 14px; font-weight: 600; }
    .node-detail-port-host { font-size: 13px; color: var(--text-muted); }
    .node-detail-port-desc { font-size: 12px; color: var(--text-faint); margin-left: auto; }
    .node-detail-routes { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; padding: 2px; }
    .node-detail-route {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: var(--bg-primary);
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }
    .route-method {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #f5f5f5;
      color: var(--text-muted);
      min-width: 38px;
      text-align: center;
      text-transform: uppercase;
    }
    .route-method.route-get { background: #e8f5e9; color: #2e7d32; }
    .route-method.route-post { background: #fff3e0; color: #ef6c00; }
    .route-method.route-put { background: #e3f2fd; color: #1565c0; }
    .route-method.route-delete { background: #ffebee; color: #c62828; }
    .route-method.route-patch { background: #e3f2fd; color: #0078d4; }
    .node-detail-route-path { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
    .node-detail-connections { display: flex; flex-direction: column; gap: 16px; }
    .node-detail-connection-group { display: flex; flex-direction: column; gap: 8px; }
    .node-detail-connection-label { font-size: 11px; font-weight: 600; color: var(--text-faint); text-transform: uppercase; }
    .node-detail-connection {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-primary);
      border-radius: 8px;
      border: 1px solid var(--border-color);
      font-size: 13px;
    }
    .connection-arrow { font-size: 14px; color: var(--text-faint); }
    .connection-node { font-weight: 500; color: var(--text-primary); }
    .connection-port { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-left: auto; }
    .docker-state { font-family: var(--font-mono); font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .docker-state-running { color: #22c55e; }
    .docker-state-paused { color: #eab308; }
    .docker-state-restarting { color: #f97316; }
    .docker-state-exited, .docker-state-dead { color: #ef4444; }
    .docker-state-created { color: #6b7280; }

    /* ── Controls ── */
    .ctrl {
      position: fixed; top: 12px; right: 12px; display: flex; flex-direction: column;
      gap: 4px; z-index: 20; transition: right 0.25s cubic-bezier(0.4,0,0.2,1);
    }
    body.detail-open .ctrl { right: 340px; }
    .ctrl button {
      width: 32px; height: 32px; background: #fff; border: 1px solid #e5e5e5;
      border-radius: 7px; cursor: pointer; display: flex;
      align-items: center; justify-content: center; color: #525252;
      transition: background .12s, border-color .12s;
    }
    .ctrl button:hover { background: #f5f5f5; border-color: #d4d4d4; }
    .ctrl button svg { width: 14px; height: 14px; flex-shrink: 0; }
  </style>
</head>
<body>
  <div id="app">
    <div id="vp">
      <div id="canvas">
        <svg id="esv">
          <defs>
            <marker id="arr" markerWidth="8" markerHeight="6" refX="7.5" refY="3"
              orient="auto" markerUnits="userSpaceOnUse">
              <polygon points="0 0, 8 3, 0 6" fill="rgba(10,10,10,0.55)" />
            </marker>
          </defs>
        </svg>
        <div id="groups"></div>
        <div id="labels"></div>
        <div id="nl"></div>
      </div>
    </div>

    <!-- Detail popup -->
    <div id="detail-backdrop"></div>
    <div id="detail">
      <div class="node-detail-header">
        <div class="node-detail-title-row">
          <div class="node-detail-dot" id="detail-dot"></div>
          <div class="node-detail-title-info">
            <h2 class="node-detail-name" id="detail-name"></h2>
            <span class="node-detail-badge" id="detail-badge"></span>
          </div>
        </div>
        <button class="node-detail-close" id="dp-close" title="Close">&#x2715;</button>
      </div>
      <div class="node-detail-content" id="dp-body"></div>
    </div>
  </div>

  <div class="ctrl">
    <button id="btn-zi" title="Zoom in">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M8 3v10M3 8h10"/>
      </svg>
    </button>
    <button id="btn-zo" title="Zoom out">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M3 8h10"/>
      </svg>
    </button>
    <button id="btn-fit" title="Fit to screen">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/>
      </svg>
    </button>
  </div>

  <script>
  (function() {
    'use strict';
    const D = ${payload};
    // Logo token is intentionally omitted from exported HTML to prevent
    // leaking credentials if the file is shared.  Logos are pre-fetched as
    // base64 data URIs at export time (using the token server-side), so the
    // runtime fallback below works without a token.
    const LOGO_TOKEN = '';

    // ── Constants (from constants.ts) ────────────────────────────────────
    const SC = {
      frontend:'#0078D4', backend:'#1EA7E1', webserver:'#0078D4',
      database:'#76B900', cache:'#FFB707', nodejs:'#5E9B00', python:'#9AD100',
      container:'#EC679B', broker:'#D96C00', realtime:'#1AA6A6',
      worker:'#6B7280', client:'#5C7AEA', service:'#F03603', external:'#EC679B',
    };
    const SL = {
      frontend:'Frontend', backend:'Backend', webserver:'Web Server',
      database:'Database', cache:'Cache', nodejs:'Node.js', python:'Python',
      container:'Container', broker:'Broker', realtime:'Realtime',
      worker:'Worker', client:'Client', service:'Service', external:'External',
    };
    const HC = { green:'#22C55E', yellow:'#EAB308', red:'#EF4444' };
    const HL = { green:'Active',  yellow:'Idle',    red:'Down'    };
    const HG = { green:'0 0 8px #22C55E60', yellow:'0 0 8px #EAB30860', red:'0 0 8px #EF444460' };
    const GROUP_COLOR = 'rgba(140,150,170,0.35)'; // matches app flowLayout GROUP_COLOR

    // ── Brand logo lookup (from brandIcons.tsx) ───────────────────────────
    const BRAND_DOMAIN = {
      openai:'openai.com', anthropic:'anthropic.com', groq:'groq.com',
      gemini:'ai.google.dev', 'google gemini':'ai.google.dev',
      'azure openai':'azure.microsoft.com', 'aws bedrock':'aws.amazon.com',
      cohere:'cohere.com', mistral:'mistral.ai', together:'together.ai',
      replicate:'replicate.com', 'hugging face':'huggingface.co',
      huggingface:'huggingface.co', openrouter:'openrouter.ai',
      perplexity:'perplexity.ai', deepgram:'deepgram.com',
      elevenlabs:'elevenlabs.io', pinecone:'pinecone.io',
      weaviate:'weaviate.io', supabase:'supabase.com',
      firebase:'firebase.google.com', stripe:'stripe.com',
      twilio:'twilio.com', sendgrid:'sendgrid.com', mailgun:'mailgun.com',
      sentry:'sentry.io', posthog:'posthog.com', segment:'segment.com',
      amplitude:'amplitude.com', mixpanel:'mixpanel.com', algolia:'algolia.com',
      cloudflare:'cloudflare.com', vercel:'vercel.com',
      'storefront-web':'vercel.com', 'storefront web':'vercel.com',
      chrome:'google.com', 'google chrome':'google.com',
      onedrive:'onedrive.com', raycast:'raycast.com', ollama:'ollama.com',
      github:'github.com', gitlab:'gitlab.com',
      vscode:'code.visualstudio.com', 'vs code':'code.visualstudio.com',
      'visual studio code':'code.visualstudio.com',
      slack:'slack.com', discord:'discord.com', notion:'notion.so',
      cartesia:'cartesia.ai', deepseek:'deepseek.com', 'x.ai':'x.ai',
      mongodb:'mongodb.com', postgres:'postgresql.org', postgresql:'postgresql.org',
      postman:'postman.com', mysql:'mysql.com', redis:'redis.io',
      rabbitmq:'rabbitmq.com', kafka:'kafka.apache.org', nats:'nats.io',
      nginx:'nginx.org', apache:'apache.org', electron:'electronjs.org',
      docker:'docker.com', podman:'podman.io',
      'node.js':'nodejs.org', node:'nodejs.org',
      python:'python.org', uwsgi:'python.org', gunicorn:'python.org',
      flask:'python.org', django:'djangoproject.com',
      fastapi:'fastapi.tiangolo.com', go:'go.dev', golang:'go.dev',
      gin:'gin-gonic.com', fiber:'gofiber.io',
      java:'java.com', php:'php.net', ruby:'ruby-lang.org',
      rails:'rubyonrails.org', 'ruby on rails':'rubyonrails.org',
    };

    function matchBrand(haystack, lookup) {
      const escaped = lookup.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      try { return new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'i').test(haystack); }
      catch { return haystack.includes(lookup); }
    }

    function normalizeBrand(value) {
      return String(value || '').trim().toLowerCase();
    }

    function logoDevUrl(domain) {
      let url = 'https://img.logo.dev/' + domain + '?size=64&format=png&fallback=monogram';
      if (LOGO_TOKEN) url += '&token=' + LOGO_TOKEN;
      return url;
    }

    function logoDevNameUrl(name) {
      let url = 'https://img.logo.dev/name/' + encodeURIComponent(name) + '?size=64&format=png&fallback=monogram';
      if (LOGO_TOKEN) url += '&token=' + LOGO_TOKEN;
      return url;
    }

    function isHostLike(v) { return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v); }
    function isRevDns(v) { return /^(com|org|net|io|dev|app|ai)\.[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v); }
    function extractDomain(v) { const m = String(v || '').match(/([a-z0-9.-]+\.[a-z]{2,})/i); return m ? m[1].toLowerCase() : null; }

    function inferServiceBrand(node) {
      const command = node.command || '';
      let runtimeCommand = command.includes(' | ')
        ? command.split(' | ').slice(1).join(' | ')
        : command;
      runtimeCommand = runtimeCommand.replace(/^docker-entrypoint\\.sh\\s+/i, '').trim();
      const dockerLangMatch = runtimeCommand.match(/^docker-([\\w]+)-entrypoint\\b/i);
      const dockerLangHint = dockerLangMatch ? dockerLangMatch[1] : null;
      if (dockerLangHint) {
        runtimeCommand = runtimeCommand.replace(/^docker-[\\w]+-entrypoint\\s*/i, '').trim();
      }
      const samples = [node.name, node.containerImage, dockerLangHint, runtimeCommand].filter(Boolean);
      for (const sample of samples) {
        const key = normalizeBrand(sample);
        const isPathLike = key.startsWith('/') || key.startsWith('~');
        if (!isPathLike) {
          if (BRAND_DOMAIN[key]) return sample;
          for (const lookup of Object.keys(BRAND_DOMAIN)) {
            if (matchBrand(key, lookup)) return sample;
          }
        }
        const host = extractDomain(sample);
        if (host) return host;
      }
      return null;
    }

    function getBrandImageUrl(value) {
      if (!value) return null;
      const key = normalizeBrand(value);
      if (BRAND_DOMAIN[key]) return logoDevUrl(BRAND_DOMAIN[key]);
      for (const [lookup, domain] of Object.entries(BRAND_DOMAIN)) {
        if (matchBrand(key, lookup)) return logoDevUrl(domain);
      }
      const extracted = extractDomain(key);
      if (extracted && isHostLike(extracted) && !isRevDns(extracted)) return logoDevUrl(extracted);
      if (isHostLike(key) && !isRevDns(key)) return logoDevUrl(key);
      if (key.length <= 80) return logoDevNameUrl(key);
      return null;
    }

    // Type priority (from constants.ts getTypePriority)
    function typePriority(t) {
      switch(t) {
        case 'frontend': return 0;
        case 'backend': case 'webserver': case 'nodejs': return 1;
        case 'python': case 'broker': case 'realtime': case 'client': case 'worker': return 2;
        case 'database': case 'cache': return 3;
        default: return 4;
      }
    }

    // Base name for grouping (from constants.ts getBaseName)
    function baseName(name) {
      let b = name.toLowerCase().trim();
      const envPfx = /^(?:fere[-_])?(?:test|demo|dev|prod|staging|stage|qa|local)[-_]+/i;
      while (envPfx.test(b)) b = b.replace(envPfx, '');
      b = b.replace(/[-_]?(server|api|service|app|client|worker|main|dev|prod|test)$/i, '');
      b = b.replace(/[-_]?\\d+$/, '');
      b = b.replace(/[-_]+$/, '');
      return b || name.toLowerCase();
    }

    function isSyntheticDockerNetworkEdge(edge) {
      return typeof edge.protocol === 'string' && edge.protocol.startsWith('docker-network:');
    }

    // Mirrors useGraphLayoutData hierarchy edge preprocessing so shared view
    // matches in-app layering when Docker-only network edges are present.
    function prepareGraphData(nodes, edges) {
      const localNodes = [...nodes]
        .filter(n => n.type !== 'external')
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const localNodeIds = new Set(localNodes.map(n => n.id));
      const localNodeById = new Map(localNodes.map((n) => [n.id, n]));
      const localEdges = [...edges]
        .filter((e) => localNodeIds.has(e.source) && localNodeIds.has(e.target))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

      const structuralEdges = localEdges.filter((edge) => !isSyntheticDockerNetworkEdge(edge));
      const effectiveHierarchyEdges = structuralEdges.length > 0 ? structuralEdges : localEdges;

      const hierarchyEdges = (() => {
        if (structuralEdges.length > 0) return effectiveHierarchyEdges;

        const normalized = new Map();
        for (const edge of effectiveHierarchyEdges) {
          if (!isSyntheticDockerNetworkEdge(edge)) {
            normalized.set(edge.id, edge);
            continue;
          }

          const sourceNode = localNodeById.get(edge.source);
          const targetNode = localNodeById.get(edge.target);
          if (!sourceNode || !targetNode) continue;

          const sourcePriority = typePriority(sourceNode.type);
          const targetPriority = typePriority(targetNode.type);
          if (sourcePriority === targetPriority) continue;

          const lowNode = sourcePriority < targetPriority ? sourceNode : targetNode;
          const highNode = sourcePriority < targetPriority ? targetNode : sourceNode;
          const lowPriority = Math.min(sourcePriority, targetPriority);
          const highPriority = Math.max(sourcePriority, targetPriority);

          if (lowPriority === 0 && highPriority !== 1) continue;
          if (lowPriority === 1 && highPriority > 3) continue;
          if (highPriority - lowPriority > 2) continue;

          const normalizedId = 'hier-' + lowNode.id + '-' + highNode.id;
          normalized.set(normalizedId, {
            ...edge,
            id: normalizedId,
            source: lowNode.id,
            target: highNode.id,
          });
        }

        return Array.from(normalized.values());
      })();

      const layoutEdges = (() => {
        const seen = new Set();
        return hierarchyEdges.filter((edge) => {
          const key = edge.source + '->' + edge.target;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      })();

      return {
        nodes: localNodes,
        layoutEdges,
      };
    }

    // ── Layout constants (from flowLayout.ts FLOW_LAYOUT) ────────────────
    const NW      = 260;  // NODE_WIDTH
    const NHB     = 190;  // NODE_MIN_HEIGHT (layout math base)
    const GAP_H   = 40;   // NODE_GAP
    const LAYER_GAP = 120; // LAYER_GAP
    const LABEL_H   = 44;  // height of tier label pill row
    const LABEL_GAP = 20;  // gap between label and first node

    // ── Layout algorithm (ported from layout.ts) ──────────────────────────
    function computeLayout(nodes, edges) {
      const nodeIds = new Set(nodes.map(n => n.id));

      // 1. Find connected vs standalone
      const connectedIds = new Set();
      edges.forEach(e => {
        if (nodeIds.has(e.source)) connectedIds.add(e.source);
        if (nodeIds.has(e.target)) connectedIds.add(e.target);
      });
      const connected  = nodes.filter(n => connectedIds.has(n.id));
      const standalone = nodes.filter(n => !connectedIds.has(n.id));

      // 2. Build adjacency for topological sort
      const outgoing = new Map();
      const incoming = new Map();
      const inDeg    = new Map();
      connected.forEach(n => { outgoing.set(n.id, new Set()); incoming.set(n.id, new Set()); inDeg.set(n.id, 0); });
      edges.forEach(e => {
        if (connectedIds.has(e.source) && connectedIds.has(e.target)) {
          outgoing.get(e.source).add(e.target);
          incoming.get(e.target).add(e.source);
          inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
        }
      });

      // 3. BFS topological layers
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      let roots = connected.filter(n => (inDeg.get(n.id) || 0) === 0)
                           .sort((a, b) => typePriority(a.type) - typePriority(b.type));
      if (roots.length === 0 && connected.length > 0) {
        roots = [[...connected].sort((a,b) => typePriority(a.type) - typePriority(b.type))[0]];
      }

      const layers = new Map();
      const visited = new Set();
      const queue = roots.map(n => ({ node: n, layer: 0 }));
      while (queue.length > 0) {
        const { node, layer } = queue.shift();
        if (visited.has(node.id)) {
          if (layer > (layers.get(node.id) || 0)) layers.set(node.id, layer);
          continue;
        }
        visited.add(node.id);
        layers.set(node.id, layer);
        (outgoing.get(node.id) || new Set()).forEach(childId => {
          const child = nodeMap.get(childId);
          if (child) queue.push({ node: child, layer: layer + 1 });
        });
      }
      connected.forEach(n => { if (!layers.has(n.id)) layers.set(n.id, 0); });

      // 4. Group by layer
      const nodesByLayer = new Map();
      connected.forEach(n => {
        const l = layers.get(n.id) || 0;
        if (!nodesByLayer.has(l)) nodesByLayer.set(l, []);
        nodesByLayer.get(l).push(n);
      });

      // 5. Initial ordering within layers
      const layerOrders = new Map();
      nodesByLayer.forEach((layerNodes) => {
        const groups = new Map();
        layerNodes.forEach(n => {
          const bn = baseName(n.name);
          if (!groups.has(bn)) groups.set(bn, []);
          groups.get(bn).push(n);
        });
        const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
          const ap = Math.min(...a[1].map(n => typePriority(n.type)));
          const bp = Math.min(...b[1].map(n => typePriority(n.type)));
          return ap !== bp ? ap - bp : b[1].length - a[1].length;
        });
        let order = 0;
        sortedGroups.forEach(([, gns]) => {
          gns.sort((a, b) => typePriority(a.type) - typePriority(b.type) || a.name.localeCompare(b.name));
          gns.forEach(n => layerOrders.set(n.id, order++));
        });
      });

      // 6. Barycenter crossing minimization (6 iterations)
      const sortedLayerNums = Array.from(nodesByLayer.keys()).sort((a,b) => a-b);
      function barycenter(nodeId, adjSet) {
        if (!adjSet || adjSet.size === 0) return 0;
        let sum = 0, count = 0;
        adjSet.forEach(id => { const o = layerOrders.get(id); if (o !== undefined) { sum += o; count++; } });
        return count > 0 ? sum / count : 0;
      }
      for (let iter = 0; iter < 6; iter++) {
        for (let i = 1; i < sortedLayerNums.length; i++) {
          const ln = nodesByLayer.get(sortedLayerNums[i]) || [];
          const bc = ln.map(n => ({ n, bc: barycenter(n.id, incoming.get(n.id)), bn: baseName(n.name), o: layerOrders.get(n.id)||0 }));
          bc.sort((a,b) => a.bc !== b.bc ? a.bc - b.bc : a.bn !== b.bn ? a.bn.localeCompare(b.bn) : a.o - b.o);
          bc.forEach((item, idx) => layerOrders.set(item.n.id, idx));
        }
        for (let i = sortedLayerNums.length - 2; i >= 0; i--) {
          const ln = nodesByLayer.get(sortedLayerNums[i]) || [];
          const bc = ln.map(n => ({ n, bc: barycenter(n.id, outgoing.get(n.id)), bn: baseName(n.name), o: layerOrders.get(n.id)||0 }));
          bc.sort((a,b) => a.bc !== b.bc ? a.bc - b.bc : a.bn !== b.bn ? a.bn.localeCompare(b.bn) : a.o - b.o);
          bc.forEach((item, idx) => layerOrders.set(item.n.id, idx));
        }
      }

      return { nodesByLayer, sortedLayerNums, layerOrders, layers, standalone, outgoing, incoming };
    }

    // ── Place nodes on canvas ─────────────────────────────────────────────
    function placeNodes(nodes, edges) {
      const { nodesByLayer, sortedLayerNums, layerOrders, standalone } = computeLayout(nodes, edges);
      const PAD = 80;
      const estimateNodeHeight = (node) => {
        let estimated = NHB;
        if (node.routes && node.routes.length > 0) {
          const visibleRoutes = Math.min(3, node.routes.length);
          estimated += 26 + visibleRoutes * 18 + (node.routes.length > 3 ? 16 : 0);
        }
        return estimated;
      };

      let maxRowW = 0;
      sortedLayerNums.forEach(layerNum => {
        const ln = nodesByLayer.get(layerNum) || [];
        const rowW = ln.length * NW + (ln.length - 1) * GAP_H;
        maxRowW = Math.max(maxRowW, rowW);
      });

      if (standalone.length > 0) {
        const STANDALONE_NODE_GAP = 36;
        const STANDALONE_GROUP_GAP = 24;
        const GROUP_BOX_PADDING = 16;
        const LABEL_WIDTH = 240;
        const MAX_STANDALONE_COLUMNS = 2;
        const MAX_SYSTEM_SERVICE_COLUMNS = 3;

        const standaloneGroupsMap = new Map();
        standalone.forEach((n) => {
          const type = n.type || 'service';
          const key = n.isDocker ? ('docker:' + type) : type;
          const list = standaloneGroupsMap.get(key) || [];
          list.push(n);
          standaloneGroupsMap.set(key, list);
        });

        const standaloneGroups = Array.from(standaloneGroupsMap.entries())
          .sort((a, b) => {
            const aDocker = a[0].startsWith('docker:') ? 1 : 0;
            const bDocker = b[0].startsWith('docker:') ? 1 : 0;
            if (aDocker !== bDocker) return aDocker - bDocker;
            const aType = a[0].replace('docker:', '');
            const bType = b[0].replace('docker:', '');
            const pd = typePriority(aType) - typePriority(bType);
            return pd !== 0 ? pd : aType.localeCompare(bType);
          })
          .map(([key, nodes]) => {
            const isDocker = key.startsWith('docker:');
            const type = isDocker ? key.replace('docker:', '') : key;
            return {
              groupType: type,
              isGroup: isDocker || nodes.length > 1,
              nodes,
            };
          });

        const standaloneWidth =
          standaloneGroups
            .map((group) => {
              const desiredColumns = Math.ceil(Math.sqrt(group.nodes.length));
              const maxColumns = group.groupType === 'service'
                ? MAX_SYSTEM_SERVICE_COLUMNS
                : MAX_STANDALONE_COLUMNS;
              const columnCount = Math.min(
                Math.max(1, desiredColumns),
                Math.min(maxColumns, group.nodes.length),
              );
              const width = columnCount * NW + (columnCount - 1) * STANDALONE_NODE_GAP;
              return group.isGroup
                ? Math.max(width + GROUP_BOX_PADDING * 2, LABEL_WIDTH)
                : width;
            })
            .reduce((sum, width) => sum + width, 0) +
          STANDALONE_GROUP_GAP * Math.max(0, standaloneGroups.length - 1);

        maxRowW = Math.max(maxRowW, standaloneWidth);
      }

      const canvasW = maxRowW + PAD * 2;
      const cx = canvasW / 2;

      let curY = PAD;
      const pos = {};
      const labelInfos = [];
      // groupInfos: [{x, y, width, height, color, label, nodeIds}]
      const groupInfos = [];

      const GRP_PAD_X = 20;
      const GRP_PAD_Y = 16;
      const GRP_TOP_EXTRA = 34; // extra space at top for group label

      sortedLayerNums.forEach((layerNum) => {
        const ln = nodesByLayer.get(layerNum) || [];
        const sorted = [...ln].sort((a, b) => (layerOrders.get(a.id)||0) - (layerOrders.get(b.id)||0));

        // Tier label
        labelInfos.push({ text: 'Layer ' + layerNum, cx, y: curY });
        curY += LABEL_H + LABEL_GAP;

        const rowW = sorted.length * NW + (sorted.length - 1) * GAP_H;
        const startX = cx - rowW / 2;

        sorted.forEach((n, i) => {
          pos[n.id] = { x: startX + i * (NW + GAP_H), y: curY };
        });

        // Compute group boxes for this layer (nodes with same baseName, count > 1)
        const bnGroups = new Map();
        sorted.forEach(n => {
          const bn = baseName(n.name);
          if (!bnGroups.has(bn)) bnGroups.set(bn, []);
          bnGroups.get(bn).push(n);
        });
        bnGroups.forEach((gNodes, bn) => {
          if (gNodes.length < 2) return;
          const xs = gNodes.map(n => pos[n.id]?.x).filter(x => x !== undefined);
          if (xs.length === 0) return;
          const minX = Math.min(...xs) - GRP_PAD_X;
          const maxX = Math.max(...xs) + NW + GRP_PAD_X;
          const gY   = curY - GRP_PAD_Y - GRP_TOP_EXTRA;
          const gH   = NHB + GRP_PAD_Y * 2 + GRP_TOP_EXTRA;
          const color = GROUP_COLOR;
          const label = bn.charAt(0).toUpperCase() + bn.slice(1);
          groupInfos.push({
            x: minX, y: gY, width: maxX - minX, height: gH,
            color, label,
            nodeIds: new Set(gNodes.map(n => n.id)),
            nodeY: curY, // actual node top
          });
        });

        curY += NHB + LAYER_GAP;
      });

      // Standalone section — grouped by type (matches app standalone grouping)
      if (standalone.length > 0) {
        const STANDALONE_NODE_GAP = 36;
        const STANDALONE_GROUP_GAP = 24;
        const STANDALONE_LABEL_OFFSET = 64;
        const STANDALONE_SECTION_OFFSET = 120;
        const GROUP_BOX_PADDING = 16;
        const LABEL_WIDTH = 240;
        const MAX_STANDALONE_COLUMNS = 2;
        const MAX_SYSTEM_SERVICE_COLUMNS = 3;

        const standaloneGroupsMap = new Map();
        standalone.forEach((n) => {
          const type = n.type || 'service';
          const key = n.isDocker ? ('docker:' + type) : type;
          const list = standaloneGroupsMap.get(key) || [];
          list.push(n);
          standaloneGroupsMap.set(key, list);
        });

        const standaloneGroups = Array.from(standaloneGroupsMap.entries())
          .sort((a, b) => {
            const aDocker = a[0].startsWith('docker:') ? 1 : 0;
            const bDocker = b[0].startsWith('docker:') ? 1 : 0;
            if (aDocker !== bDocker) return aDocker - bDocker;
            const aType = a[0].replace('docker:', '');
            const bType = b[0].replace('docker:', '');
            const pd = typePriority(aType) - typePriority(bType);
            return pd !== 0 ? pd : aType.localeCompare(bType);
          })
          .map(([key, nodes]) => {
            const isDocker = key.startsWith('docker:');
            const type = isDocker ? key.replace('docker:', '') : key;
            let groupName;
            if (isDocker) groupName = 'Docker Containers';
            else if (type === 'service') groupName = 'System Services';
            else groupName = SL[type] || (type.charAt(0).toUpperCase() + type.slice(1));
            return {
              groupName,
              groupType: type,
              isGroup: isDocker || nodes.length > 1,
              nodes: [...nodes].sort((a, b) => a.name.localeCompare(b.name)),
            };
          });

        const baseY = curY + STANDALONE_SECTION_OFFSET;
        labelInfos.push({
          text: 'Standalone Services',
          cx,
          y: baseY - STANDALONE_SECTION_OFFSET,
          isStandalone: true,
        });

        const meta = standaloneGroups.map((group) => {
          const desiredColumns = Math.ceil(Math.sqrt(group.nodes.length));
          const maxColumns = group.groupType === 'service'
            ? MAX_SYSTEM_SERVICE_COLUMNS
            : MAX_STANDALONE_COLUMNS;
          const columnCount = Math.min(
            Math.max(1, desiredColumns),
            Math.min(maxColumns, group.nodes.length),
          );
          const rowCount = Math.ceil(group.nodes.length / columnCount);
          const width = columnCount * NW + (columnCount - 1) * STANDALONE_NODE_GAP;
          const rowHeights = new Array(rowCount).fill(NHB);
          const height =
            rowHeights.reduce((sum, h) => sum + h, 0) +
            (rowCount - 1) * STANDALONE_NODE_GAP;
          return {
            group,
            columnCount,
            width,
            height,
            occupiedWidth: group.isGroup
              ? Math.max(width + GROUP_BOX_PADDING * 2, LABEL_WIDTH)
              : width,
            rowHeights,
          };
        });

        const rowY = baseY;
        const rowWidth =
          meta.reduce((sum, item) => sum + item.occupiedWidth, 0) +
          STANDALONE_GROUP_GAP * Math.max(0, meta.length - 1);
        let cursorX = cx - rowWidth / 2;

        meta.forEach((item) => {
          const groupCenterX = cursorX + item.occupiedWidth / 2;
          const groupX = item.group.isGroup
            ? groupCenterX - item.width / 2
            : cursorX;

          item.group.nodes.forEach((n, idx) => {
            const row = Math.floor(idx / item.columnCount);
            const col = idx % item.columnCount;
            const nodesInRow = Math.min(
              item.columnCount,
              item.group.nodes.length - row * item.columnCount,
            );
            const rowWidth = nodesInRow * NW + (nodesInRow - 1) * STANDALONE_NODE_GAP;
            const colOffset = (item.width - rowWidth) / 2;
            const rowOffset =
              (item.rowHeights || []).slice(0, row).reduce((sum, h) => sum + h, 0) +
              row * STANDALONE_NODE_GAP;
            pos[n.id] = {
              x: groupX + colOffset + col * (NW + STANDALONE_NODE_GAP),
              y: rowY + rowOffset,
            };
          });

          if (item.group.isGroup) {
            const nodeXs = item.group.nodes.map((n) => pos[n.id].x);
            const nodeYs = item.group.nodes.map((n) => pos[n.id].y);
            const nodeBottoms = item.group.nodes.map((n) => pos[n.id].y + estimateNodeHeight(n));
            const minX = Math.min(...nodeXs) - GROUP_BOX_PADDING;
            const maxX = Math.max(...nodeXs) + NW + GROUP_BOX_PADDING;
            const minY = Math.min(...nodeYs) - GROUP_BOX_PADDING;
            const maxY = Math.max(...nodeBottoms) + GROUP_BOX_PADDING;

            groupInfos.push({
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
              color: GROUP_COLOR,
              label: item.group.groupName,
              centerLabel: true,
              labelCx: (minX + maxX) / 2,
              labelY: Math.min(...nodeYs) - STANDALONE_LABEL_OFFSET,
              nodeIds: new Set(item.group.nodes.map((n) => n.id)),
            });
          }

          cursorX += item.occupiedWidth + STANDALONE_GROUP_GAP;
        });

        const rowHeight = meta.length > 0
          ? Math.max(...meta.map((item) =>
              item.height + (item.group.isGroup ? GROUP_BOX_PADDING : 0),
            ))
          : 0;
        curY = rowY + rowHeight + STANDALONE_GROUP_GAP + STANDALONE_LABEL_OFFSET;
      }

      const canvasH = curY + PAD;
      return { pos, labelInfos, groupInfos, canvasW, canvasH };
    }

    // ── Edge path ─────────────────────────────────────────────────────────
    function makePath(p1x, p1y, h1, p2x, p2y, h2) {
      const nodeDy = p2y - p1y;
      const nodeDx = p2x - p1x;

      if (Math.abs(nodeDy) < NHB * 0.55) {
        const srcCy = p1y + h1 / 2;
        const tgtCy = p2y + h2 / 2;
        let sx, sy, tx, ty;
        if (nodeDx >= 0) {
          sx = p1x + NW; sy = srcCy;
          tx = p2x;      ty = tgtCy;
        } else {
          sx = p1x;      sy = srcCy;
          tx = p2x + NW; ty = tgtCy;
        }
        const cv = Math.max(40, Math.abs(tx - sx) * 0.45);
        const sign = tx >= sx ? 1 : -1;
        return 'M ' + sx + ' ' + sy +
          ' C ' + (sx + sign * cv) + ' ' + sy +
          ' ' + (tx - sign * cv) + ' ' + ty +
          ' ' + tx + ' ' + ty;
      }

      if (nodeDy > 0) {
        const sx = p1x + NW / 2;
        const sy = p1y + h1;
        const tx = p2x + NW / 2;
        const ty = p2y;
        const dy = ty - sy;
        const cv = Math.max(60, dy * 0.45);
        return 'M ' + sx + ' ' + sy +
          ' C ' + sx + ' ' + (sy + cv) +
          ' ' + tx + ' ' + (ty - cv) +
          ' ' + tx + ' ' + ty;
      }

      const sx = p1x + NW / 2;
      const sy = p1y;
      const tx = p2x + NW / 2;
      const ty = p2y + h2;
      const hx = (nodeDx >= 0 ? 1 : -1) * (Math.abs(nodeDx) * 0.45 + 90);
      return 'M ' + sx + ' ' + sy +
        ' C ' + (sx + hx) + ' ' + (sy - 60) +
        ' ' + (tx + hx) + ' ' + (ty + 60) +
        ' ' + tx + ' ' + ty;
    }

    // ── HTML escape helper ─────────────────────────────────────────────────
    function esc(s) {
      return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Create node DOM element ────────────────────────────────────────────
    function createNodeEl(n) {
      const color  = SC[n.type] || '#6B7280';
      const label  = SL[n.type] || 'Service';
      const hColor = HC[n.healthStatus] || HC.yellow;
      const hLabel = HL[n.healthStatus] || 'Idle';
      const hGlow  = HG[n.healthStatus] || HG.yellow;
      const mainPort = n.ports[0]?.port || n.ports[0];
      const projectLabel = n.projectPath ? n.projectPath.split('/').pop() : null;
      const serviceBrand = n.isDocker && n.type === 'container' ? 'docker' : inferServiceBrand(n);
      const logoUrl = (D.logos && D.logos[n.id]) || getBrandImageUrl(serviceBrand);
      const logoFallback = serviceBrand ? esc(String(serviceBrand).trim().charAt(0).toUpperCase() || '?') : '?';

      const div = document.createElement('div');
      div.className = 'node';
      div.dataset.id = n.id;

      let html = '';

      // Header
      html += '<div class="n-header">';
      html += '<div class="n-status">';
      html += '<div class="n-dot" style="background:' + hColor + ';box-shadow:' + hGlow + '"></div>';
      html += '<span class="n-hlabel" style="color:' + hColor + '">' + hLabel + '</span>';
      html += '</div>';
      html += '<span class="n-badge" style="background:' + color + '15;color:' + color + '">' + esc(label) + '</span>';
      html += '</div>';

      // Name row with brand icon fallback (matches app BrandIcon behavior)
      if (serviceBrand) {
        html += '<div class="n-logo-row">';
        if (logoUrl) {
          html += '<span class="brand-icon">';
          html += '<img class="brand-icon-image n-logo" src="' + esc(logoUrl) + '" loading="lazy" ';
          html += 'onerror="this.style.display=\\'none\\';if(this.nextElementSibling)this.nextElementSibling.style.display=\\'inline-flex\\'" />';
          html += '<span class="brand-icon brand-icon-fallback" style="display:none">' + logoFallback + '</span>';
          html += '</span>';
        } else {
          html += '<span class="brand-icon brand-icon-fallback">' + logoFallback + '</span>';
        }
        html += '<div class="n-name" title="' + esc(n.name) + '">' + esc(n.name) + '</div>';
        html += '</div>';
      } else {
        html += '<div class="n-name" title="' + esc(n.name) + '">' + esc(n.name) + '</div>';
      }

      // Docker image
      if (n.isDocker && n.containerImage) {
        const imgShort = (n.containerImage.split('/').pop() || '').split(':')[0] || n.containerImage;
        html += '<div class="n-docker-img">' + esc(imgShort) + '</div>';
      }

      // Project label (non-docker)
      if (!n.isDocker && projectLabel) {
        html += '<div class="n-project">' + esc(projectLabel) + '</div>';
      }

      // Port
      if (mainPort) {
        html += '<div class="n-port"><span class="n-port-host">localhost</span><span style="color:' + color + ';font-weight:600">:' + esc(String(mainPort)) + '</span></div>';
      }

      // Container networks
      if (n.containerNetworks && n.containerNetworks.length > 0) {
        html += '<div class="n-networks">' + esc(n.containerNetworks.join(', ')) + '</div>';
      }

      // Routes (first 3)
      const showRoutes = n.routes.slice(0, 3);
      if (showRoutes.length > 0) {
        html += '<div class="n-routes">';
        html += '<div class="n-routes-hdr"><span class="n-routes-title">API routes</span><span class="n-routes-count">' + n.routes.length + '</span></div>';
        html += '<div class="n-routes-list">';
        for (const r of showRoutes) {
          const m = r.method.toUpperCase();
          html += '<div class="n-route"><span class="n-method ' + esc(m) + '">' + esc(m) + '</span><span class="n-route-path" title="' + esc(r.path) + '">' + esc(r.path) + '</span></div>';
        }
        if (n.routes.length > 3) {
          html += '<div class="n-routes-more">+' + (n.routes.length - 3) + ' more</div>';
        }
        html += '</div></div>';
      }

      div.innerHTML = html;
      return div;
    }

    // ── Detail popup ───────────────────────────────────────────────────────
    const detailEl   = document.getElementById('detail');
    const backdropEl = document.getElementById('detail-backdrop');
    const detailDot  = document.getElementById('detail-dot');
    const detailName = document.getElementById('detail-name');
    const detailBadge = document.getElementById('detail-badge');
    const dpBody     = document.getElementById('dp-body');
    const dpClose    = document.getElementById('dp-close');

    function formatLastSeen(ts) {
      if (!ts) return 'unknown';
      const now = Date.now();
      const diff = now - ts;
      if (diff < 1000) return 'just now';
      if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      const d = new Date(ts);
      try { return d.toLocaleTimeString(); } catch { return String(d); }
    }

    function openDetail(n, allEdges, nodesMap) {
      const color  = SC[n.type] || '#6B7280';
      const hColor = HC[n.healthStatus] || HC.yellow;
      const hLabel = HL[n.healthStatus] || 'Idle';
      const hGlow  = HG[n.healthStatus] || HG.yellow;
      detailDot.style.backgroundColor = color;
      detailDot.style.boxShadow = '0 0 12px ' + color + '50';
      detailName.textContent = n.name || '';
      detailBadge.textContent = SL[n.type] || 'Service';
      detailBadge.style.backgroundColor = color + '15';
      detailBadge.style.color = color;

      // Body
      let html = '';

      // Health
      html += '<div class="node-detail-section">';
      html += '<h3 class="node-detail-section-title">Health Status</h3>';
      html += '<div class="node-detail-health">';
      html += '<div class="node-detail-health-indicator">';
      html += '<div class="node-detail-health-dot" style="background:' + hColor + ';box-shadow:' + hGlow + '"></div>';
      html += '<span class="node-detail-health-label" style="color:' + hColor + '">' + hLabel + '</span>';
      html += '</div>';
      html += '<div class="node-detail-health-meta">';
      html += '<span class="node-detail-label">Last seen</span>';
      html += '<span class="node-detail-value">' + esc(formatLastSeen(n.lastSeen)) + '</span>';
      html += '</div>';
      html += '</div></div>';

      // Process / Container info
      if (!n.isDocker) {
        html += '<div class="node-detail-section"><h3 class="node-detail-section-title">Process Information</h3>';
        html += '<div class="node-detail-grid">';
        if (n.pid) html += '<div class="node-detail-item"><span class="node-detail-label">PID</span><span class="node-detail-value mono">' + esc(String(n.pid)) + '</span></div>';
        if (n.user) html += '<div class="node-detail-item"><span class="node-detail-label">User</span><span class="node-detail-value">' + esc(n.user) + '</span></div>';
        html += '<div class="node-detail-item"><span class="node-detail-label">CPU</span><span class="node-detail-value mono">' + esc((n.cpu || 0).toFixed(1)) + '%</span></div>';
        html += '<div class="node-detail-item"><span class="node-detail-label">Memory</span><span class="node-detail-value mono">' + esc((n.memory || 0).toFixed(1)) + '%</span></div>';
        html += '</div></div>';
      } else {
        html += '<div class="node-detail-section"><h3 class="node-detail-section-title">Container Information</h3>';
        html += '<div class="node-detail-grid">';
        if (n.containerId) html += '<div class="node-detail-item"><span class="node-detail-label">Container ID</span><span class="node-detail-value mono">' + esc(n.containerId.substring(0, 12)) + '</span></div>';
        if (n.containerState) html += '<div class="node-detail-item"><span class="node-detail-label">State</span><span class="node-detail-value docker-state docker-state-' + esc(String(n.containerState).toLowerCase()) + '">' + esc(n.containerState) + '</span></div>';
        html += '<div class="node-detail-item"><span class="node-detail-label">CPU</span><span class="node-detail-value mono">' + esc((n.cpu || 0).toFixed(1)) + '%</span></div>';
        html += '<div class="node-detail-item"><span class="node-detail-label">Memory</span><span class="node-detail-value mono">' + esc(n.memoryUsage || ((n.memory || 0).toFixed(1) + '%')) + '</span></div>';
        html += '</div>';
        if (n.containerImage) html += '<div class="node-detail-item full-width" style="margin-top:8px"><span class="node-detail-label">Image</span><span class="node-detail-value mono small">' + esc(n.containerImage) + '</span></div>';
        if (n.containerStatus) html += '<div class="node-detail-item full-width" style="margin-top:4px"><span class="node-detail-label">Status</span><span class="node-detail-value small">' + esc(n.containerStatus) + '</span></div>';
        html += '</div>';
      }

      // Command
      if (n.command) {
        html += '<div class="node-detail-section"><h3 class="node-detail-section-title">Command</h3>';
        html += '<div class="node-detail-command">' + esc(n.command) + '</div></div>';
      }

      // Project
      if (n.project || n.projectPath) {
        html += '<div class="node-detail-section"><h3 class="node-detail-section-title">Project</h3>';
        html += '<div class="node-detail-grid">';
        if (n.project) html += '<div class="node-detail-item full-width"><span class="node-detail-label">Name</span><span class="node-detail-value">' + esc(n.project) + '</span></div>';
        if (n.projectPath) html += '<div class="node-detail-item full-width"><span class="node-detail-label">Path</span><span class="node-detail-value mono small">' + esc(n.projectPath) + '</span></div>';
        html += '</div></div>';
      }

      // Ports (all)
      if (n.ports && n.ports.length > 0) {
        html += '<div class="node-detail-section"><h3 class="node-detail-section-title">Ports <span class="node-detail-count">' + n.ports.length + '</span></h3>';
        html += '<div class="node-detail-ports">';
        n.ports.forEach(p => {
          const portNum = p.port || p;
          html += '<div class="node-detail-port">';
          html += '<span class="node-detail-port-number" style="color:' + color + '">:' + esc(String(portNum)) + '</span>';
          if (p.host) html += '<span class="node-detail-port-host">' + esc(p.host) + '</span>';
          if (p.description) html += '<span class="node-detail-port-desc">' + esc(p.description) + '</span>';
          html += '</div>';
        });
        html += '</div></div>';
      }

      // API Routes (all)
      if (n.routes && n.routes.length > 0) {
        html += '<div class="node-detail-section"><h3 class="node-detail-section-title">API Routes <span class="node-detail-count">' + n.routes.length + '</span></h3>';
        html += '<div class="node-detail-routes">';
        n.routes.forEach(r => {
          const m = r.method.toUpperCase();
          html += '<div class="node-detail-route"><span class="route-method route-' + esc(m.toLowerCase()) + '">' + esc(m) + '</span><span class="node-detail-route-path">' + esc(r.path) + '</span></div>';
        });
        html += '</div></div>';
      }

      // Connections
      const incoming = allEdges.filter(e => e.target === n.id);
      const outgoing = allEdges.filter(e => e.source === n.id);
      if (incoming.length > 0 || outgoing.length > 0) {
        html += '<div class="node-detail-section"><h3 class="node-detail-section-title">Connections</h3><div class="node-detail-connections">';
        if (incoming.length > 0) {
          html += '<div class="node-detail-connection-group"><span class="node-detail-connection-label">Incoming</span>';
          incoming.forEach(e => {
            const srcName = nodesMap.get(e.source)?.name || e.source;
            html += '<div class="node-detail-connection"><span class="connection-arrow">←</span><span class="connection-node">' + esc(srcName) + '</span>';
            if (e.sourcePort || e.targetPort) html += '<span class="connection-port">:' + esc(String(e.sourcePort || '')) + ' → :' + esc(String(e.targetPort || '')) + '</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        if (outgoing.length > 0) {
          html += '<div class="node-detail-connection-group"><span class="node-detail-connection-label">Outgoing</span>';
          outgoing.forEach(e => {
            const tgtName = nodesMap.get(e.target)?.name || e.target;
            html += '<div class="node-detail-connection"><span class="connection-arrow">→</span><span class="connection-node">' + esc(tgtName) + '</span>';
            if (e.sourcePort || e.targetPort) html += '<span class="connection-port">:' + esc(String(e.sourcePort || '')) + ' → :' + esc(String(e.targetPort || '')) + '</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</div></div>';
      }

      dpBody.innerHTML = html;
      dpBody.scrollTop = 0;
      detailEl.classList.add('open');
      backdropEl.classList.add('open');
      document.body.classList.add('detail-open');
    }

    function closeDetail() {
      detailEl.classList.remove('open');
      backdropEl.classList.remove('open');
      document.body.classList.remove('detail-open');
    }

    dpClose.addEventListener('click', closeDetail);
    backdropEl.addEventListener('click', closeDetail);

    // ── Render ────────────────────────────────────────────────────────────
    function render() {
      const prepared = prepareGraphData(D.nodes, D.edges);
      const nodes = prepared.nodes;
      const edges = prepared.layoutEdges;
      const { pos, labelInfos, groupInfos, canvasW, canvasH } = placeNodes(nodes, edges);
      const nodesMap = new Map(nodes.map(n => [n.id, n]));

      const vp      = document.getElementById('vp');
      const canvas  = document.getElementById('canvas');
      const nl      = document.getElementById('nl');
      const esv     = document.getElementById('esv');
      const lblCont = document.getElementById('labels');
      const grpCont = document.getElementById('groups');

      canvas.style.width  = canvasW + 'px';
      canvas.style.height = canvasH + 'px';
      esv.setAttribute('width',  canvasW);
      esv.setAttribute('height', canvasH);

      // Draw group boxes (behind nodes)
      const groupRenderRefs = [];
      groupInfos.forEach(gi => {
        const box = document.createElement('div');
        box.className = 'group-box';
        box.style.left   = gi.x + 'px';
        box.style.top    = gi.y + 'px';
        box.style.width  = gi.width + 'px';
        box.style.height = gi.height + 'px';
        box.style.setProperty('--gc', gi.color);
        grpCont.appendChild(box);

        const lbl = document.createElement('div');
        lbl.className = gi.centerLabel ? 'group-label group-label-centered' : 'group-label';
        lbl.textContent = gi.label;
        if (gi.centerLabel) {
          lbl.style.left = gi.labelCx + 'px';
          lbl.style.top = gi.labelY + 'px';
        } else {
          lbl.style.left = (gi.x + 14) + 'px';
          lbl.style.top  = (gi.y + 10) + 'px';
        }
        lbl.style.setProperty('--gc', gi.color);
        grpCont.appendChild(lbl);
        groupRenderRefs.push({ gi, box, lbl });
      });

      // Tier / standalone labels
      labelInfos.forEach(li => {
        const el = document.createElement('div');
        el.className = li.isStandalone ? 'standalone-label' : 'tier-label';
        el.textContent = li.text;
        el.style.left = li.cx + 'px';
        el.style.top  = li.y + 'px';
        lblCont.appendChild(el);
      });

      // Build adjacency for hover (bidirectional)
      const adj = {};
      nodes.forEach(n => adj[n.id] = new Set());
      edges.forEach(e => {
        if (adj[e.source]) adj[e.source].add(e.target);
        if (adj[e.target]) adj[e.target].add(e.source);
      });

      // Build edge lookup map
      const edgesByNode = {};
      edges.forEach(e => {
        if (!edgesByNode[e.source]) edgesByNode[e.source] = [];
        if (!edgesByNode[e.target]) edgesByNode[e.target] = [];
        edgesByNode[e.source].push(e.id);
        edgesByNode[e.target].push(e.id);
      });

      // Render node elements
      const nodeEls = {};
      for (const n of nodes) {
        if (!pos[n.id]) continue;
        const el = createNodeEl(n);
        el.style.left = pos[n.id].x + 'px';
        el.style.top  = pos[n.id].y + 'px';
        nl.appendChild(el);
        nodeEls[n.id] = el;
      }

      // Use real rendered node bounds so standalone group backgrounds always
      // fit cards exactly (font metrics/content can vary per environment).
      const STANDALONE_LABEL_OFFSET = 64;
      const GROUP_BOX_PADDING = 16;
      groupRenderRefs.forEach(({ gi, box, lbl }) => {
        if (!gi.centerLabel || !gi.nodeIds || gi.nodeIds.size === 0) return;

        const memberEls = Array.from(gi.nodeIds)
          .map((id) => nodeEls[id])
          .filter(Boolean);
        if (memberEls.length === 0) return;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        memberEls.forEach((el) => {
          const x = parseFloat(el.style.left) || 0;
          const y = parseFloat(el.style.top) || 0;
          const w = el.offsetWidth || NW;
          const h = el.offsetHeight || NHB;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w);
          maxY = Math.max(maxY, y + h);
        });

        const boxX = minX - GROUP_BOX_PADDING;
        const boxY = minY - GROUP_BOX_PADDING;
        const boxW = (maxX - minX) + GROUP_BOX_PADDING * 2;
        const boxH = (maxY - minY) + GROUP_BOX_PADDING * 2;

        box.style.left = boxX + 'px';
        box.style.top = boxY + 'px';
        box.style.width = boxW + 'px';
        box.style.height = boxH + 'px';

        lbl.style.left = ((minX + maxX) / 2) + 'px';
        lbl.style.top = (minY - STANDALONE_LABEL_OFFSET) + 'px';
      });

      // After nodes are in DOM, measure actual heights then draw edges
      requestAnimationFrame(() => {
        const heights = {};
        for (const id in nodeEls) heights[id] = nodeEls[id].offsetHeight || NHB;

        // Update only layer-group box heights to match measured node heights.
        // Standalone grouped boxes are already fully measured from DOM bounds above.
        groupRenderRefs.forEach(({ gi, box }) => {
          if (gi.centerLabel) return;
          let maxH = NHB;
          gi.nodeIds.forEach((id) => {
            maxH = Math.max(maxH, heights[id] || NHB);
          });
          const GRP_PAD_Y = 16;
          const GRP_TOP_EXTRA = 34;
          box.style.height = (maxH + GRP_PAD_Y * 2 + GRP_TOP_EXTRA) + 'px';
        });

        // Draw edges
        const edgeEls = {};
        for (const e of edges) {
          const p1 = pos[e.source], p2 = pos[e.target];
          if (!p1 || !p2) continue;

          const d = makePath(
            p1.x, p1.y, heights[e.source] || NHB,
            p2.x, p2.y, heights[e.target] || NHB
          );

          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          g.setAttribute('class', 'e-group');
          g.dataset.id  = e.id;
          g.dataset.src = e.source;
          g.dataset.tgt = e.target;

          const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          shadow.setAttribute('d', d);
          shadow.setAttribute('class', 'e-shadow');
          shadow.setAttribute('stroke-width', '3');

          const dash = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          dash.setAttribute('d', d);
          dash.setAttribute('class', 'e-dash');
          dash.setAttribute('stroke-width', '1.5');
          dash.setAttribute('marker-end', 'url(#arr)');

          g.appendChild(shadow);
          g.appendChild(dash);
          esv.appendChild(g);
          edgeEls[e.id] = g;
        }

        // Hover — show edges, dim/highlight nodes
        const allNodeEls = document.querySelectorAll('.node');
        const allEdgeEls = document.querySelectorAll('.e-group');
        let mouseDownMoved = false;
        let mouseDownPos = null;

        allNodeEls.forEach(el => {
          const nid = el.dataset.id;

          el.addEventListener('mouseenter', () => {
            const connIds = adj[nid] || new Set();
            const myEdgeIds = new Set(edgesByNode[nid] || []);

            allNodeEls.forEach(nd => {
              const isHovered = nd.dataset.id === nid;
              const isConn    = connIds.has(nd.dataset.id);
              nd.classList.toggle('dimmed',      !isHovered && !isConn);
              nd.classList.toggle('highlighted', isHovered);
            });

            allEdgeEls.forEach(eg => {
              eg.classList.toggle('connected', myEdgeIds.has(eg.dataset.id));
            });
          });

          el.addEventListener('mouseleave', () => {
            allNodeEls.forEach(nd => { nd.classList.remove('dimmed', 'highlighted'); });
            allEdgeEls.forEach(eg => { eg.classList.remove('connected'); });
          });

          // Track mouse movement to distinguish click from drag
          el.addEventListener('mousedown', e => {
            mouseDownMoved = false;
            mouseDownPos = { x: e.clientX, y: e.clientY };
          });
          el.addEventListener('mousemove', e => {
            if (mouseDownPos) {
              const dx = e.clientX - mouseDownPos.x;
              const dy = e.clientY - mouseDownPos.y;
              if (Math.abs(dx) > 4 || Math.abs(dy) > 4) mouseDownMoved = true;
            }
          });
          el.addEventListener('mouseup', e => {
            if (!mouseDownMoved) {
              const node = nodesMap.get(nid);
              if (node) openDetail(node, edges, nodesMap);
            }
            mouseDownPos = null;
          });
        });

        requestAnimationFrame(fit);
      });
    }

    // ── Pan / Zoom ──────────────────────────────────────────────────────────
    let tx = 0, ty = 0, sc = 1;
    const vp     = document.getElementById('vp');
    const canvas = document.getElementById('canvas');

    function applyT() {
      // Pixel-align translation to avoid persistent text blur on transformed layers.
      const dpr = window.devicePixelRatio || 1;
      const alignedTx = Math.round(tx * dpr) / dpr;
      const alignedTy = Math.round(ty * dpr) / dpr;
      canvas.style.transform = 'translate3d(' + alignedTx + 'px,' + alignedTy + 'px,0) scale(' + sc + ')';
    }

    function fit() {
      const vpW = vp.clientWidth, vpH = vp.clientHeight;
      const cw = parseFloat(canvas.style.width)  || vpW;
      const ch = parseFloat(canvas.style.height) || vpH;
      sc = Math.min(vpW / cw, vpH / ch, 1) * 0.88;
      tx = (vpW - cw * sc) / 2;
      ty = (vpH - ch * sc) / 2;
      applyT();
    }

    // Zoom tuning: larger steps for faster interaction in shared web view.
    const WHEEL_ZOOM_SENSITIVITY = 0.0032;
    const BUTTON_ZOOM_IN_FACTOR = 1.5;
    const BUTTON_ZOOM_OUT_FACTOR = 1 / BUTTON_ZOOM_IN_FACTOR;
    const PINCH_ZOOM_EXPONENT = 1.15;

    // factor > 1 = zoom in, factor < 1 = zoom out
    function zoomAt(mx, my, factor) {
      const newSc = Math.min(Math.max(sc * factor, 0.1), 3);
      tx = mx - (mx - tx) * (newSc / sc);
      ty = my - (my - ty) * (newSc / sc);
      sc = newSc;
      applyT();
    }

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      // Multiplicative zoom — feels consistent at every zoom level
      const factor = Math.pow(2, -e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }, { passive: false });

    let drag = null;
    vp.addEventListener('mousedown', e => {
      if (e.target.closest('.node') || e.target.closest('.ctrl')) return;
      drag = { sx: e.clientX - tx, sy: e.clientY - ty };
      vp.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      tx = e.clientX - drag.sx;
      ty = e.clientY - drag.sy;
      applyT();
    });
    window.addEventListener('mouseup', () => { drag = null; vp.classList.remove('dragging'); });

    // Click on viewport background (not node) closes detail popup
    vp.addEventListener('click', e => {
      if (!e.target.closest('.node')) closeDetail();
    });

    let touches = null;
    vp.addEventListener('touchstart', e => { touches = e.touches; }, { passive: true });
    vp.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && touches && touches.length === 1) {
        tx += e.touches[0].clientX - touches[0].clientX;
        ty += e.touches[0].clientY - touches[0].clientY;
        applyT();
      } else if (e.touches.length === 2 && touches && touches.length === 2) {
        const d0 = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
        const d1 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const r  = vp.getBoundingClientRect();
        if (d0 > 0) {
          const pinchFactor = Math.pow(d1 / d0, PINCH_ZOOM_EXPONENT);
          zoomAt(mx - r.left, my - r.top, pinchFactor);
        }
      }
      touches = e.touches;
    }, { passive: false });
    vp.addEventListener('touchend', () => { touches = null; });

    document.getElementById('btn-zi').onclick  = () => zoomAt(vp.clientWidth/2, vp.clientHeight/2, BUTTON_ZOOM_IN_FACTOR);
    document.getElementById('btn-zo').onclick  = () => zoomAt(vp.clientWidth/2, vp.clientHeight/2, BUTTON_ZOOM_OUT_FACTOR);
    document.getElementById('btn-fit').onclick = fit;

    render();
  })();
  </script>
  <div style="position:fixed;bottom:10px;left:50%;transform:translateX(-50%);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#999;pointer-events:auto;">
    Visualized with <a href="https://github.com/RahulThennarasu/fere" target="_blank" rel="noopener" style="color:#777;text-decoration:none;font-weight:500;">Fere</a> — service map for local dev
  </div>
</body>
</html>`;
}

module.exports = { generateHTML };
