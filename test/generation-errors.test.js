const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { tempDir, securityStub, startServer, runNode, writeConfig, generatePath } = require('./helpers');
const { formatGenerationError, safeDetail } = require('../skills/oh-coage/scripts/generation-errors');
process.env.OH_COAGE_TEST = '1';
const { classifyError, pollTask } = require(generatePath);

function run(args, home, env = {}) {
  return runNode(generatePath, args, { home, env: { ...env, OH_COAGE_TEST: '', OH_COAGE_RETRY_DELAY_MS: '0' } });
}

for (const [status, code] of [[402, 'insufficient_balance'], [429, 'insufficient_quota'], [403, 'billing_hard_limit_reached']]) {
  test(`quota ${status}/${code} stops after one POST even with backup and profile fallback enabled`, async (t) => {
    const home = tempDir(t);
    const output = tempDir(t);
    const stub = securityStub(t);
    const models = [];
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        models.push(JSON.parse(raw).model);
        res.writeHead(status, { 'content-type': 'application/json' });
        // Code lies beyond the diagnostic excerpt; classification must use structured data.
        res.end(JSON.stringify({ error: { message: 'x'.repeat(400), code } }));
      });
    });
    t.after(server.close);
    const profile = { base_url: server.baseUrl, keychain_account: 'test', root_output_dir: output,
      family: 'openai', model: 'image-2', fallback_models: ['image-2.5-flare'] };
    writeConfig(home, { active_profile: 'main', profiles: { main: profile, other: { ...profile } } }, output);
    const result = await run(['--prompt', 'apple', '--allow-profile-fallback'], home, stub.env);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(models, ['gpt-image-2']);
    assert.match(result.stderr, /余额或额度不足/);
    assert.doesNotMatch(result.stderr, /--resume|已生成或计费/);
  });
}

test('a genuine rate limit has bounded retries and never switches models', async (t) => {
  const home = tempDir(t);
  const output = tempDir(t);
  const stub = securityStub(t);
  let posts = 0;
  const server = await startServer((req, res) => { posts++; res.writeHead(429, { 'retry-after': '0' }); res.end('too many requests'); });
  t.after(server.close);
  writeConfig(home, { active_profile: 'main', profiles: { main: { base_url: server.baseUrl, root_output_dir: output,
    keychain_account: 'test', model: 'image-2', fallback_models: ['image-2.5-flare'] } } }, output);
  const result = await run(['--prompt', 'apple'], home, stub.env);
  assert.equal(result.code, 1);
  assert.equal(posts, 2);
  assert.match(result.stderr, /服务暂时限制了请求/);
  assert.doesNotMatch(result.stderr, /正在尝试你设置的备选|--resume/);
});

test('long Retry-After stops immediately and reports the actual wait', async (t) => {
  const home = tempDir(t);
  let posts = 0;
  const server = await startServer((req, res) => { posts++; res.writeHead(429, { 'retry-after': '120' }); res.end('limited'); });
  t.after(server.close);
  const result = await run(['--prompt', 'apple', '--out-dir', home, '--base-url', server.baseUrl], home, { IMAGES2_GEN_API_KEY: 'test' });
  assert.equal(result.code, 1);
  assert.equal(posts, 1);
  assert.match(result.stderr, /等待 120 秒/);
});

test('an invalid response preserves unknown outcome without offering unusable resume', async (t) => {
  const home = tempDir(t);
  let posts = 0;
  const server = await startServer((req, res) => { posts++; res.end('not JSON'); });
  t.after(server.close);
  const result = await run(['--prompt', 'apple', '--out-dir', home, '--base-url', server.baseUrl], home, { IMAGES2_GEN_API_KEY: 'test' });
  assert.equal(result.code, 1);
  assert.equal(posts, 1);
  assert.match(result.stderr, /服务返回了异常结果/);
  assert.match(result.stderr, /没有可查询的任务编号/);
  assert.doesNotMatch(result.stderr, /--resume|未计费|此次未提交生成请求/);
});

test('invalid parameters fail before POST and do not offer task recovery', async (t) => {
  const home = tempDir(t);
  let posts = 0;
  const server = await startServer((req, res) => { posts++; res.end('{}'); });
  t.after(server.close);
  const result = await run(['--prompt', 'apple', '--resolution', '4k', '--size', '1:1', '--out-dir', home, '--base-url', server.baseUrl], home, { IMAGES2_GEN_API_KEY: 'test' });
  assert.equal(result.code, 1);
  assert.equal(posts, 0);
  assert.match(result.stderr, /此次未提交生成请求/);
  assert.doesNotMatch(result.stderr, /--resume|计费结果尚未确认/);
});

