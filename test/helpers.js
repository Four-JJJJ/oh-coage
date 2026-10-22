/**
 * 测试公共工具。
 *
 * 抽出来的原因：createTempDir 在 7 个文件里各写一份，startServer 4 份，
 * createSecurityStub 5 份且已经漂移（签名不一致 → 漏传 stub 时没人发现，
 * 结果测试真的去查开发者本机的钥匙串）。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const skillScripts = path.join(repoRoot, 'skills', 'oh-coage', 'scripts');
const setupPath = path.join(skillScripts, 'setup.js');
const generatePath = path.join(skillScripts, 'generate.js');

// 1x1 透明 PNG，用于伪造「合法的图片响应」
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function tempDir(t, prefix = 'oh-coage-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 造一个假的 security 命令并排到 PATH 最前。
 * 测试因此既能跑完整 Keychain 流程，又不会碰真实钥匙串、不会弹授权窗。
 *
 * @param {object} t node:test 的测试上下文（用于自动清理）
 * @param {{missingKey?: boolean}} options missingKey=true 模拟「key 读不到」
 */
function securityStub(t, options = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-secstub-'));
  if (t) t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));

  const stubPath = path.join(binDir, 'security');
  const findLine = options.missingKey
    ? '  find-generic-password) echo "The specified item could not be found in the keychain." >&2; exit 44 ;;'
    : '  find-generic-password) echo "stub-api-key"; exit 0 ;;';

  fs.writeFileSync(stubPath, [
    '#!/bin/bash',
    'case "$1" in',
    findLine,
    '  add-generic-password) cat > /dev/null; exit 0 ;;',
    '  delete-generic-password) exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(stubPath, 0o755);

  return { binDir, env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } };
}

/** 起一个只监听 127.0.0.1 的假站点，端口随机。 */
function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        port,
        origin,
        baseUrl: `${origin}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * 跑一个脚本子进程。
 * home 必须显式给出——不提供默认临时目录，避免出现「泄漏 HOME 目录」的调用方式。
 */
function runNode(scriptPath, args, { home, env = {}, cwd = repoRoot } = {}) {
  if (!home) throw new Error('runNode 需要显式传入 home（临时 HOME 目录）');

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: { ...process.env, HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 把 state.json 指向给定的配置文件，模拟「已完成初始化」。 */
function writeState(home, configPath) {
  fs.mkdirSync(path.join(home, '.oh-coage'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.oh-coage', 'state.json'),
    JSON.stringify({ config_path: configPath }),
  );
}

/** 在 outputDir 下写一份配置，并让 home 指向它。 */
function writeConfig(home, config, outputDir) {
  const configPath = path.join(outputDir, 'oh-coage-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeState(home, configPath);
  return configPath;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function jsonResponse(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function pngResponse(res) {
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(Buffer.from(PNG_BASE64, 'base64'));
}

module.exports = {
  repoRoot,
  skillScripts,
  setupPath,
  generatePath,
  PNG_BASE64,
  tempDir,
  securityStub,
  startServer,
  runNode,
  writeState,
  writeConfig,
  readJsonBody,
  jsonResponse,
  pngResponse,
};
