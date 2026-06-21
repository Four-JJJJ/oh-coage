const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadConfigFromPath, resolveProfileOutputDir } = require('../scripts/config-store');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-config-test-'));
}

test('loadConfigFromPath resolves dot output dirs relative to the config file', (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const configPath = path.join(tempDir, 'oh-coage-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    active_profile: 'shared',
    profiles: {
      shared: {
        base_url: 'https://example.test/v1',
        root_output_dir: '.',
        keychain_account: 'shared:test',
      },
    },
  }, null, 2));

  const config = loadConfigFromPath(configPath);

  assert.equal(config.profiles.shared.root_output_dir, '.');
  assert.equal(config.profiles.shared.resolved_root_output_dir, tempDir);
  assert.equal(resolveProfileOutputDir(config.profiles.shared, configPath), tempDir);
});
