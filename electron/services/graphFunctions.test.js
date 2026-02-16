const test = require('node:test');
const assert = require('node:assert/strict');

const { inferProjectPathFromContainer } = require('./graphFunctions');

test('inferProjectPathFromContainer prefers compose working_dir for subproject grouping', () => {
  const container = {
    labels: {
      'com.docker.compose.project.working_dir': '/Users/me/Documents/GitHub/fere/test/docker-test',
    },
    mounts: [
      {
        type: 'bind',
        source: '/Users/me/Documents/GitHub/fere/test/docker-test/services/order-service',
      },
    ],
  };

  const projectPath = inferProjectPathFromContainer(container);
  assert.equal(projectPath, '/Users/me/Documents/GitHub/fere/test/docker-test');
});