test('poll retries preserve GET semantics and honor a long Retry-After', async () => {
  let requests = 0;
  await assert.rejects(pollTask('test', 'https://example.test/v1', 'existing', {
    request: async () => { requests++; throw Object.assign(new Error('HTTP 429: limited'), { retryAfterMs: 120000 }); },
    sleep: async () => assert.fail('must not wait past local retry limit'),
  }));
  assert.equal(requests, 1);
});

test('recovery actions depend on stored data and terminal task status', () => {
  const format = (properties) => formatGenerationError(Object.assign(new Error('detail'), properties));
  assert.match(format({ generationAccepted: true, recovery: { taskId: '123', images: 0, path: '/record' } }), /继续查询原任务/);
  assert.match(format({ generationAccepted: true, recovery: { images: 2, path: '/record', saved: { 0: '/saved.png' } } }), /已保存图片已保留：\/saved.png/);
  assert.match(format({ recovery: { images: 2, path: '/record' } }), /无需重新生成/);
  assert.doesNotMatch(format({ kind: 'task_empty', terminalTask: true, recovery: { taskId: '123', images: 0, path: '/record' } }), /--resume/);
  assert.doesNotMatch(format({ stage: 'submit', recovery: { images: 0, path: '/record' } }), /--resume/);
});

test('TLS errors never retry or suggest disabling certificate verification', () => {
  const error = Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  const classification = classifyError(error, { idempotent: false });
  assert.equal(classification.kind, 'tls');
  assert.equal(classification.retryable, false);
  assert.equal(classification.fallback, false);
  assert.match(formatGenerationError(error, classification), /安全连接未能建立/);
});

test('technical diagnostics redact credentials', () => {
  const text = safeDetail('Bearer secret123 api_key="test123" https://test/a?token=private&signature=signed sk-secret123');
  for (const secret of ['secret123', 'test123', 'private', 'signed', 'sk-secret123']) assert.ok(!text.includes(secret));
});

test('missing or corrupt recovery files give a recovery-specific action without generation', async (t) => {
  const home = tempDir(t);
  const record = path.join(home, 'record.json');
  const missing = await run(['--resume', record], home);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /暂时无法恢复这次任务/);
  fs.writeFileSync(record, 'broken');
  const corrupt = await run(['--resume', record], home);
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.stderr, /暂时无法恢复这次任务/);
  assert.equal(fs.readFileSync(record, 'utf8'), 'broken');
});

test('query failure offers recovery of original task, while a terminal empty task does not', async (t) => {
  const home = tempDir(t);
  let completed = false;
  const requests = [];
  const server = await startServer((req, res) => {
    requests.push(req.method);
    if (!completed) { res.writeHead(401); res.end('invalid key'); return; }
    res.end(JSON.stringify({ data: { status: 'completed', result: {} } }));
  });
  t.after(server.close);
  const record = path.join(home, 'recovery.json');
  fs.writeFileSync(record, JSON.stringify({ version: 1, baseUrl: server.baseUrl, taskId: 'original', images: [], runDir: home }));
  const failed = await run(['--resume', record], home, { IMAGES2_GEN_API_KEY: 'test' });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /继续查询原任务/);
  assert.match(failed.stderr, /--resume/);
  completed = true;
  const empty = await run(['--resume', record], home, { IMAGES2_GEN_API_KEY: 'test' });
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /任务已完成，但没有返回可用图片/);
  assert.doesNotMatch(empty.stderr, /--resume/);
  assert.deepEqual(requests, ['GET', 'GET']);
});

test('invalid image result retains recovery evidence and reports a content-format failure', async (t) => {
  const home = tempDir(t);
  let posts = 0;
  const server = await startServer((req, res) => { posts++; res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })); });
  t.after(server.close);
  const result = await run(['--prompt', 'apple', '--out-dir', home, '--base-url', server.baseUrl], home, { IMAGES2_GEN_API_KEY: 'test' });
  assert.equal(result.code, 1);
  assert.equal(posts, 1);
  assert.match(result.stderr, /服务返回的内容不是有效图片/);
  assert.doesNotMatch(result.stderr, /此次未提交生成请求|钱已经/);
});
