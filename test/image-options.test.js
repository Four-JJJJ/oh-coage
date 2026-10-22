const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const skillDir = path.join(repoRoot, 'skills', 'oh-coage');
const generatePath = path.join(skillDir, 'scripts', 'generate.js');
const setupPath = path.join(skillDir, 'scripts', 'setup.js');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const {
  buildRequest,
  resolveImageOptions,
  normalizeImageField,
  normalizeImageTransport,
  normalizeImageShape,
  IMAGE_FIELD_SHAPES,
} = require('../skills/oh-coage/scripts/providers');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-coage-img2img-'));
}

function writeTinyPng(filePath) {
  fs.writeFileSync(filePath, Buffer.from(PNG_BASE64, 'base64'));
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
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

// ---- 纯函数：适配项解析 ----

test('image options keep the legacy shape when nothing is configured', () => {
  const resolved = resolveImageOptions({});
  assert.equal(resolved.field, 'image_urls');
  assert.equal(resolved.transport, 'json');
  assert.equal(resolved.shape, 'array');
  assert.equal(resolved.endpoint, '/images/generations');
});

test('multipart defaults to the OpenAI /images/edits contract', () => {
  const resolved = resolveImageOptions({ imageTransport: 'multipart' });
  assert.equal(resolved.field, 'image');
  assert.equal(resolved.transport, 'multipart');
  assert.equal(resolved.endpoint, '/images/edits');
});

test('field names map to their natural value shape', () => {
  // images / reference_images 这类字段天然是对象数组。
  // 内部规范值统一用 IMAGE_FIELD_SHAPES 里的 array-object，
  // 不要再出现 object-array 这第二种拼写（它会让 shapeImageValues 认不出来，
  // 把对象数组静默降级成字符串数组）。
  assert.equal(resolveImageOptions({ imageField: 'images' }).shape, 'array-object');
  assert.equal(resolveImageOptions({ imageField: 'reference_images' }).shape, 'array-object');
  assert.equal(resolveImageOptions({ imageField: 'init_image' }).shape, 'array');
  // 显式指定形状时以用户为准
  assert.equal(resolveImageOptions({ imageField: 'images', imageShape: 'array' }).shape, 'array');
  assert.equal(resolveImageOptions({ imageField: 'images', imageShape: 'array-object' }).shape, 'array-object');
  // 旧拼写仍然作为别名接受，但归一化后必须是 array-object
  assert.equal(resolveImageOptions({ imageField: 'images', imageShape: 'object-array' }).shape, 'array-object');
});

test('every resolved shape is one of the documented IMAGE_FIELD_SHAPES', () => {
  // 形状取值必须收敛到文档里写的那三个，避免内部再冒出第二套拼写
  const shapes = new Set();
  for (const field of ['images', 'image_urls', 'reference_images', 'init_image', 'image']) {
    for (const transport of ['json', 'multipart']) {
      shapes.add(resolveImageOptions({ imageField: field, imageTransport: transport }).shape);
    }
  }
  for (const shape of shapes) {
    assert.ok(
      IMAGE_FIELD_SHAPES.includes(shape),
      `解析出的形状 ${shape} 不在 IMAGE_FIELD_SHAPES(${IMAGE_FIELD_SHAPES.join('/')}) 里`,
    );
  }
});

test('a single-value shape refuses to silently drop extra reference images', () => {
  const references = ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'];

  assert.throws(
    () => buildRequest({
      family: 'openai',
      apiStyle: 'openai',
      model: 'gpt-image-2',
      prompt: 'x',
      imageUrls: references,
      imageOptions: { imageField: 'image_url', imageShape: 'single' },
    }),
    /只传一张参考图|给了 2 张/,
    '两张参考图配 single 形状时应该报错，而不是静默丢掉一张',
  );
});

test('array-object really produces an object array on the wire', () => {
  const references = ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'];
  const spec = buildRequest({
    family: 'openai',
    apiStyle: 'openai',
    model: 'gpt-image-2',
    prompt: 'x',
    imageUrls: references,
    imageOptions: { imageField: 'images', imageShape: 'array-object' },
  });

  assert.deepEqual(spec.body.images, [{ url: references[0] }, { url: references[1] }]);
});

test('image option aliases and custom field names are accepted', () => {
  assert.equal(normalizeImageTransport('form-data'), 'multipart');
  assert.equal(normalizeImageTransport('FORM'), 'multipart');
  assert.equal(normalizeImageShape('list'), 'array');
  assert.equal(normalizeImageShape('array-of-objects'), 'array-object');
  // 站点自定义的字段名原样保留
  assert.equal(normalizeImageField('my_refs'), 'my_refs');
  assert.equal(normalizeImageField('image[]'), 'image[]');
});

test('invalid image options fail loudly instead of sending a broken request', () => {
  assert.throws(() => normalizeImageTransport('carrier-pigeon'), /未知参考图传输方式/);
  assert.throws(() => normalizeImageShape('triangle'), /未知参考图取值形状/);
  assert.throws(() => normalizeImageField('bad field'), /参考图字段名不合法/);
});

test('image endpoint accepts a relative path or a full url', () => {
  assert.equal(resolveImageOptions({ imageEndpoint: 'images/edits' }).endpoint, '/images/edits');
  assert.equal(
    resolveImageOptions({ imageEndpoint: 'https://edit.example.com/v1/edit' }).endpoint,
    'https://edit.example.com/v1/edit',
  );
});

// ---- 请求构造 ----

test('the OpenAI-compatible request puts references into the configured field', () => {
  const references = ['data:image/png;base64,aaa'];

  const legacy = buildRequest({ family: 'openai', model: 'gpt-image-2', prompt: 'x', imageUrls: references, apiKey: 'k' });
  assert.equal(legacy.path, '/images/generations');
  assert.deepEqual(legacy.body.image_urls, references);

  const renamed = buildRequest({
    family: 'openai',
    model: 'gpt-image-2',
    prompt: 'x',
    imageUrls: references,
    imageOptions: { imageField: 'image', imageShape: 'single' },
    apiKey: 'k',
  });
  assert.equal(renamed.body.image, references[0]);
  assert.equal(renamed.body.image_urls, undefined);

  const objects = buildRequest({
    family: 'openai',
    model: 'gpt-image-2',
    prompt: 'x',
    imageUrls: references,
    imageOptions: { imageField: 'images' },
    apiKey: 'k',
  });
  assert.deepEqual(objects.body.images, [{ url: references[0] }]);
});

test('multipart image-to-image switches endpoint and defers the body to the caller', () => {
  const spec = buildRequest({
    family: 'openai',
    model: 'gpt-image-2',
    prompt: 'x',
    imageUrls: ['data:image/png;base64,aaa'],
    imageOptions: { imageTransport: 'multipart' },
    apiKey: 'k',
  });

  assert.equal(spec.path, '/images/edits');
  assert.equal(spec.transport, 'multipart');
  assert.equal(spec.imageField, 'image');
  assert.deepEqual(spec.imageUrls, ['data:image/png;base64,aaa']);
  // 参考图不能同时留在 JSON body 里
  assert.equal(spec.body.image_urls, undefined);
  assert.equal(spec.body.prompt, 'x');
});

test('openai official mode now uses /images/edits for reference images', () => {
  const spec = buildRequest({
    family: 'openai',
    apiStyle: 'official',
    model: 'gpt-image-2',
    prompt: 'x',
    size: '1:1',
    imageUrls: ['data:image/png;base64,aaa'],
    apiKey: 'k',
  });

  assert.equal(spec.path, '/images/edits');
  assert.equal(spec.transport, 'multipart');
  assert.equal(spec.imageField, 'image');
  assert.equal(spec.body.size, '1024x1024');
});

test('explicit image options still win over the openai official default', () => {
  // 用户拿到的是中转站，虽然 api_style=official 但它认 image_urls JSON
  const spec = buildRequest({
    family: 'openai',
    apiStyle: 'official',
    model: 'gpt-image-2',
    prompt: 'x',
    imageUrls: ['data:image/png;base64,aaa'],
    imageOptions: { imageTransport: 'json' },
    apiKey: 'k',
  });

  assert.equal(spec.path, '/images/generations');
  assert.deepEqual(spec.body.image_urls, ['data:image/png;base64,aaa']);
});

// null / 空串不得把 official 的默认盖成空，否则 multipart 会退回 json
test('empty image options do not override the official multipart default', () => {
  const spec = buildRequest({
    family: 'openai',
    apiStyle: 'official',
    model: 'gpt-image-2',
    prompt: 'x',
    imageUrls: ['data:image/png;base64,aaa'],
    imageOptions: { imageTransport: null, imageField: '', imageShape: undefined, imageEndpoint: null },
    apiKey: 'k',
  });

  assert.equal(spec.transport, 'multipart');
  assert.equal(spec.imageField, 'image');
  assert.equal(spec.path, '/images/edits');
});

test('gemini and grok are untouched by the openai official default', () => {
  const gemini = resolveImageOptions({}, { family: 'gemini', apiStyle: 'official' });
  assert.equal(gemini.transport, 'json');
  assert.equal(gemini.field, 'image_urls');

  const grok = resolveImageOptions({}, { family: 'grok', apiStyle: 'official' });
  assert.equal(grok.transport, 'json');
});

test('text-to-image is untouched by image options', () => {
  const spec = buildRequest({
    family: 'openai',
    model: 'gpt-image-2',
    prompt: 'x',
    imageOptions: { imageTransport: 'multipart' },
    apiKey: 'k',
  });

  assert.equal(spec.path, '/images/generations');
  assert.equal(spec.transport, undefined);
});

// ---- 端到端 ----

test('generate sends JSON image-to-image to a custom field and endpoint', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const inputPath = path.join(outputDir, 'input.png');
  writeTinyPng(inputPath);

  const seen = [];
  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/custom/edit') {
      seen.push(JSON.parse((await readBody(req)).toString('utf8')));
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
    active_profile: 'relay',
    current_model: 'image-2',
    profiles: {
      relay: {
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'relay:x',
        image_field: 'image',
        image_shape: 'single',
        image_endpoint: '/custom/edit',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'make it watercolor',
    '--image-url', inputPath,
    '--api-key', 'stub-api-key',
    '--out-dir', outputDir,
    '--no-fallback',
  ], home);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].image, `data:image/png;base64,${PNG_BASE64}`);
  assert.equal(seen[0].image_urls, undefined);
  assert.match(result.stderr, /端点=\/custom\/edit/);
});

