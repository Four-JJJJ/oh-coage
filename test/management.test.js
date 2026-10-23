const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir, writeConfig, securityStub, startServer } = require('./helpers');
const { resolveProfileModel, resolveModelChainForProfile } = require('../skills/oh-coage/scripts/models');
const script = path.resolve(__dirname, '../skills/oh-coage/scripts/manage.js');

function fixture(t) {
  const home = tempDir(t);
  const dir = tempDir(t);
  const config = { version: 1, active_profile: 'creative', current_model: 'image-2', profiles: {
    creative: { model: 'site-flare-lite', fallback_models: ['site-banana', 'gone-model'], synced_models: ['site-flare-lite', 'site-flare-pro', 'site-banana'], family: 'openai', api_style: 'openai' },
    other: { model: 'other-only', synced_models: ['other-only'] },
  } };
  return { home, config, configPath: writeConfig(home, config, dir) };
}
function run(home, args, payload, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(payload ? JSON.stringify(payload) : '');
  });
}
test('switch catalog is scoped to current site and preserves disappeared saved models', async t => {
  const f = fixture(t);
  const result = await run(f.home, ['--snapshot']);
  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.profile, 'creative');
  assert.equal(data.models.some(row => row.id === 'other-only'), false);
  assert.equal(data.models.find(row => row.id === 'gone-model').stale, true);
  assert.equal(data.currentModel, 'site-flare-lite');
});
test('temporary switch does not write config; default switch promotes preserves order', async t => {
  const f = fixture(t);
  const data = JSON.parse((await run(f.home, ['--snapshot'])).stdout);
  const before = fs.readFileSync(f.configPath, 'utf8');
  const temporary = await run(f.home, ['--apply'], { ...data, model: 'banana', action: 'temporary' });
  assert.equal(temporary.code, 0, temporary.stderr);
  assert.equal(JSON.parse(temporary.stdout).model, 'site-banana');
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  const saved = await run(f.home, ['--apply'], { ...data, model: 'site-banana', action: 'default' });
  assert.equal(saved.code, 0, saved.stderr);
  const config = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(config.current_model, 'image-2');
  assert.equal(config.profiles.creative.model, 'site-banana');
  assert.deepEqual(config.profiles.creative.fallback_models, []);
  assert.deepEqual(config.profiles.creative.model_families.other, { primary: 'site-flare-lite', fallbacks: ['gone-model'] });
  assert.equal(config.profiles.other.model, 'other-only');
  assert.equal(config.profiles.creative.resolved_root_output_dir, undefined);
});
test('stale selection and ambiguous shorthand fail without writes', async t => {
  const f = fixture(t);
  const data = JSON.parse((await run(f.home, ['--snapshot'])).stdout);
  const before = fs.readFileSync(f.configPath, 'utf8');
  const ambiguous = await run(f.home, ['--apply'], { ...data, action: 'default', model: 'flare' });
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /site-flare-lite.*site-flare-pro/);
  const stale = await run(f.home, ['--apply'], { ...data, revision: 'stale', action: 'default', model: 'site-banana' });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /配置已更新/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
});
test('render escapes executable site model IDs and includes scope/back routes', async t => {
  const f = fixture(t);
  f.config.profiles.creative.synced_models.push('</script><img src=x>');
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  const result = await run(f.home, ['--render']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes('</script><img'), false);
  assert.match(result.stdout, /value="default" selected/);
  assert.match(result.stdout, /OH_COAGE_MANAGEMENT_CANCEL/);
  assert.match(result.stdout, /modelFamilies/);
  assert.match(result.stdout, /activeFamily/);
});
test('refresh authenticates full paginated list and preserves saved chain', async t => {
  const f = fixture(t);
  const sec = securityStub(t);
  const seen = [];
  const server = await startServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('pageToken')
      ? { models: [{ id: 'provider-grok', owned_by: 'xAI' }] }
      : { data: [{ id: 'provider-gemini', provider: 'Google' }], nextPageToken: 'next' }));
  });
  t.after(server.close);
  f.config.profiles.creative.base_url = server.baseUrl;
  f.config.profiles.creative.keychain_account = 'fake';
  f.config.profiles.creative.model_families = { other: { primary: 'site-flare-lite', fallbacks: ['gone-model'] }, gemini: { primary: 'site-banana', fallbacks: [] } };
  f.config.profiles.creative.active_model_family = 'gemini';
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  const data = JSON.parse((await run(f.home, ['--snapshot'])).stdout);
  const result = await run(f.home, ['--refresh'], { profile: data.profile, revision: data.revision }, sec.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.length, 2);
  const config = JSON.parse(fs.readFileSync(f.configPath));
  assert.deepEqual(config.profiles.creative.synced_models, [
    { id: 'provider-gemini', provider: 'Google' },
    { id: 'provider-grok', owned_by: 'xAI' },
  ]);
  const refreshed = JSON.parse(result.stdout);
  assert.deepEqual(refreshed.modelGroups.gemini, ['provider-gemini', 'site-banana']);
  assert.deepEqual(refreshed.modelGroups.grok, ['provider-grok']);
  assert.equal(refreshed.models.find(row => row.id === 'site-banana').stale, true);
  assert.equal(config.profiles.creative.models_verification, 'list-authenticated');
  assert.equal(config.profiles.creative.model, 'site-flare-lite');
  assert.deepEqual(config.profiles.creative.model_families, f.config.profiles.creative.model_families);
  assert.equal(config.profiles.creative.active_model_family, 'gemini');
});
test('partial refresh failure preserves original models', async t => {
  const f = fixture(t);
  const sec = securityStub(t);
  const server = await startServer((req, res) => {
    res.writeHead(req.url.includes('pageToken') ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'partial' }], nextPageToken: 'bad' }));
  });
  t.after(server.close);
  f.config.profiles.creative.base_url = server.baseUrl;
  f.config.profiles.creative.keychain_account = 'fake';
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  const result = await run(f.home, ['--refresh'], { profile: 'creative' }, sec.env);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)).profiles.creative.synced_models, f.config.profiles.creative.synced_models);
});
test('site resolver handles cross family unknown IDs and real ambiguity', () => {
  const profile = { synced_models: ['gemini-custom', 'vendor-flare-lite', 'vendor-flare-pro'] };
  assert.equal(resolveProfileModel('gemini', profile, {}).family, 'gemini');
  assert.throws(() => resolveProfileModel('flare', profile, {}), /vendor-flare-lite.*vendor-flare-pro/);
  assert.throws(() => resolveProfileModel('image-2', profile, {}), /没有模型/);
});

