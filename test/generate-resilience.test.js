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

/**
 * 造一个「key 读不到」的 security stub。
 * 否则这个用例会去查开发者真实的登录钥匙串——虽然只读且不会弹窗，
 * 但一旦本机恰好存在同名记录，断言就会随机失败。
 */
function createMissingKeySecurityStub(t) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-nokey-'));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));

  const stubPath = path.join(binDir, 'security');
  fs.writeFileSync(stubPath, [
    '#!/bin/bash',
    'case "$1" in',
    '  find-generic-password) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44 ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(stubPath, 0o755);

  return { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } };
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

function runGenerate(args, home, extraEnv = {}) {
  return new Promise((resolve) => {
    // 必须摘掉 OH_COAGE_TEST，否则子进程会走测试导出分支而不执行 main()
    const env = { ...process.env, HOME: home, ...extraEnv };
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

  const images = await generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
    now: () => 0,
    request: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.deepEqual(images, [{ imageUrl: undefined, base64: 'done', mimeType: undefined }]);
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
    const images = await generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
      now: () => 0,
      request: async () => ({ data: { status, result: { images: [{ b64_json: 'ok' }] } } }),
      sleep: async () => { throw new Error(`不该 sleep（status=${status}）`); },
    });

    assert.equal(images[0].base64, 'ok', `status=${status} 应被识别为完成`);
  }
});

test('pollTask treats canceled/error as terminal failures instead of polling to timeout', async () => {
  await assert.rejects(
    () => generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
      now: () => 0,
      request: async () => ({ data: { status: 'canceled' } }),
      sleep: async () => { throw new Error('不该 sleep'); },
    }),
    /任务未完成（status=canceled）/,
  );
});