test('generate drives the openai official edit contract end to end', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const inputPath = path.join(outputDir, 'photo.png');
  writeTinyPng(inputPath);
  const pngBytes = Buffer.from(PNG_BASE64, 'base64');

  const seen = [];
  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      const raw = await readBody(req);
      seen.push({ contentType: req.headers['content-type'], raw });
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
    active_profile: 'official',
    current_model: 'image-2',
    profiles: {
      official: {
        base_url: server.baseUrl,
        api_style: 'official',
        root_output_dir: outputDir,
        keychain_account: 'official:x',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'make it watercolor',
    '--image-url', inputPath,
    '--size', '1:1',
    '--api-key', 'stub-api-key',
    '--out-dir', outputDir,
    '--no-fallback',
  ], home);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.length, 1);
  assert.match(seen[0].contentType, /^multipart\/form-data; boundary=/);

  const body = seen[0].raw.toString('latin1');
  assert.match(body, /name="prompt"\r\n\r\nmake it watercolor/);
  assert.match(body, /name="size"\r\n\r\n1024x1024/);
  assert.match(body, /name="image"; filename="reference-1\.png"\r\nContent-Type: image\/png/);
  // 图片二进制必须原样出现在 body 里
  assert.ok(seen[0].raw.includes(pngBytes), '参考图字节应原样上传');
  assert.doesNotMatch(body, /data:image\/png;base64/);

  // 提示行要反映官方接口的隐式默认，而不是写成 json
  assert.match(result.stderr, /传输=multipart, 字段=image/);
});

