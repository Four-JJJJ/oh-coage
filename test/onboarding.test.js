const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { tempDir, securityStub, startServer } = require('./helpers');
const script = path.resolve(__dirname, '../skills/oh-coage/scripts/onboarding.js');
function run(command, input, home, env, extra = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, command, ...extra], { env: { ...process.env, HOME: home, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
test('rendering a new connection defaults to OpenAI but honors an explicit native protocol and family', async t => {
  const home = tempDir(t);
  const initial = await run('--render-connection', {}, home, {});
  assert.equal(initial.code, 0, initial.stderr);
  const readData = html => JSON.parse(html.match(/const data = (.*);/)[1]);
  assert.equal(readData(initial.stdout).api, 'openai');
  assert.equal(readData(initial.stdout).profileFamily, null);
  const native = await run('--render-connection', { api: 'official', family: 'gemini' }, home, {});
  assert.equal(native.code, 0, native.stderr);
  assert.equal(readData(native.stdout).api, 'official');
  assert.equal(readData(native.stdout).profileFamily, 'gemini');
});

test('onboarding verifies all pages, preserves exact models, and activates only after valid selection', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const requests = [];
  const server = await startServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.includes('after=')
      ? { data: [{ id: 'custom-picture' }, { id: 'gemini-banana-2.1' }, { id: 'grok-image-2' }, { id: '</script><script>alert(1)</script>' }] }
      : { data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2.5-flare' }, { id: 'text-model' }], has_more: true }));
  });
  t.after(server.close);
  const verified = await run('--verify', { profile: 'main', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir }, home, stub.env);
  assert.equal(verified.code, 0, verified.stderr);
  const data = JSON.parse(verified.stdout);
  assert.equal(data.models.length, 7);
  assert.equal(requests.length, 2);
  assert.equal(fs.existsSync(path.join(home, '.oh-coage/state.json')), false);
  assert.equal(fs.existsSync(path.join(outputDir, 'oh-coage-config.json')), false);
  const draft = fs.readFileSync(path.join(home, '.oh-coage/onboarding', `${data.draftId}.json`), 'utf8');
  assert.ok(!draft.includes('test-secret'));
  const rendered = await run('--render-models', {}, home, stub.env, [data.draftId]);
  assert.equal(rendered.code, 0, rendered.stderr);
  assert.ok(rendered.stdout.includes('\\u003c/script>'));
  for (const input of [
    { model: 'not-returned', fallbackModels: [] },
    { model: 'gpt-image-2', fallbackModels: ['gpt-image-2'] },
    { model: 'gpt-image-2' },
  ]) {
    const bad = await run('--complete', { draftId: data.draftId, ...input }, home, stub.env);
    assert.equal(bad.code, 1);
    assert.equal(fs.existsSync(path.join(home, '.oh-coage/state.json')), false);
  }
  const saved = await run('--complete', { draftId: data.draftId, model: 'gpt-image-2', fallbackModels: ['custom-picture', 'gemini-banana-2.1', 'grok-image-2', 'gpt-image-2.5-flare'] }, home, stub.env);
  assert.equal(saved.code, 0, saved.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json')));
  assert.equal(config.active_profile, 'main');
  assert.equal(config.current_model, undefined);
  assert.equal(config.profiles.main.api_style, 'openai');
  assert.deepEqual(config.profiles.main.fallback_models, ['gpt-image-2.5-flare']);
  assert.deepEqual(config.profiles.main.model_families, { openai: { primary: 'gpt-image-2', fallbacks: ['gpt-image-2.5-flare'] }, other: { primary: 'custom-picture', fallbacks: [] }, gemini: { primary: 'gemini-banana-2.1', fallbacks: [] }, grok: { primary: 'grok-image-2', fallbacks: [] } });
  assert.equal(config.discovered_models['gemini-banana-2.1'].family, 'gemini');
  assert.equal(config.discovered_models['grok-image-2'].family, 'grok');
  assert.ok(!JSON.stringify(config).includes('test-secret'));
});
test('gateway owner labels do not collapse multiple model manufacturers into OpenAI', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const ids = ['gpt-image-2', 'gemini-banana-2.1-lite', 'grok-image-2-lite'];
  const server = await startServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: ids.map(id => ({ id, owned_by: 'openai' })) }));
  });
  t.after(server.close);
  const verified = await run('--verify', { profile: 'multi', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir }, home, stub.env);
  assert.equal(verified.code, 0, verified.stderr);
  const draft = JSON.parse(verified.stdout);
  assert.deepEqual(draft.modelFamilyTags, { 'gpt-image-2': 'openai', 'gemini-banana-2.1-lite': 'gemini', 'grok-image-2-lite': 'grok' });
  const modelFamilies = Object.fromEntries(ids.map((id, index) => [['openai', 'gemini', 'grok'][index], { primary: id, fallbacks: [] }]));
  const saved = await run('--complete', { draftId: draft.draftId, modelFamilies, activeFamily: 'gemini' }, home, stub.env);
  assert.equal(saved.code, 0, saved.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json'))).profiles.multi;
  assert.deepEqual(profile.model_families, modelFamilies);
  assert.equal(profile.api_style, 'openai');
  assert.equal(profile.active_model_family, 'gemini');
});

