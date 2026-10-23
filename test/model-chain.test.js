const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const skillScripts = path.join(repoRoot, 'skills', 'oh-coage', 'scripts');
const setupPath = path.join(skillScripts, 'setup.js');
const generatePath = path.join(skillScripts, 'generate.js');

const { tempDir, securityStub, startServer } = require('./helpers');
const { resolveModelChainForProfile } = require(path.join(skillScripts, 'models'));

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function runNode(scriptPath, args, home, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, ...extraEnv };
    delete env.OH_COAGE_TEST;

    const child = spawn(process.execPath, [scriptPath, ...args], {
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

function scaffold(t, config) {
  const home = tempDir(t, 'oh-coage-chain-home-');
  const configDir = tempDir(t, 'oh-coage-chain-cfg-');
  const configPath = path.join(configDir, 'oh-coage-config.json');

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.mkdirSync(path.join(home, '.oh-coage'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.oh-coage', 'state.json'),
    JSON.stringify({ config_path: configPath }),
  );

  return {
    home,
    configDir,
    configPath,
    readConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  };
}

function readRuns(home) {
  const runsPath = path.join(home, '.oh-coage', 'runs.jsonl');
  if (!fs.existsSync(runsPath)) return [];
  return fs.readFileSync(runsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * 起一个假站点：按 model 名决定返回成功还是指定错误码。
 * 这样才能验证「首选失败 → 同 profile 换备用模型」这条链路。
 */
async function startModelAwareServer(t, behavior) {
  const seen = [];
  const server = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* multipart 等不解析 */ }
        seen.push(body.model);

        const action = behavior(body.model);
        if (action === 'ok') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
          return;
        }
        if (action === 'dead-image') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ url: 'http://127.0.0.1:1/dead.png' }] }));
          return;
        }
        res.writeHead(action, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `model ${body.model} not supported (${action})` }));
      });
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(server.close);
  return { server, seen };
}

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

test('resolveModelChainForProfile builds primary + fallbacks from one profile', () => {
  const config = {
    version: 1,
    current_model: 'image-2',
    profiles: {},
    custom_models: { 'vendor-a': { model: 'vendor-a-1', family: 'openai' } },
  };

  const chain = resolveModelChainForProfile({
    profileModelKey: 'image-2',
    profileFallbackKeys: ['image-2.5-flare', 'vendor-a'],
    config,
    family: 'openai',
  });

  assert.deepEqual(chain.map((entry) => entry.model), [
    'gpt-image-2',
    'gpt-image-2.5-flare',
  ]);
  assert.deepEqual(chain.map((entry) => entry.source), ['profile', 'fallback']);
});

test('resolveModelChainForProfile follows the global model when the profile pins none', () => {
  const config = { version: 1, current_model: 'image-2.5-sunburst', profiles: {} };

  const chain = resolveModelChainForProfile({
    profileFallbackKeys: ['image-2'],
    config,
    family: 'openai',
  });

  assert.deepEqual(chain.map((entry) => entry.model), ['gpt-image-2.5-sunburst', 'gpt-image-2']);
});

test('a CLI --model wins and disables the fallback chain entirely', () => {
  const config = { version: 1, current_model: 'image-2', profiles: {} };
  const cliEntry = { key: 'image-2.5-flare', model: 'gpt-image-2.5-flare', family: 'openai' };

  const chain = resolveModelChainForProfile({
    cliModelEntry: cliEntry,
    profileModelKey: 'image-2',
    profileFallbackKeys: ['image-2.5-sunburst'],
    config,
    family: 'openai',
  });

  assert.equal(chain.length, 1, '--model 是显式指定，不该再自动换备用');
  assert.equal(chain[0].model, 'gpt-image-2.5-flare');
  assert.equal(chain[0].source, 'cli');
});

