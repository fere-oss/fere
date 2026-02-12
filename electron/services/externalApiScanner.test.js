const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanExternalApis, shouldSkipExternalApiProjectPath } = require('./externalApiScanner');

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fere-external-apis-'));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

test('scanExternalApis filters test/private/placeholder hosts and keeps real provider matches', async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'src', 'app.ts'),
      [
        "import OpenAI from 'openai';",
        "const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });",
        "fetch('https://api.github.com/user');",
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'src', 'network.ts'),
      [
        "fetch('http://10.0.0.1:8080')",
        "fetch('http://192.168.1.1')",
        "fetch('https://api.example.com/v1')",
        "fetch('https://${forwardedhost}${next}')",
        "fetch('https://$%7Bforwardedhost%7D$%7Bnext%7D')",
        "fetch('https://fonts.googleapis.com/css2?family=JetBrains+Mono')",
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'tests', 'fixture.test.ts'),
      [
        "const PLACEHOLDER = 'https://api.example.com';",
        "const PRIVATE = 'http://10.0.0.1';",
        'const TOKEN = process.env.GITHUB_TOKEN;',
      ].join('\n')
    );

    const apis = await scanExternalApis(projectDir);
    const names = apis.map(api => api.name);

    assert.ok(names.includes('OpenAI'), 'expected OpenAI provider to be detected');
    assert.ok(names.includes('GitHub'), 'expected GitHub provider to be detected');

    assert.ok(!names.includes('10.0.0.1'), 'private IP should not appear as external API');
    assert.ok(!names.includes('192.168.1.1'), 'private IP should not appear as external API');
    assert.ok(!names.includes('api.example.com'), 'placeholder host should be ignored');
    assert.ok(!names.includes('example.com'), 'placeholder host should be ignored');
    assert.ok(!names.includes('${forwardedhost}${next}'), 'templated host should be ignored');
    assert.ok(!names.includes('$%7bforwardedhost%7d$%7bnext%7d'), 'encoded templated host should be ignored');
    assert.ok(!names.includes('fonts.googleapis.com'), 'font host should be ignored');
    assert.ok(!names.includes('Google Gemini'), 'generic googleapis false positives should not be inferred from fonts');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('shouldSkipExternalApiProjectPath ignores system package-manager roots', () => {
  assert.equal(shouldSkipExternalApiProjectPath('/opt/homebrew'), true);
  assert.equal(shouldSkipExternalApiProjectPath('/opt/homebrew/Cellar/postgresql@15/15.4'), true);
  assert.equal(shouldSkipExternalApiProjectPath('/usr/local/Cellar/node/22.0.0'), true);
  assert.equal(shouldSkipExternalApiProjectPath('/Users/test/my-app'), false);
});

test('scanExternalApis drops env-only provider matches to reduce false positives', async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, '.env'),
      [
        'ALGOLIA_API_KEY=demo-key',
      ].join('\n')
    );

    const apis = await scanExternalApis(projectDir);
    const names = apis.map(api => api.name.toLowerCase());
    assert.ok(!names.includes('algolia'), 'env-only provider should be filtered out');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('scanExternalApis drops sdk-only provider mentions without env/domain evidence', async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'src', 'labels.ts'),
      [
        "export const labels = ['Algolia', 'Cloudflare', 'Deepgram'];",
      ].join('\n')
    );

    const apis = await scanExternalApis(projectDir);
    const names = apis.map(api => api.name.toLowerCase());
    assert.ok(!names.includes('algolia'), 'sdk-only mention should be filtered out');
    assert.ok(!names.includes('cloudflare'), 'sdk-only mention should be filtered out');
    assert.ok(!names.includes('deepgram'), 'sdk-only mention should be filtered out');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
