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

function getNodeLogoUrl(name, containerImage, token) {
  const candidates = [name, containerImage].filter(Boolean);
  for (const s of candidates) {
    const k = String(s).toLowerCase().trim();
    if (k.startsWith('/') || k.startsWith('~')) continue;
    let domain = NODE_BRAND_DOMAIN[k] || null;
    if (!domain) {
      for (const [lookup, d] of Object.entries(NODE_BRAND_DOMAIN)) {
        if (nodeBrandMatch(k, lookup)) { domain = d; break; }
      }
    }
    if (domain) {
      let url = 'https://img.logo.dev/' + domain + '?size=64&format=png&fallback=monogram';
      if (token) url += '&token=' + token;
      return url;
    }
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

  // Keep only edges between non-external nodes
  const cleanNodeIds = new Set(cleanNodes.map(n => n.id));
  const cleanEdges = edges
    .filter(e => cleanNodeIds.has(e.source) && cleanNodeIds.has(e.target))
    .map(e => ({ id: e.id, source: e.source, target: e.target, sourcePort: e.sourcePort || null, targetPort: e.targetPort || null }));

  // Pre-fetch brand logos as base64 so the exported HTML is fully self-contained
  // (htmlpreview.github.io blocks external image requests)
  const logosMap = {};
  await Promise.all(cleanNodes.map(async (n) => {
    const url = getNodeLogoUrl(n.name, n.containerImage, logoDevToken);
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
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: #f8f9fa;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
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
    #canvas { position: absolute; transform-origin: 0 0; will-change: transform; }

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
    .n-logo-row { display: flex; align-items: center; gap: 8px; }
    .n-logo { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; border-radius: 4px; }

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

    /* ── Detail sidebar (matches app NodeDetailContent panel) ── */
    #detail-backdrop { display: none; }

    #detail {
      position: fixed; top: 16px; bottom: 16px; right: 16px;
      width: 400px;
      background: #ffffff;
      border-radius: 16px;
      border: 1px solid #e5e5e5;
      box-shadow: 0 8px 40px rgba(0,0,0,0.12), 0 2px 12px rgba(0,0,0,0.06);
      transform: translateX(calc(100% + 32px));
      transition: transform 0.25s cubic-bezier(0.4,0,0.2,1);
      z-index: 50;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    #detail.open { transform: translateX(0); }

    .dp-top {
      display: flex; align-items: flex-start; justify-content: space-between;
      padding: 20px 16px 16px;
      border-bottom: 1px solid #e5e5e5;
      flex-shrink: 0;
      gap: 8px;
    }
    .dp-top-left { flex: 1; min-width: 0; }
    .dp-logo-name { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .dp-logo { width: 28px; height: 28px; object-fit: contain; flex-shrink: 0; border-radius: 6px; }
    .dp-name { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dp-badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 6px; font-family: 'SF Mono', Menlo, monospace; font-size: 11px; font-weight: 600; }
    .dp-close {
      background: none; border: none; cursor: pointer;
      color: #a3a3a3; font-size: 20px; padding: 2px 4px;
      border-radius: 4px; line-height: 1; flex-shrink: 0;
      transition: color 0.12s;
    }
    .dp-close:hover { color: #0a0a0a; }

    .dp-body { flex: 1; overflow-y: auto; padding: 16px; }
    .dp-section { margin-bottom: 20px; }
    .dp-stitle {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.08em; color: #a3a3a3; margin-bottom: 10px;
      display: flex; align-items: center; gap: 6px;
    }
    .dp-count {
      background: #f5f5f5; border-radius: 4px; padding: 1px 6px;
      font-size: 10px; font-weight: 600; color: #737373;
    }
    .dp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .dp-item { display: flex; flex-direction: column; gap: 3px; }
    .dp-item.full { grid-column: 1 / -1; }
    .dp-label { font-size: 10px; color: #a3a3a3; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
    .dp-value { font-size: 13px; color: #171717; font-weight: 500; }
    .dp-value.mono { font-family: 'SF Mono', Menlo, monospace; }
    .dp-value.small { font-size: 11px; word-break: break-all; }

    .dp-health { display: flex; align-items: center; gap: 8px; }
    .dp-health-label { font-size: 13px; font-weight: 600; }

    .dp-command {
      font-family: 'SF Mono', Menlo, monospace; font-size: 11px;
      color: #525252; background: #f8f9fa; border: 1px solid #e5e5e5;
      border-radius: 6px; padding: 8px 10px; word-break: break-all;
    }

    .dp-ports { display: flex; flex-direction: column; gap: 6px; }
    .dp-port { display: flex; align-items: center; gap: 8px; }
    .dp-port-num { font-family: 'SF Mono', Menlo, monospace; font-size: 15px; font-weight: 600; }
    .dp-port-host { font-size: 12px; color: #a3a3a3; }
    .dp-port-desc { font-size: 11px; color: #737373; }

    .dp-routes { display: flex; flex-direction: column; gap: 6px; }
    .dp-route { display: flex; align-items: center; gap: 8px; font-family: 'SF Mono', Menlo, monospace; font-size: 11px; }
    .dp-route-path { color: #525252; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

    .dp-conn-group { margin-bottom: 12px; }
    .dp-conn-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #a3a3a3; display: block; margin-bottom: 6px; }
    .dp-conn { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 5px 0; border-bottom: 1px solid #f5f5f5; }
    .dp-conn-arrow { color: #a3a3a3; }
    .dp-conn-node { color: #171717; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dp-conn-ports { font-family: 'SF Mono', Menlo, monospace; font-size: 10px; color: #a3a3a3; white-space: nowrap; }

    /* ── Controls ── */
    .ctrl {
      position: fixed; top: 12px; right: 12px; display: flex; flex-direction: column;
      gap: 4px; z-index: 20; transition: right 0.25s cubic-bezier(0.4,0,0.2,1);
    }
    body.detail-open .ctrl { right: 428px; }
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
      <div class="dp-top">
        <div class="dp-top-left" id="dp-top-left"></div>
        <button class="dp-close" id="dp-close" title="Close">&#x2715;</button>
      </div>
      <div class="dp-body" id="dp-body"></div>
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
    const LOGO_TOKEN = '${logoDevToken.replace(/'/g, '')}';

    // ── Constants (from constants.ts) ────────────────────────────────────
    const SC = {
      frontend:'#0078D4', backend:'#0078D4', webserver:'#0078D4',
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
    function extractDomain(v) { const m = v.match(/([a-z0-9.-]+\.[a-z]{2,})/i); return m ? m[1].toLowerCase() : null; }

    function getLogoUrl(name, containerImage) {
      const candidates = [name, containerImage].filter(Boolean);
      for (const s of candidates) {
        const k = String(s).toLowerCase().trim();
        if (k.startsWith('/') || k.startsWith('~')) continue;
        if (BRAND_DOMAIN[k]) return logoDevUrl(BRAND_DOMAIN[k]);
        for (const [lookup, domain] of Object.entries(BRAND_DOMAIN)) {
          if (matchBrand(k, lookup)) return logoDevUrl(domain);
        }
        const extracted = extractDomain(k);
        if (extracted && isHostLike(extracted) && !isRevDns(extracted)) return logoDevUrl(extracted);
        if (isHostLike(k) && !isRevDns(k)) return logoDevUrl(k);
        if (k.length <= 80) return logoDevNameUrl(k);
      }
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

      let maxRowW = 0;
      sortedLayerNums.forEach(layerNum => {
        const ln = nodesByLayer.get(layerNum) || [];
        const rowW = ln.length * NW + (ln.length - 1) * GAP_H;
        maxRowW = Math.max(maxRowW, rowW);
      });

      if (standalone.length > 0) {
        const MAX_COLS = 4;
        const cols = Math.min(standalone.length, MAX_COLS);
        maxRowW = Math.max(maxRowW, cols * NW + (cols - 1) * GAP_H);
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

      // Standalone section — flat grid sorted by type priority (matches app service map view)
      if (standalone.length > 0) {
        const STANDALONE_GAP = 60;
        const MAX_COLS = 4;
        curY += STANDALONE_GAP;

        labelInfos.push({ text: 'Standalone Services', cx, y: curY, isStandalone: true });
        curY += LABEL_H + LABEL_GAP;

        // Sort by type priority then name (matches app ordering)
        const sortedStandalone = [...standalone].sort((a, b) => {
          const pd = typePriority(a.type) - typePriority(b.type);
          return pd !== 0 ? pd : a.name.localeCompare(b.name);
        });

        const cols   = Math.min(sortedStandalone.length, MAX_COLS);
        const rowW   = cols * NW + (cols - 1) * GAP_H;
        const startX = cx - rowW / 2;
        sortedStandalone.forEach((n, i) => {
          const col = i % MAX_COLS;
          const row = Math.floor(i / MAX_COLS);
          pos[n.id] = { x: startX + col * (NW + GAP_H), y: curY + row * (NHB + 40) };
        });

        const numRows = Math.ceil(sortedStandalone.length / MAX_COLS);
        curY += numRows * NHB + (numRows - 1) * 40;
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
      const logoUrl = (D.logos && D.logos[n.id]) || getLogoUrl(n.name, n.containerImage);

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

      // Name row (with optional logo)
      if (logoUrl) {
        html += '<div class="n-logo-row">';
        html += '<img class="n-logo" src="' + esc(logoUrl) + '" onerror="this.style.display=\\'none\\'" loading="lazy" />';
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
    const dpTopLeft  = document.getElementById('dp-top-left');
    const dpBody     = document.getElementById('dp-body');
    const dpClose    = document.getElementById('dp-close');

    function openDetail(n, allEdges, nodesMap) {
      const color  = SC[n.type] || '#6B7280';
      const hColor = HC[n.healthStatus] || HC.yellow;
      const hLabel = HL[n.healthStatus] || 'Idle';
      const hGlow  = HG[n.healthStatus] || HG.yellow;
      const logoUrl = (D.logos && D.logos[n.id]) || getLogoUrl(n.name, n.containerImage);

      // Header
      let hdrHtml = '<div class="dp-logo-name">';
      if (logoUrl) hdrHtml += '<img class="dp-logo" src="' + esc(logoUrl) + '" onerror="this.style.display=\\'none\\'" loading="lazy" />';
      hdrHtml += '<div class="dp-name" title="' + esc(n.name) + '">' + esc(n.name) + '</div>';
      hdrHtml += '</div>';
      hdrHtml += '<span class="dp-badge" style="background:' + color + '15;color:' + color + '">' + esc(SL[n.type] || 'Service') + '</span>';
      dpTopLeft.innerHTML = hdrHtml;

      // Body
      let html = '';

      // Health
      html += '<div class="dp-section">';
      html += '<div class="dp-stitle">Health</div>';
      html += '<div class="dp-health">';
      html += '<div class="n-dot" style="background:' + hColor + ';box-shadow:' + hGlow + '"></div>';
      html += '<span class="dp-health-label" style="color:' + hColor + '">' + hLabel + '</span>';
      html += '</div></div>';

      // Process / Container info
      if (!n.isDocker) {
        html += '<div class="dp-section"><div class="dp-stitle">Process</div>';
        html += '<div class="dp-grid">';
        if (n.pid)    html += '<div class="dp-item"><span class="dp-label">PID</span><span class="dp-value mono">' + esc(String(n.pid)) + '</span></div>';
        if (n.user)   html += '<div class="dp-item"><span class="dp-label">User</span><span class="dp-value">' + esc(n.user) + '</span></div>';
        html += '<div class="dp-item"><span class="dp-label">CPU</span><span class="dp-value mono">' + esc((n.cpu||0).toFixed(1)) + '%</span></div>';
        html += '<div class="dp-item"><span class="dp-label">Memory</span><span class="dp-value mono">' + esc((n.memory||0).toFixed(1)) + '%</span></div>';
        html += '</div></div>';
      } else {
        html += '<div class="dp-section"><div class="dp-stitle">Container</div>';
        html += '<div class="dp-grid">';
        if (n.containerId)    html += '<div class="dp-item"><span class="dp-label">ID</span><span class="dp-value mono">' + esc(n.containerId.substring(0, 12)) + '</span></div>';
        if (n.containerState) html += '<div class="dp-item"><span class="dp-label">State</span><span class="dp-value">' + esc(n.containerState) + '</span></div>';
        html += '<div class="dp-item"><span class="dp-label">CPU</span><span class="dp-value mono">' + esc((n.cpu||0).toFixed(1)) + '%</span></div>';
        html += '<div class="dp-item"><span class="dp-label">Memory</span><span class="dp-value mono">' + esc(n.memoryUsage || ((n.memory||0).toFixed(1) + '%')) + '</span></div>';
        html += '</div>';
        if (n.containerImage) html += '<div class="dp-item full" style="margin-top:8px"><span class="dp-label">Image</span><span class="dp-value mono small">' + esc(n.containerImage) + '</span></div>';
        html += '</div>';
      }

      // Command
      if (n.command) {
        html += '<div class="dp-section"><div class="dp-stitle">Command</div>';
        html += '<div class="dp-command">' + esc(n.command) + '</div></div>';
      }

      // Project
      if (n.project || n.projectPath) {
        html += '<div class="dp-section"><div class="dp-stitle">Project</div>';
        html += '<div class="dp-grid">';
        if (n.project)     html += '<div class="dp-item full"><span class="dp-label">Name</span><span class="dp-value">' + esc(n.project) + '</span></div>';
        if (n.projectPath) html += '<div class="dp-item full"><span class="dp-label">Path</span><span class="dp-value mono small">' + esc(n.projectPath) + '</span></div>';
        html += '</div></div>';
      }

      // Ports (all)
      if (n.ports && n.ports.length > 0) {
        html += '<div class="dp-section"><div class="dp-stitle">Ports <span class="dp-count">' + n.ports.length + '</span></div>';
        html += '<div class="dp-ports">';
        n.ports.forEach(p => {
          const portNum = p.port || p;
          html += '<div class="dp-port">';
          html += '<span class="dp-port-num" style="color:' + color + '">:' + esc(String(portNum)) + '</span>';
          if (p.host) html += '<span class="dp-port-host">' + esc(p.host) + '</span>';
          if (p.description) html += '<span class="dp-port-desc">' + esc(p.description) + '</span>';
          html += '</div>';
        });
        html += '</div></div>';
      }

      // API Routes (all)
      if (n.routes && n.routes.length > 0) {
        html += '<div class="dp-section"><div class="dp-stitle">API Routes <span class="dp-count">' + n.routes.length + '</span></div>';
        html += '<div class="dp-routes">';
        n.routes.forEach(r => {
          const m = r.method.toUpperCase();
          html += '<div class="dp-route"><span class="n-method ' + esc(m) + '">' + esc(m) + '</span><span class="dp-route-path">' + esc(r.path) + '</span></div>';
        });
        html += '</div></div>';
      }

      // Connections
      const incoming = allEdges.filter(e => e.target === n.id);
      const outgoing = allEdges.filter(e => e.source === n.id);
      if (incoming.length > 0 || outgoing.length > 0) {
        html += '<div class="dp-section"><div class="dp-stitle">Connections</div>';
        if (incoming.length > 0) {
          html += '<div class="dp-conn-group"><span class="dp-conn-label">Incoming</span>';
          incoming.forEach(e => {
            const srcName = nodesMap.get(e.source)?.name || e.source;
            html += '<div class="dp-conn"><span class="dp-conn-arrow">←</span><span class="dp-conn-node">' + esc(srcName) + '</span>';
            if (e.sourcePort || e.targetPort) html += '<span class="dp-conn-ports">:' + esc(String(e.sourcePort||'')) + '→:' + esc(String(e.targetPort||'')) + '</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        if (outgoing.length > 0) {
          html += '<div class="dp-conn-group"><span class="dp-conn-label">Outgoing</span>';
          outgoing.forEach(e => {
            const tgtName = nodesMap.get(e.target)?.name || e.target;
            html += '<div class="dp-conn"><span class="dp-conn-arrow">→</span><span class="dp-conn-node">' + esc(tgtName) + '</span>';
            if (e.sourcePort || e.targetPort) html += '<span class="dp-conn-ports">:' + esc(String(e.sourcePort||'')) + '→:' + esc(String(e.targetPort||'')) + '</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      }

      dpBody.innerHTML = html;
      dpBody.scrollTop = 0;
      detailEl.classList.add('open');
      document.body.classList.add('detail-open');
    }

    function closeDetail() {
      detailEl.classList.remove('open');
      document.body.classList.remove('detail-open');
    }

    dpClose.addEventListener('click', closeDetail);

    // ── Render ────────────────────────────────────────────────────────────
    function render() {
      const { nodes, edges } = D;
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
        lbl.className = 'group-label';
        lbl.textContent = gi.label;
        lbl.style.left = (gi.x + 14) + 'px';
        lbl.style.top  = (gi.y + 10) + 'px';
        lbl.style.setProperty('--gc', gi.color);
        grpCont.appendChild(lbl);
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

      // After nodes are in DOM, measure actual heights then draw edges
      requestAnimationFrame(() => {
        const heights = {};
        for (const id in nodeEls) heights[id] = nodeEls[id].offsetHeight || NHB;

        // Update group box heights to match actual measured node heights
        const grpEls = grpCont.querySelectorAll('.group-box');
        groupInfos.forEach((gi, i) => {
          const box = grpEls[i];
          if (!box) return;
          let maxH = NHB;
          gi.nodeIds.forEach(id => { maxH = Math.max(maxH, heights[id] || NHB); });
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
      canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + sc + ')';
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
      const factor = Math.pow(2, -e.deltaY * 0.0018);
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
        if (d0 > 0) zoomAt(mx - r.left, my - r.top, d1 / d0);
      }
      touches = e.touches;
    }, { passive: false });
    vp.addEventListener('touchend', () => { touches = null; });

    document.getElementById('btn-zi').onclick  = () => zoomAt(vp.clientWidth/2, vp.clientHeight/2, 1.25);
    document.getElementById('btn-zo').onclick  = () => zoomAt(vp.clientWidth/2, vp.clientHeight/2, 0.8);
    document.getElementById('btn-fit').onclick = fit;

    render();
  })();
  </script>
</body>
</html>`;
}

module.exports = { generateHTML };