test('generate uploads multipart image-to-image as a real file field', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const inputPath = path.join(outputDir, 'input.png');
  writeTinyPng(inputPath);

  const seen = [];
  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      seen.push({
        contentType: req.headers['content-type'],
        body: (await readBody(req)).toString('latin1'),
      });
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
    active_profile: 'relay',
    current_model: 'image-2',
    profiles: {
      relay: {
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'relay:x',
        image_transport: 'multipart',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'make it watercolor',
    '--image-url', inputPath,
    '--api-key', 'stub-api-key',
    '--out-dir', outputDir,
    '--no-fallback',
  ], home);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.length, 1);
  assert.match(seen[0].contentType, /^multipart\/form-data; boundary=/);

  const { body } = seen[0];
  assert.match(body, /name="prompt"\r\n\r\nmake it watercolor/);
  assert.match(body, /name="image"; filename="reference-1\.png"\r\nContent-Type: image\/png/);
  // 参考图必须以文件内容出现，而不是 data URI 字符串
  assert.doesNotMatch(body, /data:image\/png;base64/);
});

test('multipart refuses remote reference urls with an actionable message', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const server = await startServer(async (req, res) => {
    res.writeHead(500);
    res.end();
  });
  t.after(server.close);

  writeConfig(home, {
    version: 1,
    active_profile: 'relay',
    current_model: 'image-2',
    profiles: {
      relay: {
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'relay:x',
        image_transport: 'multipart',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'x',
    '--image-url', 'https://example.com/photo.jpg',
    '--api-key', 'stub-api-key',
    '--out-dir', outputDir,
    '--no-fallback',
  ], home);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /multipart 图生图只能上传本地图片或 data URI/);
  assert.match(result.stderr, /--image-transport json/);
});

