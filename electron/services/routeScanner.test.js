const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanRoutes, matchRoutesToService } = require('./routeScanner');

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fere-routes-'));
  return dir;
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

test('scanRoutes tags frameworks and matchRoutesToService filters by project path and framework', async () => {
  const projectDir = makeTempProject();
  const externalDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'app.py'),
      [
        'from flask import Flask',
        'app = Flask(__name__)',
        '@app.route("/health", methods=["GET"])',
        'def health():',
        '    return "ok"',
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'server.js'),
      [
        "const express = require('express')",
        'const app = express()',
        "app.get('/api/items', (req, res) => res.send('ok'))",
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'app/api/users/route.ts'),
      [
        'export async function GET() {',
        '  return new Response("ok")',
        '}',
      ].join('\n')
    );

    writeFile(
      path.join(externalDir, 'external.js'),
      [
        "const express = require('express')",
        'const app = express()',
        "app.get('/outside', (req, res) => res.send('ok'))",
      ].join('\n')
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(routes.length >= 3, 'expected routes from multiple frameworks');
    assert.ok(routes.some(r => r.framework === 'flask'), 'expected flask routes');
    assert.ok(routes.some(r => r.framework === 'express'), 'expected express routes');
    assert.ok(routes.some(r => r.framework === 'nextjs'), 'expected nextjs routes');

    const externalRoutes = await scanRoutes(externalDir);
    const combined = routes.concat(externalRoutes);

    const flaskService = {
      projectPath: projectDir,
      command: 'python -m flask run',
      name: 'python',
    };
    const flaskRoutes = matchRoutesToService(combined, flaskService);
    assert.ok(flaskRoutes.every(r => r.path === '/health'), 'expected only flask routes');

    const expressService = {
      projectPath: projectDir,
      command: 'node server.js --express',
      name: 'node',
    };
    const expressRoutes = matchRoutesToService(combined, expressService);
    assert.ok(expressRoutes.every(r => r.path === '/api/items'), 'expected only express routes');

    const expressByFileService = {
      projectPath: projectDir,
      command: 'node server.js',
      name: 'node',
    };
    const expressByFileRoutes = matchRoutesToService(combined, expressByFileService);
    assert.ok(expressByFileRoutes.every(r => r.path === '/api/items'), 'expected routes to match by file name');

    const nextService = {
      projectPath: projectDir,
      command: 'next dev',
      name: 'node',
    };
    const nextRoutes = matchRoutesToService(combined, nextService);
    assert.ok(nextRoutes.every(r => r.path === '/api/users'), 'expected only nextjs routes');

    const noProjectService = {
      projectPath: null,
      command: 'python app.py',
      name: 'python',
    };
    const emptyRoutes = matchRoutesToService(combined, noProjectService);
    assert.equal(emptyRoutes.length, 0, 'expected no routes without projectPath');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});
