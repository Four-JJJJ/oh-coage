const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const generatePath = path.join(repoRoot, 'skills', 'oh-coage', 'scripts', 'generate.js');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

// generate.js 只在 OH_COAGE_TEST=1 时导出内部函数，且不会自动执行 main()
process.env.OH_COAGE_TEST = '1';
const generate = require(generatePath);

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-resilience-'));
}

function startServer(handler) {
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runGenerate(args, home) {
  return new Promise((resolve) => {
    // 必须摘掉 OH_COAGE_TEST，否则子进程会走测试导出分支而不执行 main()
    const env = { ...process.env, HOME: home };
    delete env.OH_COAGE_TEST;

    const child = spawn(process.execPath, [generatePath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('saveImage follows redirects and corrects the extension from the response content-type', async (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const pngBytes = Buffer.from(PNG_BASE64, 'base64');
  const requested = [];

  const server = await startServer((req, res) => {
    requested.push(req.url);

    if (req.url === '/redirect.jpg') {
      res.writeHead(302, { location: '/nested/real-image' });
      res.end();
      return;
    }
    if (req.url === '/nested/real-image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(pngBytes);
      return;
    }

    res.writeHead(404);
    res.end();
  });
  t.after(server.close);

  const savedPath = await generate.saveImage({ imageUrl: `${server.origin}/redirect.jpg` }, null, tempDir);

  assert.deepEqual(requested, ['/redirect.jpg', '/nested/real-image'], '应该跟随 302 到真实地址');
  assert.ok(savedPath.endsWith('.png'), `扩展名应按 content-type 纠正，实际: ${savedPath}`);
  assert.deepEqual(fs.readFileSync(savedPath), pngBytes);
  assert.equal(fs.existsSync(savedPath.replace(/\.png$/, '.jpg')), false, '不应残留猜错扩展名的文件');
});

test('downloadToFile removes the partial file instead of leaving a broken image', async (t) => {
  const tempDir = createTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '999999' });
    res.write(Buffer.from(PNG_BASE64, 'base64'));
    res.destroy();
  });
  t.after(server.close);

  const target = path.join(tempDir, 'partial.png');
  await assert.rejects(() => generate.downloadToFile(`${server.origin}/broken`, target));
  assert.equal(fs.existsSync(target), false, '失败后不应留下残缺文件');
});

test('pollTask retries transient query failures instead of failing the whole task', async () => {
  const waits = [];
  const responses = [
    new Error('HTTP 503: upstream busy'),
    new Error('Request timed out after 20000ms'),
    { data: { status: 'completed', result: { images: [{ b64_json: 'done' }] } } },
  ];

  const image = await generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
    now: () => 0,
    request: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.deepEqual(image, { imageUrl: undefined, base64: 'done' });
  assert.deepEqual(waits, generate.POLL_DELAYS_MS.slice(0, 2));
});

test('pollTask fails fast on an unrecognizable task payload', async () => {
  await assert.rejects(
    () => generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
      now: () => 0,
      request: async () => ({ unexpected: true }),
      sleep: async () => { throw new Error('不该进入 sleep'); },
    }),
    /任务查询返回结构无法识别/,
  );
});

test('pollTask gives up after too many consecutive failures', async () => {
  let calls = 0;

  await assert.rejects(
    () => generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
      now: () => 0,
      request: async () => { calls += 1; throw new Error('HTTP 503: still down'); },
      sleep: async () => {},
    }),
    /HTTP 503/,
  );

  assert.equal(calls, generate.MAX_POLL_FAILURES + 1);
});

test('pollTask recognizes vendor-specific terminal statuses', async () => {
  for (const status of ['succeeded', 'DONE', 'Finished']) {
    const image = await generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
      now: () => 0,
      request: async () => ({ data: { status, result: { images: [{ b64_json: 'ok' }] } } }),
      sleep: async () => { throw new Error(`不该 sleep（status=${status}）`); },
    });

    assert.equal(image.base64, 'ok', `status=${status} 应被识别为完成`);
  }
});

