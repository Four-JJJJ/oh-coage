const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadConfigFromPath, saveConfig, writeJson, resolveProfileOutputDir } = require('../skills/oh-coage/scripts/config-store');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-config-test-'));
}

function writeRelativeConfig(configPath) {
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
}

test('loadConfigFromPath resolves dot output dirs relative to the config file', (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const configPath = path.join(tempDir, 'oh-coage-config.json');
  writeRelativeConfig(configPath);

  const config = loadConfigFromPath(configPath);

  assert.equal(config.profiles.shared.root_output_dir, '.');
  assert.equal(config.profiles.shared.resolved_root_output_dir, tempDir);
  assert.equal(resolveProfileOutputDir(config.profiles.shared, configPath), tempDir);
});

test('saveConfig never persists the derived resolved_root_output_dir', (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const configPath = path.join(tempDir, 'oh-coage-config.json');
  writeRelativeConfig(configPath);

  saveConfig(configPath, loadConfigFromPath(configPath));

  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(persisted.profiles.shared.resolved_root_output_dir, undefined);
  assert.equal(persisted.profiles.shared.root_output_dir, '.');
});

test('a config moved to another location re-resolves its relative output dir', (t) => {
  const sourceDir = createTempDir();
  const movedDir = createTempDir();
  t.after(() => {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(movedDir, { recursive: true, force: true });
  });

  const sourcePath = path.join(sourceDir, 'oh-coage-config.json');
  writeRelativeConfig(sourcePath);

  // 模拟「配置被同步/拷贝到另一台机器」：先经过一次 load→save（setup.js 每次操作都会走）
  saveConfig(sourcePath, loadConfigFromPath(sourcePath));

  const movedPath = path.join(movedDir, 'oh-coage-config.json');
  fs.copyFileSync(sourcePath, movedPath);

  const reloaded = loadConfigFromPath(movedPath);
  assert.equal(
    reloaded.profiles.shared.resolved_root_output_dir,
    movedDir,
    '移动后应该按新位置解析，而不是沿用旧机器上的绝对路径',
  );
});

test('writeJson leaves no temp file behind', (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const target = path.join(tempDir, 'nested', 'state.json');
  writeJson(target, { config_path: '/tmp/example' });

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { config_path: '/tmp/example' });
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});
