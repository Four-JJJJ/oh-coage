const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const generatePath = path.join(repoRoot, 'scripts', 'generate.js');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-test-'));
}

function writeTinyPng(filePath) {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  fs.writeFileSync(filePath, Buffer.from(pngBase64, 'base64'));
  return pngBase64;
}

function startServer(handler) {
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function readRequestJson(req) {
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

function runGenerate(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [generatePath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: createTempDir(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('generate uploads local image-url paths as base64 data URIs', async (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const inputPath = path.join(tempDir, 'input.png');
  const expectedBase64 = writeTinyPng(inputPath);
  const outputPath = path.join(tempDir, 'output.png');
  let receivedBody = null;

  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      receivedBody = await readRequestJson(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: expectedBase64 }] }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
  t.after(server.close);

  const result = await runGenerate([
    '--prompt', 'turn this into watercolor',
    '--image-url', inputPath,
    '--api-key', 'test-key',
    '--base-url', server.baseUrl,
    '--output', outputPath,
    '--no-fallback',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), outputPath);
  assert.deepEqual(receivedBody.image_urls, [`data:image/png;base64,${expectedBase64}`]);
});

test('generate reports a clear error for missing local image-url paths', async (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const missingPath = path.join(tempDir, 'missing.png');
  const result = await runGenerate([
    '--prompt', 'turn this into watercolor',
    '--image-url', missingPath,
    '--api-key', 'test-key',
    '--base-url', 'http://127.0.0.1:9/v1',
    '--no-fallback',
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /参考图片不存在/);
  assert.match(result.stderr, new RegExp(missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