test('pollTask accepts a result delivered without any status field', async () => {
  const images = await generate.pollTask('test-key', 'https://image.example/v1', 'task-1', {
    now: () => 0,
    request: async () => ({ data: { url: 'https://cdn.example/a.png' } }),
    sleep: async () => { throw new Error('不该 sleep'); },
  });

  assert.equal(images[0].imageUrl, 'https://cdn.example/a.png');
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
    // Keychain 读不到 key 时请求根本没发出，换模型/换 profile 都不会重复计费
    resubmittable: true,
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

test('an uncertain 5xx is not resubmitted', async (t) => {
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
  ], home, { OH_COAGE_RETRY_DELAY_MS: '0' });

  assert.equal(result.code, 1, result.stderr);
  assert.equal(attempts, 1, '502 不能证明请求没有被计费');
  assert.match(result.stderr, /本次记录/);
  assert.doesNotMatch(result.stderr, /--resume/);
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
    current_model: 'image-2',
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

  const stub = createMissingKeySecurityStub(t);
  const result = await runGenerate(['--prompt', 'hello', '--allow-profile-fallback'], home, stub.env);

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

test('generate gives a clear error for a flag missing its value instead of a TypeError', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = await runGenerate(['--prompt', 'a red apple', '--image-url'], home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--image-url 缺少参数值/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test('generate warns that --api-key is visible in the process list', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = await runGenerate([
    '--prompt', 'a red apple',
    '--api-key', 'k',
    '--base-url', 'http://127.0.0.1:1/v1',
    '--out-dir', home,
    '--no-fallback',
  ], home, { OH_COAGE_RETRY_DELAY_MS: '0' });

  assert.match(result.stderr, /--api-key 的密钥会短暂出现在进程列表/);
  assert.match(result.stderr, /IMAGES2_GEN_API_KEY/);
});

test('isPrivateOrReservedHost flags loopback/private/metadata hosts', () => {
  for (const host of ['127.0.0.1', '127.8.8.8', '169.254.169.254', '10.0.0.5', '172.16.1.1', '172.31.255.255', '192.168.1.1', '0.0.0.0', 'localhost', '::1', 'fe80::1', 'fc00::1']) {
    assert.equal(generate.isPrivateOrReservedHost(host), true, `${host} 应被识别为本地/保留地址`);
  }

  for (const host of ['example.com', '8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '']) {
    assert.equal(generate.isPrivateOrReservedHost(host), false, `${host} 不应被误判为本地地址`);
  }
});

test('POST error classification distinguishes permissions, parameters and uncertain outcomes', () => {
  const classify = (message) => generate.classifyError(new Error(message), { idempotent: false });
  for (const message of ['HTTP 503: upstream', 'HTTP 408: timeout', 'socket hang up', 'Request timed out']) {
    assert.equal(classify(message).resubmittable, false, message);
    assert.equal(classify(message).fallback, false, message);
  }
  assert.equal(classify('HTTP 400: invalid size').fallback, false);
  assert.equal(classify('HTTP 404: route missing').fallback, false);
  assert.equal(classify('HTTP 400: model_not_found').kind, 'model');
  assert.equal(classify('HTTP 403: content_policy_violation').fallback, false);
  assert.equal(classify('HTTP 403: account disabled').fallback, false);
  assert.equal(classify('HTTP 403: no access to model').fallback, true);
  assert.equal(classify('HTTP 429: too many requests').retryable, true);
});

test('download recovery preserves partial images and resumes without another generation POST', async (t) => {
  const home = createTempDir();
  const output = createTempDir();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(output, { recursive: true, force: true }); });
  let posts = 0;
  let available = false;
  const server = await startServer((req, res) => {
    if (req.method === 'POST') {
      posts += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }, { url: `${server.origin}/second.png` }] }));
    } else if (available) {
      res.setHeader('content-type', 'image/png'); res.end(Buffer.from(PNG_BASE64, 'base64'));
    } else { res.writeHead(503); res.end('not ready'); }
  });
  t.after(server.close);
  const first = await runGenerate(['--prompt', 'two apples', '--api-key', 'test', '--base-url', server.baseUrl, '--out-dir', output, '--allow-profile-fallback'], home);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /可以继续下载，无需重新生成/);
  assert.match(first.stderr, /--resume/);
  assert.match(first.stderr, /已保存图片已保留/);
  const runDir = fs.readdirSync(output).map((name) => path.join(output, name)).find((entry) => fs.statSync(entry).isDirectory());
  const recordPath = path.join(runDir, fs.readdirSync(runDir).find((name) => name.startsWith('recovery-')));
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(record.images.length, 2);
  assert.ok(fs.existsSync(record.saved[0]));
  const firstStat = fs.statSync(record.saved[0]).mtimeMs;
  available = true;
  const resumed = await runGenerate(['--resume', recordPath, '--json'], home);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(posts, 1);
  assert.equal(JSON.parse(resumed.stdout).images.length, 2);
  assert.equal(fs.statSync(record.saved[0]).mtimeMs, firstStat);
  assert.equal(JSON.parse(fs.readFileSync(recordPath, 'utf8')).status, 'complete');
});

test('resume of an unknown submission never sends another request', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const recordPath = path.join(home, 'recovery.json');
  fs.writeFileSync(recordPath, JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:1/v1', runDir: home, images: [] }));
  const result = await runGenerate(['--resume', recordPath], home);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /提交结果未知且没有任务 ID/);
});

test('an unwritable output target fails before generation submission', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'not-a-directory');
  fs.writeFileSync(file, 'existing file');
  let posts = 0;
  const server = await startServer((req, res) => { posts += 1; res.end('{}'); });
  t.after(server.close);
  const result = await runGenerate(['--prompt', 'test', '--api-key', 'test', '--base-url', server.baseUrl, '--out-dir', file], home);
  assert.equal(result.code, 1);
  assert.equal(posts, 0);
});

test('submission budget bounds retries and model fallback together', async (t) => {
  const home = createTempDir();
  const output = createTempDir();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(output, { recursive: true, force: true }); });
  let posts = 0;
  const server = await startServer((req, res) => { posts += 1; res.writeHead(429); res.end('limited'); });
  t.after(server.close);
  const result = await runGenerate(['--prompt', 'apple', '--api-key', 'test', '--base-url', server.baseUrl, '--out-dir', output, '--max-submissions', '1'], home, { OH_COAGE_RETRY_DELAY_MS: '0' });
  assert.equal(result.code, 1);
  assert.equal(posts, 1);
  assert.match(result.stderr, /提交上限 1/);
});

