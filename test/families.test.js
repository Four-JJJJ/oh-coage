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

const {
  normalizeFamily,
  normalizeApiStyle,
  defaultBaseUrl,
  buildRequest,
  extractImages,
  modelEntriesFromList,
  modelLooksLike,
} = require('../skills/oh-coage/scripts/providers');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-family-'));
}

function writeConfig(home, config, outputDir) {
  const configPath = path.join(outputDir, 'oh-coage-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  fs.mkdirSync(path.join(home, '.oh-coage'), { recursive: true });
  fs.writeFileSync(path.join(home, '.oh-coage', 'state.json'), JSON.stringify({ config_path: configPath }));
  return configPath;
}

function createSecurityStub(t) {
  const binDir = createTempDir();
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));

  const stubPath = path.join(binDir, 'security');
  fs.writeFileSync(stubPath, [
    '#!/bin/bash',
    'case "$1" in',
    '  add-generic-password) cat > /dev/null; exit 0 ;;',
    '  find-generic-password) echo "stub-api-key"; exit 0 ;;',
    '  delete-generic-password) exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(stubPath, 0o755);

  return { binDir, env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } };
}

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

test('the default API style is openai for every model family', () => {
  for (const family of ['openai', 'gemini', 'grok']) {
    assert.equal(normalizeApiStyle(undefined, family), 'openai', `${family} 默认应走 OpenAI 兼容接口`);
  }

  // 常见别名都要落到正确族
  assert.equal(normalizeFamily('banana'), 'gemini');
  assert.equal(normalizeFamily('nano-banana'), 'gemini');
  assert.equal(normalizeFamily('xai'), 'grok');
  assert.equal(normalizeFamily('image'), 'openai');

  assert.equal(defaultBaseUrl('gemini', 'openai'), 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(defaultBaseUrl('gemini', 'official'), 'https://generativelanguage.googleapis.com/v1beta');
});

test('gemini and grok models default to the OpenAI-compatible request shape', () => {
  const params = {
    model: 'gemini-nano-banana-2.1',
    prompt: 'a cat',
    size: '16:9',
    resolution: '2k',
    apiKey: 'k',
  };

  const geminiDefault = buildRequest({ family: 'gemini', ...params });
  assert.equal(geminiDefault.path, '/images/generations');
  assert.equal(geminiDefault.body.model, 'gemini-nano-banana-2.1');
  assert.equal(geminiDefault.body.size, '16:9');
  assert.equal(geminiDefault.body.resolution, '2k');
  assert.equal(geminiDefault.headers.Authorization, 'Bearer k');

  const grokDefault = buildRequest({ family: 'grok', ...params, model: 'grok-imagine-image-2.0' });
  assert.equal(grokDefault.path, '/images/generations');
  assert.equal(grokDefault.body.model, 'grok-imagine-image-2.0');
  assert.equal(grokDefault.body.resolution, '2k');
});

test('official mode switches to each vendor native protocol', () => {
  const gemini = buildRequest({
    family: 'gemini',
    apiStyle: 'official',
    model: 'gemini-nano-banana-2.1',
    prompt: 'a cat',
    size: '16:9',
    imageSize: '2K',
    apiKey: 'k',
  });
  assert.equal(gemini.path, '/interactions');
  assert.equal(gemini.headers['x-goog-api-key'], 'k');
  assert.deepEqual(gemini.body.response_format, { type: 'image', aspect_ratio: '16:9', image_size: '2K' });
  assert.equal(gemini.body.model, 'gemini-nano-banana-2.1');

  const grok = buildRequest({
    family: 'grok',
    apiStyle: 'official',
    model: 'grok-imagine-image-2.0',
    prompt: 'a cat',
    size: '16:9',
    resolution: '2k',
    apiKey: 'k',
  });
  assert.equal(grok.path, '/images/generations');
  assert.equal(grok.body.aspect_ratio, '16:9');
  assert.equal(grok.body.resolution, '2k');

  const openai = buildRequest({
    family: 'openai',
    apiStyle: 'official',
    model: 'gpt-image-2',
    prompt: 'a cat',
    size: '1:1',
    apiKey: 'k',
  });
  assert.equal(openai.body.size, '1024x1024');
});

test('official mode rejects parameters the vendor does not support', () => {
  assert.throws(
    () => buildRequest({
      family: 'grok',
      apiStyle: 'official',
      model: 'grok-imagine-image-2.0',
      prompt: 'x',
      style: 'vivid',
      apiKey: 'k',
    }),
    /Grok 官方接口 不接受参数：style/,
  );

  assert.throws(
    () => buildRequest({
      family: 'gemini',
      apiStyle: 'official',
      model: 'gemini-nano-banana-2.1',
      prompt: 'x',
      responseFormat: 'url',
      apiKey: 'k',
    }),
    /Gemini 官方接口 不接受参数：responseFormat/,
  );
});

test('gemini official responses are read from steps[].content[]', () => {
  const payload = {
    steps: [
      { type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: PNG_BASE64 }] },
    ],
  };

  const extracted = extractImages({ family: 'gemini', apiStyle: 'official' }, payload);
  assert.equal(extracted.mode, 'sync');
  assert.equal(extracted.images.length, 1);
  assert.equal(extracted.images[0].base64, PNG_BASE64);
  assert.equal(extracted.images[0].mimeType, 'image/png');
});