test('invalid authentication returns sanitized errors without staging or activation', async t => {
  const home = tempDir(t), stub = securityStub(t);
  const server = await startServer((req, res) => { res.writeHead(401); res.end('test-secret echoed by upstream'); });
  t.after(server.close);
  const result = await run('--verify', { profile: 'main', baseUrl: server.baseUrl, apiKey: 'test-secret' }, home, stub.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /401/);
  assert.ok(!result.stderr.includes('test-secret'));
  assert.equal(fs.existsSync(path.join(home, '.oh-coage/onboarding')), false);
});

test('completed submissions are idempotent, edits preload and stale edits cannot overwrite', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const server = await startServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2.5-flare' }] })); });
  t.after(server.close);
  const initial = JSON.parse((await run('--verify', { profile: 'main', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir }, home, stub.env)).stdout);
  const selection = { draftId: initial.draftId, model: 'gpt-image-2', fallbackModels: ['gpt-image-2.5-flare'] };
  assert.equal((await run('--complete', selection, home, stub.env)).code, 0);
  const repeated = await run('--complete', selection, home, stub.env);
  assert.equal(JSON.parse(repeated.stdout).repeated, true);
  assert.equal((await run('--complete', { ...selection, fallbackModels: [] }, home, stub.env)).code, 1);
  const edit = await run('--edit-models', { profile: 'main' }, home, stub.env);
  assert.equal(edit.code, 0, edit.stderr);
  const draft = JSON.parse(edit.stdout);
  assert.deepEqual(draft.selectedModels, ['gpt-image-2', 'gpt-image-2.5-flare']);
  const configPath = path.join(outputDir, 'oh-coage-config.json');
  fs.appendFileSync(configPath, '\n');
  const stale = await run('--complete', { draftId: draft.draftId, model: 'gpt-image-2.5-flare', fallbackModels: [] }, home, stub.env);
  assert.equal(stale.code, 1); assert.match(stale.stderr, /其他会话更新/);
  const fresh = JSON.parse((await run('--edit-models', { profile: 'main' }, home, stub.env)).stdout);
  const saved = await run('--complete', { draftId: fresh.draftId, model: 'gpt-image-2.5-flare', fallbackModels: ['gpt-image-2'] }, home, stub.env);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse(fs.readFileSync(configPath)).profiles.main.model, 'gpt-image-2.5-flare');
});

test('manual model list is explicit unverified and cancellation invalidates the draft', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const server = await startServer((req, res) => { res.writeHead(404); res.end(); });
  t.after(server.close);
  const input = { profile: 'manual', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir };
  assert.equal((await run('--verify', input, home, stub.env)).code, 1);
  const verified = await run('--verify', { ...input, manualModels: ['vendor-picture-actual-id'] }, home, stub.env);
  assert.equal(verified.code, 0, verified.stderr);
  const draft = JSON.parse(verified.stdout);
  assert.equal(draft.status, 'unverified');
  assert.equal((await run('--cancel', {}, home, stub.env, [draft.draftId])).code, 0);
  const complete = await run('--complete', { draftId: draft.draftId, model: 'vendor-picture-actual-id', fallbackModels: [] }, home, stub.env);
  assert.equal(complete.code, 1); assert.match(complete.stderr, /已取消/);
});

test('partial paginated results cannot be bypassed by manual models', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const server = await startServer((req, res) => {
    if (req.url.includes('after=')) { res.writeHead(503); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }], has_more: true }));
  });
  t.after(server.close);
  const result = await run('--verify', { profile: 'main', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir, manualModels: ['vendor-model'] }, home, stub.env);
  assert.equal(result.code, 1); assert.match(result.stderr, /503/);
  assert.equal(fs.existsSync(path.join(home, '.oh-coage/onboarding')), false);
});