test('resume polls an existing async task and never submits generation', async (t) => {
  const home = createTempDir();
  const output = createTempDir();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(output, { recursive: true, force: true }); });
  const { securityStub } = require('./helpers');
  const stub = securityStub(t);
  let posts = 0;
  let gets = 0;
  const server = await startServer((req, res) => {
    if (req.method === 'POST') { posts += 1; res.end('{}'); return; }
    gets += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { status: 'completed', result: { data: [{ b64_json: PNG_BASE64 }] } } }));
  });
  t.after(server.close);
  const configPath = path.join(output, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ active_profile: 'main', profiles: { main: { base_url: server.baseUrl, keychain_account: 'main:test' } } }));
  fs.mkdirSync(path.join(home, '.oh-coage'));
  fs.writeFileSync(path.join(home, '.oh-coage', 'state.json'), JSON.stringify({ config_path: configPath }));
  const recordPath = path.join(output, 'recovery.json');
  fs.writeFileSync(recordPath, JSON.stringify({ version: 1, profile: 'main', baseUrl: server.baseUrl, runDir: output, taskId: 'existing-123', images: [], saved: {} }));
  const result = await runGenerate(['--resume', recordPath, '--json'], home, stub.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posts, 0);
  assert.equal(gets, 1);
  assert.equal(JSON.parse(result.stdout).images.length, 1);
});

test('a response with fewer images retains results and reports partial without refilling', async (t) => {
  const home = createTempDir();
  const output = createTempDir();
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(output, { recursive: true, force: true }); });
  let posts = 0;
  const server = await startServer((req, res) => {
    posts += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
  });
  t.after(server.close);
  const result = await runGenerate(['--prompt', 'apples', '--api-key', 'test', '--base-url', server.baseUrl, '--out-dir', output, '--n', '3', '--json'], home);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'partial');
  assert.equal(payload.missing_count, 2);
  assert.equal(payload.received_count, 1);
  assert.ok(fs.existsSync(payload.images[0].path));
  assert.equal(posts, 1);
});

test('manual-key async recovery queries original task without requiring a saved profile', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let gets = 0;
  const server = await startServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer original-key');
    gets += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { status: 'completed', result: { data: [{ b64_json: PNG_BASE64 }] } } }));
  });
  t.after(server.close);
  const recordPath = path.join(home, 'recovery.json');
  fs.writeFileSync(recordPath, JSON.stringify({ version: 1, baseUrl: server.baseUrl, runDir: home, taskId: 'existing', images: [] }));
  const result = await runGenerate(['--resume', recordPath, '--json'], home, { IMAGES2_GEN_API_KEY: 'original-key' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(gets, 1);
  assert.equal(JSON.parse(result.stdout).images.length, 1);
  assert.ok(!fs.readFileSync(recordPath, 'utf8').includes('original-key'));
});

test('an incompatible official model blocks before any submission', async (t) => {
  const output = createTempDir();
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  let posts = 0;
  const server = await startServer((req, res) => {
    posts += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
  });
  t.after(server.close);
  const models = [{ model: 'gemini-foreign', key: 'foreign', family: 'gemini', source: 'profile' }, { model: 'gpt-image-2', key: 'image2', family: 'openai', source: 'fallback' }];
  const record = { attempts: [] };
  await assert.rejects(generate.runCandidate({ name: 'official', family: 'openai', apiStyle: 'official', apiKey: 'test', baseUrl: server.baseUrl, rootOutputDir: output, model: models[0], modelChain: models }, { prompt: 'apple', imageUrls: [], maxSubmissions: 3 }, record), /官方接口协议/);
  assert.equal(posts, 0);
  assert.equal(record.submission_count || 0, 0);
});