test('--image-transport on the CLI overrides the stored profile value', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const inputPath = path.join(outputDir, 'input.png');
  writeTinyPng(inputPath);

  const seen = [];
  const server = await startServer(async (req, res) => {
    if (req.method === 'POST') {
      seen.push({ url: req.url, contentType: req.headers['content-type'] });
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
    active_profile: 'relay',
    current_model: 'image-2',
    profiles: {
      relay: {
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'relay:x',
        image_transport: 'json',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'x',
    '--image-url', inputPath,
    '--image-transport', 'multipart',
    '--api-key', 'stub-api-key',
    '--out-dir', outputDir,
    '--no-fallback',
  ], home);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen[0].url, '/v1/images/edits');
  assert.match(seen[0].contentType, /^multipart\/form-data/);
});

test('a bad --image-transport value is rejected before any request', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const result = await runNode(generatePath, [
    '--prompt', 'x',
    '--image-transport', 'carrier-pigeon',
    '--api-key', 'k',
    '--base-url', 'https://example.com/v1',
    '--out-dir', outputDir,
  ], home);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /未知参考图传输方式/);
});

test('setup stores and clears per-profile image options', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const init = await runNode(setupPath, [
    '--output-dir', outputDir,
    '--profile', 'relay',
    '--base-url', 'https://example.com/v1',
    '--api-key', 'k',
    '--activate',
  ], home, stub.env);
  assert.equal(init.code, 0, init.stderr);

  const configPath = path.join(outputDir, 'oh-coage-config.json');

  const applied = await runNode(setupPath, [
    '--profile', 'relay',
    '--image-transport', 'multipart',
    '--image-field', 'image',
  ], home, stub.env);
  assert.equal(applied.code, 0, applied.stderr);

  let saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.profiles.relay.image_transport, 'multipart');
  assert.equal(saved.profiles.relay.image_field, 'image');

  const listed = await runNode(setupPath, ['--list'], home, stub.env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /图生图: 端点=\/images\/edits, 传输=multipart, 字段=image/);

  const cleared = await runNode(setupPath, [
    '--profile', 'relay',
    '--clear-image-options',
  ], home, stub.env);
  assert.equal(cleared.code, 0, cleared.stderr);

  saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.profiles.relay.image_transport, undefined);
  assert.equal(saved.profiles.relay.image_field, undefined);
});

test('setup initializes a profile with image options in one call', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const result = await runNode(setupPath, [
    '--output-dir', outputDir,
    '--profile', 'relay',
    '--base-url', 'https://example.com/v1',
    '--api-key', 'k',
    '--image-transport', 'multipart',
    '--activate',
  ], home, stub.env);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /图生图适配: 端点=\/images\/edits/);

  const saved = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json'), 'utf8'));
  assert.equal(saved.profiles.relay.image_transport, 'multipart');
});
