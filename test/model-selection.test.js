const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const setupPath = path.join(repoRoot, 'skills', 'oh-coage', 'scripts', 'setup.js');
const generatePath = path.join(repoRoot, 'skills', 'oh-coage', 'scripts', 'generate.js');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const BASE_CONFIG = {
  version: 1,
  active_profile: 'main',
  current_model: 'image-2',
  profiles: {
    main: {
      base_url: 'https://img.example/v1',
      root_output_dir: '.',
      keychain_account: 'main:x',
    },
  },
};

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-model-'));
}

function runNode(scriptPath, args, home) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home };
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

/** 直接铺好配置和 state.json，避开 Keychain，只测模型相关逻辑。 */
function scaffold(t, config) {
  const home = createTempDir();
  const configDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const configPath = path.join(configDir, 'oh-coage-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  fs.mkdirSync(path.join(home, '.oh-coage'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.oh-coage', 'state.json'),
    JSON.stringify({ config_path: configPath }),
  );

  return {
    home,
    readConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  };
}

test('--list-models works before initialization and marks the default', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = await runNode(setupPath, ['--list-models'], home);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /current_model: image-2 -> gpt-image-2/);
  assert.match(result.stdout, /\* image-2 -> gpt-image-2/);
  assert.match(result.stdout, /image-2\.5-sunburst -> gpt-image-2\.5-sunburst/);
  assert.match(result.stdout, /image-2\.5-flare -> gpt-image-2\.5-flare/);
});

test('--model switches the persisted default', async (t) => {
  const ctx = scaffold(t, BASE_CONFIG);

  const switched = await runNode(setupPath, ['--model', 'image-2.5-flare'], ctx.home);
  assert.equal(switched.code, 0, switched.stderr);
  assert.match(switched.stdout, /已切换当前模型: image-2\.5-flare/);
  assert.equal(ctx.readConfig().current_model, 'image-2.5-flare');

  const listed = await runNode(setupPath, ['--list-models'], ctx.home);
  assert.match(listed.stdout, /\* image-2\.5-flare/);
});

test('--model refuses to guess between the two 2.5 models', async (t) => {
  const ctx = scaffold(t, BASE_CONFIG);

  const result = await runNode(setupPath, ['--model', '2.5'], ctx.home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /对应多个模型/);
  assert.match(result.stderr, /image-2\.5-sunburst/);
  assert.equal(ctx.readConfig().current_model, 'image-2', '歧义输入不应改动配置');
});

test('--add-model guides the user to supply a model id, then persists it', async (t) => {
  const ctx = scaffold(t, BASE_CONFIG);

  const missing = await runNode(setupPath, ['--add-model', 'my-model'], ctx.home);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /缺少 --model-id/);
  assert.match(missing.stderr, /向用户确认该站点要求的 model ID/);
  assert.equal(ctx.readConfig().custom_models, undefined, '校验失败不应写入配置');

  const added = await runNode(setupPath, ['--add-model', 'my-model', '--model-id', 'vendor-x-1'], ctx.home);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(ctx.readConfig().custom_models['my-model'].model, 'vendor-x-1');

  const switched = await runNode(setupPath, ['--model', 'my-model'], ctx.home);
  assert.equal(switched.code, 0, switched.stderr);
  assert.equal(ctx.readConfig().current_model, 'my-model');
});

test('deleting the current custom model falls back to the default', async (t) => {
  const ctx = scaffold(t, BASE_CONFIG);

  await runNode(setupPath, ['--add-model', 'my-model', '--model-id', 'vendor-x-1'], ctx.home);
  await runNode(setupPath, ['--model', 'my-model'], ctx.home);

  const deleted = await runNode(setupPath, ['--delete-model', 'my-model'], ctx.home);

  assert.equal(deleted.code, 0, deleted.stderr);
  assert.match(deleted.stdout, /已回到默认: image-2/);
  const config = ctx.readConfig();
  assert.equal(config.current_model, 'image-2');
  assert.equal(config.custom_models, undefined, '没有自定义模型时应清掉空对象');
});

test('built-in models cannot be deleted', async (t) => {
  const ctx = scaffold(t, BASE_CONFIG);

  const result = await runNode(setupPath, ['--delete-model', 'image-2'], ctx.home);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /内置模型 image-2 不能删除/);
});

test('generate sends the configured model and lets --model override it', async (t) => {
  const ctx = scaffold(t, BASE_CONFIG);
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const bodies = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const generate = (extra = []) => runNode(generatePath, [
    '--prompt', 'a red apple',
    '--api-key', 'test-key',
    '--base-url', baseUrl,
    '--out-dir', outputDir,
    '--no-fallback',
    ...extra,
  ], ctx.home);

  const first = await generate();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(bodies.at(-1).model, 'gpt-image-2', '默认应发 gpt-image-2');

  await runNode(setupPath, ['--model', 'image-2.5-sunburst'], ctx.home);
  const second = await generate();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(bodies.at(-1).model, 'gpt-image-2.5-sunburst', '切换后应跟着变');

  const third = await generate(['--model', 'image-2.5-flare']);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(bodies.at(-1).model, 'gpt-image-2.5-flare');
  assert.equal(ctx.readConfig().current_model, 'image-2.5-sunburst', '--model 不应改动持久化配置');

  const sent = bodies.length;
  const unknown = await generate(['--model', 'image-9']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /未知模型/);
  assert.equal(bodies.length, sent, '未知模型应在发请求之前就失败');

  const ambiguous = await generate(['--model', '2.5']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /对应多个模型/);
  assert.equal(bodies.length, sent);
});

test('generate records the model it used in the run log', async (t) => {
  const ctx = scaffold(t, BASE_CONFIG);
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runNode(generatePath, [
    '--prompt', 'a red apple',
    '--model', 'image-2.5-flare',
    '--api-key', 'test-key',
    '--base-url', `http://127.0.0.1:${server.address().port}/v1`,
    '--out-dir', outputDir,
    '--no-fallback',
  ], ctx.home);

  assert.equal(result.code, 0, result.stderr);

  const runs = fs.readFileSync(path.join(ctx.home, '.oh-coage', 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(runs.at(-1).model, 'gpt-image-2.5-flare');
  assert.equal(runs.at(-1).model_key, 'image-2.5-flare');
  assert.equal(runs.at(-1).model_source, 'key');
});