test('saved chain uses exact site IDs and continues past an unknown primary', () => {
  const warnings = [];
  const profile = { synced_models: ['private-render-v3', 'grok-private'] };
  const options = { profile, config: {}, profileModelKey: 'removed-custom-id', profileFallbackKeys: ['private-render-v3', 'grok-private'], family: 'other', warn: message => warnings.push(message) };
  assert.deepEqual(resolveModelChainForProfile(options).map(row => row.model), ['private-render-v3']);
  assert.match(warnings[0], /跳过首选模型/);
  assert.throws(() => resolveModelChainForProfile({ ...options, allowModelFallback: false }), /当前站点列表中没有模型/);
  assert.throws(() => resolveModelChainForProfile({ ...options, profileFallbackKeys: [] }), /修改主备模型/);
});

test('family configuration saves all groups while temporary selection stays local', async t => {
  const f = fixture(t);
  f.config.profiles.creative.synced_models.push('gpt-image-site', 'gpt-image-backup', 'mystery-site', 'mystery-backup');
  fs.writeFileSync(f.configPath, JSON.stringify(f.config));
  const data = JSON.parse((await run(f.home, ['--snapshot'])).stdout);
  const before = fs.readFileSync(f.configPath, 'utf8');
  const modelFamilies = {
    openai: { primary: 'gpt-image-site', fallbacks: ['gpt-image-backup'] },
    gemini: { primary: 'mystery-site', fallbacks: ['mystery-backup'] },
  };
  const modelFamilyTags = { 'mystery-site': 'gemini', 'mystery-backup': 'gemini' };
  const payload = { profile: data.profile, revision: data.revision, modelFamilies, modelFamilyTags, activeFamily: 'gemini', action: 'temporary' };
  const temporary = await run(f.home, ['--apply'], payload);
  assert.equal(temporary.code, 0, temporary.stderr);
  assert.equal(JSON.parse(temporary.stdout).model, 'mystery-site');
  assert.deepEqual(JSON.parse(temporary.stdout).modelFamilies, { gemini: { primary: 'mystery-site', fallbacks: [] } });
  assert.match(JSON.parse(temporary.stdout).instruction, /不自动尝试/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
  const saved = await run(f.home, ['--apply'], { ...payload, action: 'default' });
  assert.equal(saved.code, 0, saved.stderr);
  const profile = JSON.parse(fs.readFileSync(f.configPath)).profiles.creative;
  assert.deepEqual(profile.model_families, modelFamilies);
  assert.equal(profile.active_model_family, 'gemini');
  assert.equal(profile.model, 'mystery-site');
  assert.deepEqual(profile.fallback_models, ['mystery-backup']);
  const config = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(config.discovered_models['mystery-site'].family, 'gemini');
  assert.equal(config.discovered_models['mystery-site'].family_source, 'user');
});
test('family configuration rejects mismatched groups and stale revisions without writes', async t => {
  const f = fixture(t);
  const data = JSON.parse((await run(f.home, ['--snapshot'])).stdout);
  const before = fs.readFileSync(f.configPath, 'utf8');
  const result = await run(f.home, ['--apply'], { ...data, modelFamilies: { gemini: { primary: 'site-banana', fallbacks: ['site-flare-lite'] } }, activeFamily: 'gemini', action: 'default' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /厂家归属|属于/);
  const stale = await run(f.home, ['--apply'], { ...data, revision: 'old', action: 'default' });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /配置已更新/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before);
});