test('a broken sole backup is skipped without trying a later legacy backup', () => {
  const warnings = [];
  const chain = resolveModelChainForProfile({
    profileModelKey: 'image-2',
    profileFallbackKeys: ['ghost-model', 'image-2.5-flare'],
    config: { version: 1, current_model: 'image-2', profiles: {} },
    family: 'openai',
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(chain.map((entry) => entry.model), ['gpt-image-2']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /跳过备用模型 ghost-model/);
});

test('fallback entries that duplicate the primary or each other are dropped', () => {
  const warnings = [];
  const chain = resolveModelChainForProfile({
    profileModelKey: 'image-2',
    profileFallbackKeys: ['image-2', 'gpt-image-2.5-flare', 'image-2.5-flare'],
    config: { version: 1, current_model: 'image-2', profiles: {} },
    family: 'openai',
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(chain.map((entry) => entry.model), ['gpt-image-2', 'gpt-image-2.5-flare']);
  assert.equal(warnings.length, 0, '只读取一个备选，多余旧项不执行');
});

test('allowModelFallback=false keeps only the primary model', () => {
  const chain = resolveModelChainForProfile({
    profileModelKey: 'image-2',
    profileFallbackKeys: ['image-2.5-flare'],
    config: { version: 1, current_model: 'image-2', profiles: {} },
    family: 'openai',
    allowModelFallback: false,
  });

  assert.deepEqual(chain.map((entry) => entry.model), ['gpt-image-2']);
});

test('a backup from another manufacturer is not requested', () => {
  const warnings = [];
  const chain = resolveModelChainForProfile({
    profileModelKey: 'image-2',
    profileFallbackKeys: ['banana-2.1', 'image-2.5-flare'],
    config: { version: 1, current_model: 'image-2', profiles: {} },
    family: 'openai',
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(chain.map((entry) => entry.model), ['gpt-image-2']);
  assert.match(warnings[0], /不属于当前厂家/);
});

// ---------------------------------------------------------------------------
// setup.js：主备配置写进同一个 profile
// ---------------------------------------------------------------------------

test('setup --primary-model + --fallback-model stores one profile with both', async (t) => {
  const stub = securityStub(t);
  const home = tempDir(t, 'oh-coage-chain-home-');
  const outputDir = tempDir(t, 'oh-coage-chain-out-');

  const init = await runNode(setupPath, [
    '--output-dir', outputDir,
    '--profile', 'main',
    '--base-url', 'https://img.example/v1',
    '--api-key', 'stub-key',
    '--activate',
    '--primary-model', 'image-2',
    '--fallback-model', 'image-2.5-flare',
  ], home, stub.env);

  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /fallback_models: image-2\.5-flare/);

  const config = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json'), 'utf8'));
  assert.deepEqual(Object.keys(config.profiles), ['main'], '主备不能变成多个 profile');
  assert.equal(config.profiles.main.model, 'image-2');
  assert.deepEqual(config.profiles.main.fallback_models, ['image-2.5-flare']);
});

test('--fallback-model alone leaves the pinned primary untouched', async (t) => {
  const stub = securityStub(t);
  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: '.',
        keychain_account: 'main:x',
        model: 'image-2.5-sunburst',
      },
    },
  });

  const result = await runNode(setupPath, ['--fallback-model', 'image-2.5-flare', '--profile', 'main'], ctx.home, stub.env);

  assert.equal(result.code, 0, result.stderr);
  const config = ctx.readConfig();
  assert.equal(config.profiles.main.model, 'image-2.5-sunburst', '首选不该被改动');
  assert.deepEqual(config.profiles.main.fallback_models, ['image-2.5-flare']);
});

test('a fallback equal to the primary is dropped instead of being tried twice', async (t) => {
  const stub = securityStub(t);
  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: '.',
        keychain_account: 'main:x',
        model: 'image-2',
      },
    },
  });

  const result = await runNode(setupPath, ['--fallback-model', 'image-2', '--profile', 'main'], ctx.home, stub.env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(ctx.readConfig().profiles.main.fallback_models, undefined, '和首选相同的备用模型应被丢弃');
  assert.match(result.stdout, /已清除 profile main 的备用模型/);
});