test('pollTask treats canceled/error as terminal failures instead of polling to timeout', async () => {
  await assert.rejects(
    () => generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
      now: () => 0,
      request: async () => ({ data: { status: 'canceled' } }),
      sleep: async () => { throw new Error('不该 sleep'); },
    }),
    /任务失败（status=canceled）/,
  );
});

test('pollTask accepts a result delivered without any status field', async () => {
  const image = await generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
    now: () => 0,
    request: async () => ({ data: { url: 'https://cdn.example/a.png' } }),
    sleep: async () => { throw new Error('不该 sleep'); },
  });

  assert.equal(image.imageUrl, 'https://cdn.example/a.png');
});

test('classifyError honours the explicit fallback marker used by the Keychain path', () => {
  const error = new Error('无法从 Keychain 读取 key');
  error.fallback = true;
  error.kind = 'keychain';

  assert.deepEqual(generate.classifyError(error), {
    kind: 'keychain',
    statusCode: null,
    retryable: false,
    fallback: true,
  });
});

test('truncateForLog keeps oversized error bodies out of the run log', () => {
  const long = 'x'.repeat(5000);
  const truncated = generate.truncateForLog(long);

  assert.ok(truncated.length < long.length);
  assert.match(truncated, /已截断，原始 5000 字符/);
  assert.equal(generate.truncateForLog('short'), 'short');
});

test('inferExtensionFromUrl ignores query strings and normalizes jpeg', () => {
  assert.equal(generate.inferExtensionFromUrl('https://cdn.example/a/b.JPEG?token=1'), '.jpg');
  assert.equal(generate.inferExtensionFromUrl('https://cdn.example/a/b.webp'), '.webp');
  assert.equal(generate.inferExtensionFromUrl('https://cdn.example/no-extension'), null);
  assert.equal(generate.inferExtensionFromUrl('not a url'), null);
});

test('a transient 5xx is retried on the same profile before giving up', async (t) => {
  const tempDir = createTempDir();
  const home = createTempDir();
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  let attempts = 0;
  const server = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      attempts += 1;

      if (attempts === 1) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream exploded' }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
  t.after(server.close);

  const result = await runGenerate([
    '--prompt', 'a red apple',
    '--api-key', 'test-key',
    '--base-url', server.baseUrl,
    '--out-dir', tempDir,
    '--no-fallback',
  ], home);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(attempts, 2, '第一次 502 后应在同一 profile 上重试');
  assert.match(result.stderr, /遇到 upstream 502/);
  assert.ok(result.stdout.trim().startsWith(tempDir), result.stdout);
});

test('a profile whose Keychain entry is missing falls back instead of aborting the run', async (t) => {
  const home = createTempDir();
  const configDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const configPath = path.join(configDir, 'oh-coage-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    active_profile: 'alpha',
    profiles: {
      alpha: {
        base_url: 'https://image.invalid/v1',
        root_output_dir: configDir,
        keychain_account: `alpha:missing-${suffix}`,
      },
      beta: {
        base_url: 'https://image.invalid/v1',
        root_output_dir: configDir,
        keychain_account: `beta:missing-${suffix}`,
      },
    },
  }, null, 2));

  fs.mkdirSync(path.join(home, '.oh-coage'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.oh-coage', 'state.json'),
    JSON.stringify({ config_path: configPath }),
  );

  const result = await runGenerate(['--prompt', 'hello'], home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /keychain/i);
  assert.match(result.stderr, /切换到下一个 profile/, '第一个 profile 失败后应该切到下一个，而不是整轮退出');
  assert.doesNotMatch(result.stderr, /TypeError/);

  const runs = fs.readFileSync(path.join(home, '.oh-coage', 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].attempts.length, 2, '两个 profile 都应该被尝试过');
});

test('an unsupported base_url protocol is rejected with a clear message', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = await runGenerate([
    '--prompt', 'a red apple',
    '--api-key', 'test-key',
    '--base-url', 'ftp://example.com/v1',
  ], home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /仅支持 http\/https/);
});