test('multi-image responses keep every result', () => {
  const payload = {
    data: [
      { b64_json: 'aaa' },
      { b64_json: 'bbb' },
    ],
  };

  const extracted = extractImages({ family: 'grok', apiStyle: 'openai' }, payload);
  assert.equal(extracted.images.length, 2);
  assert.deepEqual(extracted.images.map((image) => image.base64), ['aaa', 'bbb']);
});

test('model list filtering keeps only image models of that family', () => {
  assert.equal(modelLooksLike('gemini', 'gemini-3-pro-image'), true);
  assert.equal(modelLooksLike('gemini', 'gemini-3.8-flash'), false);
  assert.equal(modelLooksLike('grok', 'grok-imagine-image-2.0'), true);
  assert.equal(modelLooksLike('grok', 'grok-4'), false);
  assert.equal(modelLooksLike('openai', 'gpt-image-2'), true);

  const entries = modelEntriesFromList('gemini', {
    models: [
      { name: 'models/gemini-3-pro-image' },
      { name: 'models/gemini-3.8-flash' },
      { name: 'models/gemini-nano-banana-2.1' },
    ],
  });

  assert.deepEqual(entries.map((entry) => entry.model), ['gemini-3-pro-image', 'gemini-nano-banana-2.1']);
});

test('generate sends gemini models through the OpenAI-compatible endpoint by default', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const bodies = [];
  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      bodies.push(await readJsonBody(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(server.close);

  writeConfig(home, {
    version: 1,
    active_profile: 'banana',
    current_model: 'banana-2.1',
    profiles: {
      banana: {
        family: 'gemini',
        // 不写 api_style：必须默认走 OpenAI 兼容接口
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'banana:x',
        model: 'banana-2.1',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'a banana',
    '--api-key', 'stub-api-key',
    '--out-dir', outputDir,
    '--no-fallback',
  ], home);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, 'gemini-nano-banana-2.1');
  assert.equal(bodies[0].size, '1:1');
  assert.equal(bodies[0].resolution, '2k');
  assert.match(result.stderr, /OpenAI 兼容接口/);
});

test('generate uses the native protocol only when api_style is official', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const seen = [];
  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/interactions') {
      seen.push({ path: req.url, body: await readJsonBody(req), key: req.headers['x-goog-api-key'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: PNG_BASE64 }] }],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(server.close);

  writeConfig(home, {
    version: 1,
    active_profile: 'banana',
    current_model: 'banana-2.1',
    profiles: {
      banana: {
        family: 'gemini',
        api_style: 'official',
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'banana:x',
        model: 'banana-2.1',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'a banana',
    '--api-key', 'stub-api-key',
    '--size', '16:9',
    '--image-size', '2K',
    '--out-dir', outputDir,
    '--no-fallback',
  ], home);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/v1/interactions');
  assert.equal(seen[0].key, 'stub-api-key');
  assert.deepEqual(seen[0].body.response_format, { type: 'image', aspect_ratio: '16:9', image_size: '2K' });
});

test('--family that no profile provides is refused clearly instead of hitting the wrong endpoint', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  writeConfig(home, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        base_url: 'http://127.0.0.1:9/v1',
        root_output_dir: outputDir,
        keychain_account: 'main:x',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'x',
    '--family', 'gemini',
    '--no-fallback',
  ], home, stub.env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /没有匹配 family=gemini/);
});

test('setup --sync-models pulls models with the profile URL and key', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  let seenAuth = null;
  const server = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'grok-imagine-image-2.0' },
          { id: 'grok-4' },
          { id: 'grok-imagine-image-1.5' },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(server.close);

  writeConfig(home, {
    version: 1,
    active_profile: 'x',
    current_model: 'grok-imagine-2',
    profiles: {
      x: {
        family: 'grok',
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'x:y',
        model: 'grok-imagine-2',
      },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--sync-models'], home, stub.env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(seenAuth, 'Bearer stub-api-key');
  assert.match(result.stdout, /grok-imagine-image-2\.0/);
  assert.doesNotMatch(result.stdout, /grok-4/);

  const saved = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json'), 'utf8'));
  assert.deepEqual(saved.profiles.x.synced_models, ['grok-imagine-image-2.0', 'grok-imagine-image-1.5']);
});

test('setup --model resolves family short names against the active profile family', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const init = await runNode(setupPath, [
    '--output-dir', outputDir,
    '--profile', 'banana',
    '--family', 'gemini',
    '--base-url', 'https://example.com/v1beta/openai',
    '--api-key', 'k',
    '--activate',
  ], home, stub.env);
  assert.equal(init.code, 0, init.stderr);

  // 这一步以前会报「未知模型：banana-pro」，因为 switchModel 没带 family
  const switched = await runNode(setupPath, ['--model', 'banana-pro'], home, stub.env);
  assert.equal(switched.code, 0, switched.stderr);
  assert.match(switched.stdout, /gemini-3-pro-image/);

  const saved = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json'), 'utf8'));
  assert.equal(saved.current_model, 'banana-pro');
});

test('setup stores family and api style, defaulting both to openai', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const result = await runNode(setupPath, [
    '--output-dir', outputDir,
    '--profile', 'banana',
    '--family', 'gemini',
    '--base-url', 'https://example.com/v1',
    '--api-key', 'k',
    '--activate',
  ], home, stub.env);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /gemini \/ OpenAI 兼容接口/);

  const saved = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json'), 'utf8'));
  assert.equal(saved.profiles.banana.family, 'gemini');
  assert.equal(saved.profiles.banana.api_style, 'openai');
});