test('--clear-fallback-models removes the chain but keeps the primary', async (t) => {
  const stub = securityStub(t);
  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: '.',
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-flare'],
      },
    },
  });

  const result = await runNode(setupPath, ['--clear-fallback-models', '--profile', 'main'], ctx.home, stub.env);

  assert.equal(result.code, 0, result.stderr);
  const config = ctx.readConfig();
  assert.equal(config.profiles.main.model, 'image-2');
  assert.equal(config.profiles.main.fallback_models, undefined);
});

test('an invalid fallback model is rejected before anything is written', async (t) => {
  const stub = securityStub(t);
  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: '.',
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-flare'],
      },
    },
  });

  const result = await runNode(setupPath, ['--fallback-model', 'ghost-model', '--profile', 'main'], ctx.home, stub.env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /未知模型/);
  assert.deepEqual(ctx.readConfig().profiles.main.fallback_models, ['image-2.5-flare'], '校验失败不应改动已有配置');
});

test('--list shows the fallback chain on the same profile line', async (t) => {
  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: '.',
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-flare'],
      },
    },
  });

  const result = await runNode(setupPath, ['--list'], ctx.home);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[model: image-2\] \[备用: image-2\.5-flare\]/);
});

test('--health-check flags a fallback model that no longer exists', async (t) => {
  const stub = securityStub(t);
  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: '.',
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['ghost-model'],
      },
    },
  });

  const result = await runNode(setupPath, ['--health-check'], ctx.home, stub.env);

  assert.equal(result.code, 1, '有失效备用模型时健康检查应报错');
  assert.match(result.stdout, /fallback_models: fail/);
});

// ---------------------------------------------------------------------------
// generate.js：失败自动用备选模型，站点/Key 不变
// ---------------------------------------------------------------------------

test('the fallback model generates when the primary is rejected by the site', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, (model) => (
    model === 'gpt-image-2' ? 400 : 'ok'
  ));

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        api_style: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-flare'],
      },
    },
  });

  const result = await runNode(generatePath, [
    '--prompt', 'a red apple',
    '--out-dir', outputDir,
    '--json',
  ], ctx.home, { ...stub.env, OH_COAGE_RETRY_DELAY_MS: '0' });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(seen, ['gpt-image-2', 'gpt-image-2.5-flare'], '首选失败后应改用备用模型');
  assert.match(result.stderr, /gpt-image-2 暂不可用，正在尝试你设置的备选 gpt-image-2\.5-flare/);
  assert.match(result.stderr, /已自动用备用模型生成/);

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, 'gpt-image-2.5-flare');
  assert.equal(payload.model_source, 'fallback');
  assert.equal(payload.used_fallback_model, true);
  assert.equal(payload.profile, 'main', '整个过程不能换 profile');

  const runs = readRuns(ctx.home);
  assert.equal(runs.at(-1).model, 'gpt-image-2.5-flare');
  assert.equal(runs.at(-1).model_source, 'fallback');
  assert.deepEqual(runs.at(-1).model_chain, ['gpt-image-2', 'gpt-image-2.5-flare']);
  assert.deepEqual(
    runs.at(-1).attempts.map((attempt) => [attempt.model, attempt.status]),
    [['gpt-image-2', 'failed'], ['gpt-image-2.5-flare', 'success']],
    '400 不重试首选模型，只记一条失败 + 一条成功',
  );
});

test('legacy cross-family fallback is split and never automatically changes manufacturer', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, (model) => (
    model === 'gpt-image-2' ? 400 : 'ok'
  ));

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        api_style: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['banana-2.1'],
      },
    },
  });

  const result = await runNode(generatePath, [
    '--prompt', 'a red apple',
    '--out-dir', outputDir,
    '--json',
  ], ctx.home, { ...stub.env, OH_COAGE_RETRY_DELAY_MS: '0' });

  assert.equal(result.code, 1);
  assert.deepEqual(seen, ['gpt-image-2'], 'failure must not select another manufacturer');
  assert.doesNotMatch(result.stderr, /改用备用模型 gemini/);
});

