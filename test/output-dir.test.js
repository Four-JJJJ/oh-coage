const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDefaultOutputDir } = require('../scripts/resolve-output-dir');

test('default output directory resolves to the current project root', () => {
  const projectDir = path.resolve(__dirname, '..');
  assert.equal(resolveDefaultOutputDir(projectDir), projectDir);
});