test('connection edit reuses saved key only when omitted and does not change active profile', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const server = await startServer((req, res) => { assert.ok(['Bearer test-secret', 'Bearer stub-api-key'].includes(req.headers.authorization)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] })); });
  t.after(server.close);
  const initial = JSON.parse((await run('--verify', { profile: 'main', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir }, home, stub.env)).stdout);
  assert.equal((await run('--complete', { draftId: initial.draftId, model: 'gpt-image-2', fallbackModels: [] }, home, stub.env)).code, 0);
  const configPath = path.join(outputDir, 'oh-coage-config.json');
  const original = JSON.parse(fs.readFileSync(configPath));
  const edited = await run('--verify', { editProfile: 'main', baseUrl: server.baseUrl }, home, stub.env);
  assert.equal(edited.code, 0, edited.stderr);
  const result = await run('--complete', { draftId: JSON.parse(edited.stdout).draftId, model: 'gpt-image-2', fallbackModels: [] }, home, stub.env);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(configPath));
  assert.equal(config.active_profile, original.active_profile);
  assert.notEqual(config.profiles.main.keychain_account, original.profiles.main.keychain_account);
  assert.equal(config.profiles.main.root_output_dir, outputDir);
});

test('failure saving local state rolls back config and leaves draft retryable', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const server = await startServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] })); });
  t.after(server.close);
  const initial = JSON.parse((await run('--verify', { profile: 'main', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir }, home, stub.env)).stdout);
  const input = { draftId: initial.draftId, model: 'gpt-image-2', fallbackModels: [] };
  const brokenScript = path.join(home, 'failure.js');
  fs.writeFileSync(brokenScript, `const store = require(${JSON.stringify(path.resolve(__dirname, '../skills/oh-coage/scripts/config-store.js'))}); store.saveState = () => { throw new Error('simulated state write failure'); }; try { require(${JSON.stringify(script)}).complete(JSON.parse(require('fs').readFileSync(0, 'utf8'))); } catch (e) { console.error(e.message); process.exitCode = 1; }`);
  const failed = await new Promise(resolve => {
    const child = spawn(process.execPath, [brokenScript], { env: { ...process.env, HOME: home, ...stub.env } });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.on('close', code => resolve({ code, stderr })); child.stdin.end(JSON.stringify(input));
  });
  assert.equal(failed.code, 1); assert.match(failed.stderr, /simulated state/);
  assert.equal(fs.existsSync(path.join(outputDir, 'oh-coage-config.json')), false);
  const retried = await run('--complete', input, home, stub.env);
  assert.equal(retried.code, 0, retried.stderr);
});

test('changed connection URL never forwards stored key unless explicitly supplied', async t => {
  const home = tempDir(t), outputDir = tempDir(t), stub = securityStub(t);
  const server = await startServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] })); });
  t.after(server.close);
  const initial = JSON.parse((await run('--verify', { profile: 'main', baseUrl: server.baseUrl, apiKey: 'test-secret', outputDir }, home, stub.env)).stdout);
  assert.equal((await run('--complete', { draftId: initial.draftId, model: 'gpt-image-2', fallbackModels: [] }, home, stub.env)).code, 0);
  let forwarded = 0;
  const destination = await startServer((req, res) => { forwarded++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] })); });
  t.after(destination.close);
  for (const apiKey of [undefined, '', '  ']) {
    const rejected = await run('--verify', { editProfile: 'main', baseUrl: destination.baseUrl, apiKey }, home, stub.env);
    assert.equal(rejected.code, 1); assert.match(rejected.stderr, /地址已更改/);
  }
  assert.equal(forwarded, 0);
  const explicit = await run('--verify', { editProfile: 'main', baseUrl: destination.baseUrl, apiKey: 'new-explicit-key' }, home, stub.env);
  assert.equal(explicit.code, 0, explicit.stderr); assert.equal(forwarded, 1);
});

test('onboarding rejects overlong and path-like profile names before any request', async t => {
  const home = tempDir(t), stub = securityStub(t);
  let requests = 0;
  const server = await startServer((req, res) => { requests++; res.end('{}'); });
  t.after(server.close);
  for (const profile of ['a'.repeat(65), 'a/b', 'a\\b', 'bad\x7f', '__proto__']) {
    const result = await run('--verify', { profile, baseUrl: server.baseUrl, apiKey: 'test-secret' }, home, stub.env);
    assert.equal(result.code, 1); assert.match(result.stderr, /配置名称/);
  }
  assert.equal(requests, 0);
});