test('an uncertain 5xx stops without resubmitting or switching models', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, (model) => (
    model === 'gpt-image-2' ? 503 : 'ok'
  ));

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-flare'],
      },
    },
  });

  const result = await runNode(generatePath, ['--prompt', 'cat', '--out-dir', outputDir], ctx.home, {
    ...stub.env,
    OH_COAGE_RETRY_DELAY_MS: '0',
  });

  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(seen, ['gpt-image-2'], '结果不明确时不得重新提交');
  assert.match(result.stderr, /本次记录/);
  assert.doesNotMatch(result.stderr, /--resume/);
});

test('legacy multi-backup generation stops after the first backup fails', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, (model) => (
    model === 'gpt-image-2.5-flare' ? 'ok' : 404
  ));

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-sunburst', 'image-2.5-flare'],
      },
    },
  });

  const result = await runNode(generatePath, ['--prompt', 'cat', '--out-dir', outputDir], ctx.home, {
    ...stub.env,
    OH_COAGE_RETRY_DELAY_MS: '0',
  });

  assert.notEqual(result.code, 0);
  assert.deepEqual(seen, ['gpt-image-2', 'gpt-image-2.5-sunburst']);
});

test('a download failure does not switch models, because the image was already paid for', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, () => 'dead-image');

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-flare'],
      },
    },
  });

  const result = await runNode(generatePath, ['--prompt', 'cat', '--out-dir', outputDir], ctx.home, {
    ...stub.env,
    OH_COAGE_RETRY_DELAY_MS: '0',
  });

  assert.notEqual(result.code, 0, '下载失败时整体应该失败');
  assert.deepEqual(seen, ['gpt-image-2'], '图片已生成并计费，换模型重发等于重复扣费');
  assert.match(result.stderr, /不会重试提交/);
});

test('--model skips the fallback chain entirely', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, (model) => (
    model === 'gpt-image-2.5-flare' ? 400 : 'ok'
  ));

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2'],
      },
    },
  });

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--model', 'image-2.5-flare',
    '--out-dir', outputDir,
  ], ctx.home, { ...stub.env, OH_COAGE_RETRY_DELAY_MS: '0' });

  assert.notEqual(result.code, 0);
  assert.deepEqual(seen, ['gpt-image-2.5-flare'], '用户点名了模型，就只试它，不自动换备用');
});

test('--no-fallback also disables switching to the fallback model', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, (model) => (
    model === 'gpt-image-2' ? 400 : 'ok'
  ));

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['image-2.5-flare'],
      },
    },
  });

  const result = await runNode(generatePath, ['--prompt', 'cat', '--out-dir', outputDir, '--no-fallback'], ctx.home, {
    ...stub.env,
    OH_COAGE_RETRY_DELAY_MS: '0',
  });

  assert.notEqual(result.code, 0);
  assert.deepEqual(seen, ['gpt-image-2'], '--no-fallback 应连备用模型一起关掉');
});

test('a broken fallback model entry does not stop the primary from working', async (t) => {
  const stub = securityStub(t);
  const outputDir = tempDir(t, 'oh-coage-chain-out-');
  const { server, seen } = await startModelAwareServer(t, () => 'ok');

  const ctx = scaffold(t, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        base_url: `${server.origin}/v1`,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        model: 'image-2',
        fallback_models: ['ghost-model'],
      },
    },
  });

  const result = await runNode(generatePath, ['--prompt', 'cat', '--out-dir', outputDir], ctx.home, stub.env);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(seen, ['gpt-image-2']);
  assert.doesNotMatch(result.stderr, /改用备用模型 ghost-model/);
});

test('setup rejects multiple backups before creating a config or Keychain record', async t => {
  const stub=securityStub(t), home=tempDir(t), outputDir=tempDir(t);
  const result=await runNode(setupPath,['--output-dir',outputDir,'--profile','main','--base-url','https://example.com/v1','--api-key','stub-key','--primary-model','image-2','--fallback-model','image-2.5-flare','--fallback-model','banana-2.1'],home,stub.env);
  assert.notEqual(result.code,0); assert.match(result.stderr,/最多选择一个/);
  assert.equal(fs.existsSync(path.join(outputDir,'oh-coage-config.json')),false);
});
