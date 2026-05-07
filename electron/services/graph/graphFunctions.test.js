const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferProjectPathFromContainer,
  parseSshConfigText,
  resolveSshAliasWithMap,
} = require("./graphFunctions");

test("inferProjectPathFromContainer prefers compose working_dir for subproject grouping", () => {
  const container = {
    labels: {
      "com.docker.compose.project.working_dir": "/Users/me/Documents/GitHub/fere/test/docker-test",
    },
    mounts: [
      {
        type: "bind",
        source: "/Users/me/Documents/GitHub/fere/test/docker-test/services/order-service",
      },
    ],
  };

  const projectPath = inferProjectPathFromContainer(container);
  assert.equal(projectPath, "/Users/me/Documents/GitHub/fere/test/docker-test");
});

test("parseSshConfigText extracts host aliases", () => {
  const config = `
Host devbox
  HostName 10.0.0.42
  User dev
  Port 2222

Host staging
  HostName staging.example.com
`;

  const aliases = parseSshConfigText(config);
  const devbox = aliases.get("devbox");
  const staging = aliases.get("staging");

  assert.ok(devbox);
  assert.equal(devbox.hostname, "10.0.0.42");
  assert.equal(devbox.user, "dev");
  assert.equal(devbox.port, 2222);

  assert.ok(staging);
  assert.equal(staging.hostname, "staging.example.com");
});

test("resolveSshAliasWithMap resolves alias to concrete host metadata", () => {
  const aliases = parseSshConfigText(`
Host prod-db
  HostName db.internal.example
  User postgres
  Port 2222
`);

  const resolved = resolveSshAliasWithMap("prod-db", aliases);
  assert.equal(resolved.alias, "prod-db");
  assert.equal(resolved.host, "db.internal.example");
  assert.equal(resolved.user, "postgres");
  assert.equal(resolved.port, 2222);
});
