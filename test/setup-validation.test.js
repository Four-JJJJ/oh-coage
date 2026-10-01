const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const setupPath = path.join(repoRoot, 'skills', 'oh-coage', 'scripts', 'setup.js');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-setup-'));
}

function runSetup(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [setupPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// 这两条都在写入 Keychain 之前就被拦下，所以测试不会碰到真实钥匙串
test('setup rejects a base_url whose protocol is not http/https, before touching Keychain', async (t) => {
  const outputDir = createTempDir();
  const home = createTempDir();
  t.after(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const result = await runSetup([
    '--output-dir', outputDir,
    '--profile', 'default',
    '--base-url', 'ftp://example.com/v1',
    '--api-key', 'dummy-key',
    '--activate',
  ], home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /仅支持 http\/https/);
  assert.equal(
    fs.existsSync(path.join(outputDir, 'oh-coage-config.json')),
    false,
    '校验失败时不应写出配置文件',
  );
});

test('setup rejects a base_url that is not a valid URL', async (t) => {
  const outputDir = createTempDir();
  const home = createTempDir();
  t.after(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const result = await runSetup([
    '--output-dir', outputDir,
    '--profile', 'default',
    '--base-url', 'not-a-url',
    '--api-key', 'dummy-key',
  ], home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /不是合法 URL/);
  assert.equal(fs.existsSync(path.join(outputDir, 'oh-coage-config.json')), false);
});

test('setup --list reports an uninitialized install without crashing', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = await runSetup(['--list'], home);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /尚未初始化/);
});

test('uninstall keeps run logs by default and removes them with --purge-logs', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const appDir = path.join(home, '.oh-coage');
  const runsPath = path.join(appDir, 'runs.jsonl');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(runsPath, '{"status":"success"}\n');

  const kept = await runSetup(['--uninstall-skill'], home);
  assert.equal(kept.code, 0, kept.stderr);
  assert.ok(fs.existsSync(runsPath), '默认应保留运行日志');
  assert.match(kept.stdout, /运行日志: 保留/);

  const purged = await runSetup(['--uninstall-skill', '--purge-logs'], home);
  assert.equal(purged.code, 0, purged.stderr);
  assert.equal(fs.existsSync(runsPath), false, '--purge-logs 应删除运行日志');
});

test('the app directory is created with private permissions', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const configStorePath = path.join(repoRoot, 'skills', 'oh-coage', 'scripts', 'config-store.js');

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '-e',
      `require(${JSON.stringify(configStorePath)}).saveState({ config_path: null })`,
    ], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    child.on('close', resolve);
  });

  const mode = fs.statSync(path.join(home, '.oh-coage')).mode & 0o777;
  assert.equal(mode, 0o700, `运行日志目录应只有属主可访问，实际 ${mode.toString(8)}`);
});
