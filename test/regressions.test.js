const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const {
  repoRoot,
  skillScripts,
  setupPath,
  generatePath,
  PNG_BASE64,
  tempDir,
  securityStub,
  startServer,
  runNode,
  writeConfig,
  jsonResponse,
} = require('./helpers');

const {
  buildRequest,
  resolveImageOptions,
  extractTaskImages,
  resolveSizeAndResolution,
  VALID_4K_SIZES,
} = require('../skills/oh-coage/scripts/providers');
const { buildModelCatalog, resolveModel } = require('../skills/oh-coage/scripts/models');

// 兼容旧写法：本文件历史用例用的是 createTempDir / createSecurityStub 这两个名字
const createTempDir = (prefix) => tempDir(null, prefix || 'oh-coage-regress-');
const createSecurityStub = (t) => securityStub(t);

// ---------------------------------------------------------------------------
// 计费安全：下载失败不能重发已付费的生成请求
// ---------------------------------------------------------------------------

test('a failed image download does not re-submit the paid generation request', async (t) => {
  // 站点返回了图片 URL，但那个 URL 指向死端口。
  // 旧行为：下载失败被判成 network 可重试 → 再发一次 POST → 用户被扣两次钱。
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  let generationPosts = 0;
  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      generationPosts += 1;
      // 指向一个必定连不上的地址
      return jsonResponse(res, { data: [{ url: 'http://127.0.0.1:1/dead.png' }] });
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--out-dir', outputDir,
    '--json',
    '--no-fallback',
  ], { home });

  assert.notEqual(result.code, 0, '下载失败时整体应该失败');
  assert.equal(generationPosts, 1, '生成请求只应提交一次，重试会重复计费');
  assert.match(result.stderr, /不会重试提交/);
});

test('a download failure is classified as fallback but not retryable', async () => {
  const previousTestFlag = process.env.OH_COAGE_TEST;
  process.env.OH_COAGE_TEST = '1';
  delete require.cache[require.resolve(generatePath)];
  const generate = require(generatePath);
  if (previousTestFlag === undefined) {
    delete process.env.OH_COAGE_TEST;
  } else {
    process.env.OH_COAGE_TEST = previousTestFlag;
  }

  const error = new Error('图片已生成但下载失败');
  error.fallback = true;
  error.kind = 'download';

  const classification = generate.classifyError(error);
  assert.equal(classification.retryable, false, '不能重试，否则重复计费');
  assert.equal(classification.fallback, true, '但仍应允许换下一个 profile');
});

// ---------------------------------------------------------------------------
// 假成功：非图片响应不能落盘
// ---------------------------------------------------------------------------

test('an HTML error page served as an image is rejected instead of saved', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      return jsonResponse(res, { data: [{ url: `${server.origin}/fake.png` }] });
    }
    if (req.url === '/fake.png') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>rate limited</body></html>');
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--out-dir', outputDir,
    '--json',
    '--no-fallback',
  ], { home });

  assert.notEqual(result.code, 0, 'HTML 错误页不能算生成成功');
  assert.match(result.stderr, /不是有效图片/);

  const leftovers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else leftovers.push(full);
    }
  };
  walk(outputDir);
  const pngLeftovers = leftovers.filter((file) => file.endsWith('.png'));
  assert.deepEqual(pngLeftovers, [], '不应把 HTML 当成 .png 留在磁盘上');
});

test('base64 payloads that are not images are rejected', async () => {
  const previousTestFlag = process.env.OH_COAGE_TEST;
  process.env.OH_COAGE_TEST = '1';
  delete require.cache[require.resolve(generatePath)];
  const generate = require(generatePath);
  if (previousTestFlag === undefined) {
    delete process.env.OH_COAGE_TEST;
  } else {
    process.env.OH_COAGE_TEST = previousTestFlag;
  }

  const dir = createTempDir();
  try {
    await assert.rejects(
      () => generate.saveImage(
        { base64: Buffer.from('<html>not an image</html>').toString('base64') },
        null,
        dir,
        0,
      ),
      /不是有效图片/,
    );
    assert.deepEqual(fs.readdirSync(dir), [], '失败的图片不应留下残文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 密钥安全：跨域端点要明确告警
// ---------------------------------------------------------------------------

test('a cross-origin image endpoint warns that the API key travels with the request', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const inputPath = path.join(outputDir, 'input.png');
  fs.writeFileSync(inputPath, Buffer.from(PNG_BASE64, 'base64'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const seenAuth = [];
  const server = await startServer((req, res) => {
    seenAuth.push({ url: req.url, auth: req.headers.authorization });
    jsonResponse(res, { data: [{ url: `${server.origin}/ok.png` }] });
  });
  t.after(() => server.close());

  // base_url 指向一个不同端口的地址，模拟「endpoint 被指到别的域名」
  const otherServer = await startServer((req, res) => {
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => otherServer.close());

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--image-url', inputPath,
    '--image-endpoint', `${server.origin}/collect`,
    '--api-key', 'stub-key',
    '--base-url', otherServer.baseUrl,
    '--out-dir', outputDir,
    '--json',
    '--no-fallback',
  ], { home });

  assert.match(result.stderr, /与 profile 的 base_url .* 不同/, '跨域端点必须告警');
  assert.match(result.stderr, /API Key 会一并发送到该地址/);

  const collectHit = seenAuth.find((entry) => entry.url === '/collect');
  assert.ok(collectHit, '请求确实发到了跨域端点');
  assert.match(String(collectHit.auth), /Bearer stub-key/);
});

// ---------------------------------------------------------------------------
// 配置健壮性：元数据不能被当成模型名
// ---------------------------------------------------------------------------

test('a fresh config does not leak metadata keys into the model catalog', () => {
  // 旧行为：全新配置（还没有 custom_models 键）会把整个 config 当成模型表，
  // 于是 `setup.js --model created_at` 能把 current_model 写成时间戳，永久写坏配置。
  const freshConfig = {
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    active_profile: 'main',
    current_model: 'image-2',
    profiles: { main: {} },
  };

  const keys = buildModelCatalog(freshConfig).map((entry) => entry.key);
  assert.ok(!keys.includes('created_at'), 'created_at 不应出现在模型目录里');
  assert.ok(!keys.includes('active_profile'), 'active_profile 不应出现在模型目录里');
  assert.ok(!keys.includes('current_model'), 'current_model 不应出现在模型目录里');

  assert.throws(() => resolveModel('created_at', freshConfig, 'openai'), /未知模型/);
});

test('a bare custom-model map still works as a model catalog', () => {
  const keys = buildModelCatalog({ mymodel: { model: 'vendor-model-1' } }).map((entry) => entry.key);
  assert.ok(keys.includes('mymodel'), '裸的 custom_models 映射仍应被正确解析');
});

test('setup --model rejects config metadata instead of poisoning current_model', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const configPath = writeConfig(home, {
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        api_style: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: outputDir,
        keychain_account: 'main:x',
      },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--model', 'created_at'], { home, env: stub.env });

  assert.notEqual(result.code, 0, '元数据键不能被当成模型接受');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.current_model, 'image-2', 'current_model 不应被写坏');
});

// ---------------------------------------------------------------------------
// 异步任务：多图不能丢
// ---------------------------------------------------------------------------

test('async tasks keep every generated image, not just the first', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      return jsonResponse(res, { request_id: 'task-multi' });
    }
    if (req.url.includes('/tasks/')) {
      return jsonResponse(res, {
        data: {
          status: 'completed',
          result: {
            images: [
              { url: `${server.origin}/1.png` },
              { url: `${server.origin}/2.png` },
              { url: `${server.origin}/3.png` },
            ],
          },
        },
      });
    }
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_BASE64, 'base64'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--n', '3',
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--out-dir', outputDir,
    '--json',
    '--no-fallback',
  ], { home });

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.images.length, 3, '异步任务返回三张图时，三张都要落盘');
});

test('extractTaskImages handles flat and nested payload shapes', () => {
  assert.equal(extractTaskImages({ status: 'done', result: { images: [{ url: 'a' }, { url: 'b' }] } }).length, 2);
  assert.equal(extractTaskImages({ status: 'done', result: { data: [{ b64_json: 'x' }] } }).length, 1);
  assert.equal(extractTaskImages({ status: 'done', images: [{ url: 'c' }] }).length, 1);
  // 少数站点把单张图直接铺在顶层
  assert.equal(extractTaskImages({ status: 'done', url: 'd' }).length, 1);
  assert.equal(extractTaskImages({ status: 'done' }).length, 0);
});

// ---------------------------------------------------------------------------
// 图生图：形状拼写与静默丢弃
// ---------------------------------------------------------------------------

test('image shapes stay within the documented vocabulary', () => {
  // 旧行为：内部同时存在 array-object 和 object-array 两种拼写，
  // 导致显式传 array-object 时被静默降级成字符串数组。
  const cases = [
    { imageField: 'images' },
    { imageField: 'images', imageShape: 'array-object' },
    { imageField: 'images', imageShape: 'object-array' },
    { imageField: 'image_urls' },
    { imageField: 'init_image' },
  ];

  for (const input of cases) {
    const shape = resolveImageOptions(input).shape;
    assert.ok(
      ['array', 'array-object', 'single'].includes(shape),
      `${JSON.stringify(input)} 解析出非规范形状 ${shape}`,
    );
  }
});

test('single shape with multiple references fails loudly', () => {
  assert.throws(
    () => buildRequest({
      family: 'openai',
      apiStyle: 'openai',
      model: 'gpt-image-2',
      prompt: 'x',
      imageUrls: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
      imageOptions: { imageField: 'image_url', imageShape: 'single' },
    }),
    /只传一张参考图|给了 2 张/,
  );
});

// ---------------------------------------------------------------------------
// 参数校验：4K 降级与非法取值
// ---------------------------------------------------------------------------

test('4K with an unsupported aspect ratio downgrades to 2k and says so', () => {
  const warnings = [];
  const spec = buildRequest({
    family: 'openai',
    apiStyle: 'openai',
    model: 'gpt-image-2',
    prompt: 'x',
    size: '1:1',
    resolution: '4k',
    warn: (message) => warnings.push(message),
  });

  assert.equal(spec.body.resolution, '2k', '1:1 不支持 4K，应降级到 2k');
  assert.equal(spec.body.size, '1:1');
  assert.equal(warnings.length, 1, '降级必须告知用户');
  assert.match(warnings[0], /降级到 2k/);
});

test('4K with a supported ratio is left alone', () => {
  for (const size of VALID_4K_SIZES) {
    const { resolution } = resolveSizeAndResolution(size, '4k');
    assert.equal(resolution, '4k', `${size} 应保留 4K`);
  }
});

test('bogus size and resolution values are rejected instead of passed through', () => {
  assert.throws(() => resolveSizeAndResolution('totally-bogus', '2k'), /size 不支持/);
  assert.throws(() => resolveSizeAndResolution('1:1', '99k'), /resolution 不支持/);
  // 像素值属于官方接口，兼容接口应提示换协议
  assert.throws(() => resolveSizeAndResolution('1024x1024', '2k'), /改用 --api official/);
});

// ---------------------------------------------------------------------------
// 命令编排：sync-models 与初始化可以同用
// ---------------------------------------------------------------------------

test('--sync-models combined with init creates the profile first', async (t) => {
  // README 承诺「--sync-models 也可与初始化命令一起用」。
  // 旧行为：早返回让 requireConfig() 先失败，profile 根本没建出来。
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const server = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      return jsonResponse(res, { data: [{ id: 'gpt-image-9' }] });
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const result = await runNode(setupPath, [
    '--profile', 'brandnew',
    '--base-url', server.baseUrl,
    '--api-key', 'stub-key',
    '--output-dir', outputDir,
    '--sync-models',
  ], { home, env: stub.env });

  assert.equal(result.code, 0, result.stderr);

  const config = JSON.parse(fs.readFileSync(path.join(outputDir, 'oh-coage-config.json'), 'utf8'));
  assert.ok(config.profiles.brandnew, 'profile 应该先被创建出来');
  assert.deepEqual(config.profiles.brandnew.synced_models, ['gpt-image-9']);
});

test('--list-models shows models pulled by --sync-models', async (t) => {
  // 旧行为：listModels 只传 config.custom_models，discovered_models 被丢掉，
  // 用户以为拉取没成功。
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  writeConfig(home, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        api_style: 'openai',
        base_url: 'https://img.example/v1',
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        synced_models: ['gpt-image-9'],
      },
    },
    discovered_models: {
      'gpt-image-9': { model: 'gpt-image-9', family: 'openai' },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--list-models'], { home, env: stub.env });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /gpt-image-9/, '拉取到的模型应出现在 --list-models 里');
});

test('a model pulled by --sync-models is usable through generate --model', async (t) => {
  // 文档承诺「拉取后就能直接 --model <拉到的ID> 使用」。
  // 旧行为：generate.js 传的是 config.custom_models，discovered_models 查不到。
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  let seenModel = null;
  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seenModel = JSON.parse(body).model;
        jsonResponse(res, { data: [{ url: `${server.origin}/ok.png` }] });
      });
      return;
    }
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_BASE64, 'base64'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  writeConfig(home, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: {
        family: 'openai',
        api_style: 'openai',
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'main:x',
        synced_models: ['gpt-image-9'],
      },
    },
    discovered_models: {
      'gpt-image-9': { model: 'gpt-image-9', family: 'openai' },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--model', 'gpt-image-9',
    '--out-dir', outputDir,
    '--json',
    '--no-fallback',
  ], { home, env: stub.env });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(seenModel, 'gpt-image-9', '拉取到的模型应能直接用于 --model');
});

// ---------------------------------------------------------------------------
// 并发与文件权限
// ---------------------------------------------------------------------------

test('two runs started in the same second do not overwrite each other', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      return jsonResponse(res, { data: [{ url: `${server.origin}/ok.png` }] });
    }
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_BASE64, 'base64'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const args = (prompt) => [
    '--prompt', prompt,
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--out-dir', outputDir,
    '--json',
    '--no-fallback',
  ];

  await Promise.all([
    runNode(generatePath, args('run-A'), { home }),
    runNode(generatePath, args('run-B'), { home }),
  ]);

  const metaFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'meta.json') metaFiles.push(full);
    }
  };
  walk(outputDir);

  assert.equal(metaFiles.length, 2, '两次并发 run 应各自拥有独立目录，而不是互相覆盖');
  const prompts = metaFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).prompt).sort();
  assert.deepEqual(prompts, ['run-A', 'run-B']);
});

test('the app directory files are private (0600)', async (t) => {
  const home = createTempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', [
      `const store = require(${JSON.stringify(path.join(skillScripts, 'config-store.js'))});`,
      'store.saveState({ config_path: "/tmp/x.json" });',
      'store.appendJsonl(store.RUNS_PATH, { status: "success", prompt: "secret prompt" });',
    ].join('\n')], {
      env: { ...process.env, HOME: home },
      stdio: 'ignore',
    });
    child.on('close', resolve);
  });

  // 目录本身 0700，里面的文件也要 0600——runs.jsonl 存的是完整 prompt
  assert.equal(fs.statSync(path.join(home, '.oh-coage')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, '.oh-coage', 'runs.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, '.oh-coage', 'state.json')).mode & 0o777, 0o600);
});

test('concurrent config writes do not lose updates', async (t) => {
  const dir = createTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, 'oh-coage-config.json');
  const store = require(path.join(skillScripts, 'config-store.js'));

  fs.writeFileSync(configPath, JSON.stringify({ version: 1, profiles: { a: {}, b: {} } }));

  // 两次独立的读-改-写，各自加锁，最终两份修改都应在
  const first = store.loadConfigFromPath(configPath);
  first.profiles.a.marker = 'A';
  store.saveConfig(configPath, first);

  const second = store.loadConfigFromPath(configPath);
  second.profiles.b.marker = 'B';
  store.saveConfig(configPath, second);

  const after = store.loadConfigFromPath(configPath);
  assert.equal(after.profiles.a.marker, 'A');
  assert.equal(after.profiles.b.marker, 'B');
  assert.equal(fs.existsSync(`${configPath}.lock`), false, '锁文件应被释放');
});

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

test('profile names with path separators are rejected', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const result = await runNode(setupPath, [
    '--profile', '../../evil',
    '--base-url', 'https://img.example/v1',
    '--api-key', 'stub-key',
    '--output-dir', outputDir,
  ], { home, env: stub.env });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /profile 名称不合法/);
});

test('--output without an extension gets the real image extension', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      return jsonResponse(res, { data: [{ url: `${server.origin}/ok.png` }] });
    }
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_BASE64, 'base64'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const target = path.join(outputDir, 'noext');
  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--output', target,
    '--json',
    '--no-fallback',
  ], { home });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(`${target}.png`), '没写扩展名时应自动补上 .png');
});

// ---------------------------------------------------------------------------
// 静默错误：这些是变异测试里「改了代码测试仍然全绿」的盲区
// ---------------------------------------------------------------------------

test('a profile with a malformed image_field is skipped instead of killing the run', async (t) => {
  // 旧行为：describeImageOptions 在构造 attempt 时就抛错（在 try 之外），
  // 整个 fallback 链被拖垮，健康的 profile 一次都没被尝试。
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  const inputPath = path.join(outputDir, 'input.png');
  fs.writeFileSync(inputPath, Buffer.from(PNG_BASE64, 'base64'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const bodies = [];
  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        bodies.push(body);
        jsonResponse(res, { data: [{ url: `${server.origin}/ok.png` }] });
      });
      return;
    }
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_BASE64, 'base64'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  writeConfig(home, {
    version: 1,
    active_profile: 'broken',
    current_model: 'image-2',
    profiles: {
      broken: {
        family: 'openai',
        api_style: 'openai',
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'broken:1',
        image_field: 'bad field with spaces',
      },
      good: {
        family: 'openai',
        api_style: 'openai',
        base_url: server.baseUrl,
        root_output_dir: outputDir,
        keychain_account: 'good:2',
      },
    },
  }, outputDir);

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--image-url', inputPath,
    '--out-dir', outputDir,
    '--json',
  ], { home, env: stub.env });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /跳过 profile=broken/, '应跳过坏 profile 并提示');
  assert.equal(bodies.length, 1, '健康的 profile 应该被尝试');
});

test('a non-idempotent submit is not retried when the connection is reset', async (t) => {
  // 服务端收到 POST 后立刻断开：请求可能已经被收下并计费。
  // 旧行为：判为 network 可重试 → 重发 → 重复扣费。
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  let posts = 0;
  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      posts += 1;
      req.socket.destroy();
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--out-dir', outputDir,
    '--no-fallback',
  ], { home, env: { OH_COAGE_RETRY_DELAY_MS: '0' } });

  assert.notEqual(result.code, 0);
  assert.equal(posts, 1, '连接被重置时不应重发非幂等的生成请求（会重复计费）');
});

test('a server-side 5xx on submit is still retried (it did not do the work)', async (t) => {
  // 服务端明确回了 5xx，说明它知道自己失败、没产出图片，重试是安全的。
  // 这条用例防止「为了防重复计费把重试全关掉」的过度修正。
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  let posts = 0;
  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      posts += 1;
      if (posts === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'busy' }));
      }
      return jsonResponse(res, { data: [{ url: `${server.origin}/ok.png` }] });
    }
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_BASE64, 'base64'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--out-dir', outputDir,
    '--no-fallback',
  ], { home, env: { OH_COAGE_RETRY_DELAY_MS: '0' } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(posts, 2, '明确失败的 5xx 应重试一次');
});

test('gemini endpoint base url is rewritten between official and compatible paths', () => {
  const { resolveEndpointBaseUrl } = require('../skills/oh-coage/scripts/providers');

  // 同一站点两种协议的路径不同，用户切协议时不该手改 base_url
  assert.equal(
    resolveEndpointBaseUrl({
      family: 'gemini',
      apiStyle: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    }),
    'https://generativelanguage.googleapis.com/v1beta/openai',
  );
  assert.equal(
    resolveEndpointBaseUrl({
      family: 'gemini',
      apiStyle: 'official',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }),
    'https://generativelanguage.googleapis.com/v1beta',
  );
  // 非 gemini 族不改写
  assert.equal(
    resolveEndpointBaseUrl({ family: 'openai', apiStyle: 'official', baseUrl: 'https://api.openai.com/v1' }),
    'https://api.openai.com/v1',
  );
});

test('multiple images with --output get numbered filenames', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const server = await startServer((req, res) => {
    if (req.url.includes('/images/generations')) {
      return jsonResponse(res, {
        data: [
          { url: `${server.origin}/1.png` },
          { url: `${server.origin}/2.png` },
          { url: `${server.origin}/3.png` },
        ],
      });
    }
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_BASE64, 'base64'));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const target = path.join(outputDir, 'pic.png');
  const result = await runNode(generatePath, [
    '--prompt', 'cat',
    '--n', '3',
    '--api-key', 'stub-key',
    '--base-url', server.baseUrl,
    '--output', target,
    '--json',
    '--no-fallback',
  ], { home });

  assert.equal(result.code, 0, result.stderr);
  for (const name of ['pic.png', 'pic-2.png', 'pic-3.png']) {
    assert.ok(fs.existsSync(path.join(outputDir, name)), `应生成 ${name}`);
  }
});

test('profile priority controls the fallback order', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  // stub 对所有 profile 返回同一个 key，所以用 base_url 的路径区分是哪个 profile
  const order = [];
  const server = await startServer((req, res) => {
    const match = req.url.match(/^\/([a-z]+)\/v1\/images\/generations/);
    if (match) {
      order.push(match[1]);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'down' }));
    }
    res.writeHead(404);
    res.end('nope');
  });
  t.after(() => server.close());

  const profileBase = (name) => `${server.origin}/${name}/v1`;
  writeConfig(home, {
    version: 1,
    active_profile: 'mid',
    current_model: 'image-2',
    profiles: {
      // 名字故意与 priority 逆序：否则 priority 失效时会退化成按名字排序，
      // 结果恰好一样，变异测试就抓不到了。
      aaa: { family: 'openai', api_style: 'openai', base_url: profileBase('aaa'), root_output_dir: outputDir, keychain_account: 'aaa:1', priority: 30 },
      zzz: { family: 'openai', api_style: 'openai', base_url: profileBase('zzz'), root_output_dir: outputDir, keychain_account: 'zzz:2', priority: 10 },
      mid: { family: 'openai', api_style: 'openai', base_url: profileBase('mid'), root_output_dir: outputDir, keychain_account: 'mid:3', priority: 20 },
    },
  }, outputDir);

  // --no-fallback：只跑第一个候选（active profile 优先于 priority），
  // 但同一 profile 上的 5xx 仍会退避重试一次，所以是 2 次请求、1 个 profile。
  await runNode(generatePath, [
    '--prompt', 'cat',
    '--out-dir', outputDir,
    '--no-fallback',
  ], { home, env: { ...stub.env, OH_COAGE_RETRY_DELAY_MS: '0' } });

  assert.equal(order.length, 2, '--no-fallback 下只尝试一个 profile（含一次重试）');

  // 不禁用 fallback：三个 profile 各尝试 2 次（1 次 + 1 次重试），
  // 且顺序必须是 active(mid) -> priority 10(first) -> priority 30(last)。
  order.length = 0;
  await runNode(generatePath, [
    '--prompt', 'cat',
    '--out-dir', outputDir,
  ], { home, env: { ...stub.env, OH_COAGE_RETRY_DELAY_MS: '0' } });

  assert.equal(order.length, 6, '不禁用 fallback 时应依次尝试三个 profile');

  // 每个 profile 各出现两次（一次原始 + 一次重试），
  // 顺序应为 active(mid) -> priority 10(first) -> priority 30(last)
  assert.deepEqual(
    [order[0], order[2], order[4]],
    ['mid', 'zzz', 'aaa'],
    `fallback 顺序应为 active -> priority 10(zzz) -> priority 30(aaa)，实际 ${order.join(',')}`,
  );
});

test('no test writes a config file into the repository root', () => {
  // 守卫用例：setup.js 不带 --output-dir 时会用 process.cwd() 推导目录。
  // 如果某个测试忘了把 cwd 指向临时目录，就会把 oh-coage-config.json 写进仓库根，
  // 覆盖开发者本机的真实配置（该文件被 .gitignore 忽略，git 层面完全无感）。
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'oh-coage-config.json')),
    false,
    '测试不应把配置文件写进仓库根目录',
  );
});

// ---------------------------------------------------------------------------
// profile 管理子命令（变异测试发现这几条改动不会被任何用例发现）
// ---------------------------------------------------------------------------

test('--activate-profile persists the switch to disk', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const configPath = writeConfig(home, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: { family: 'openai', base_url: 'https://a.example/v1', root_output_dir: outputDir, keychain_account: 'main:1' },
      backup: { family: 'openai', base_url: 'https://b.example/v1', root_output_dir: outputDir, keychain_account: 'backup:2' },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--activate-profile', 'backup'], { home, env: stub.env });
  assert.equal(result.code, 0, result.stderr);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.active_profile, 'backup', '切换结果必须落盘，否则下次运行又回到旧 profile');
});

test('--rename-profile refuses to overwrite an existing profile', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  writeConfig(home, {
    version: 1,
    active_profile: 'a',
    current_model: 'image-2',
    profiles: {
      a: { family: 'openai', base_url: 'https://a.example/v1', root_output_dir: outputDir, keychain_account: 'a:1' },
      b: { family: 'openai', base_url: 'https://b.example/v1', root_output_dir: outputDir, keychain_account: 'b:2' },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--rename-profile', 'a', '--to', 'b'], { home, env: stub.env });

  assert.notEqual(result.code, 0, '目标名已存在时必须拒绝，否则会静默覆盖另一个 profile');
  assert.match(result.stderr, /已存在/);
});

test('--rename-profile migrates the profile and its active flag', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const configPath = writeConfig(home, {
    version: 1,
    active_profile: 'old',
    current_model: 'image-2',
    profiles: {
      old: { family: 'openai', base_url: 'https://a.example/v1', root_output_dir: outputDir, keychain_account: 'old:1' },
      other: { family: 'openai', base_url: 'https://b.example/v1', root_output_dir: outputDir, keychain_account: 'other:2' },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--rename-profile', 'old', '--to', 'renamed'], { home, env: stub.env });
  assert.equal(result.code, 0, result.stderr);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(saved.profiles.renamed, '新名字应存在');
  assert.equal(saved.profiles.old, undefined, '旧名字应被移除');
  assert.equal(saved.active_profile, 'renamed', 'active 标记应跟着改名');
  assert.equal(saved.profiles.renamed.base_url, 'https://a.example/v1', '配置内容应保留');
});

test('--delete-profile removes the profile and repoints the active one', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const configPath = writeConfig(home, {
    version: 1,
    active_profile: 'main',
    current_model: 'image-2',
    profiles: {
      main: { family: 'openai', base_url: 'https://a.example/v1', root_output_dir: outputDir, keychain_account: 'main:1' },
      spare: { family: 'openai', base_url: 'https://b.example/v1', root_output_dir: outputDir, keychain_account: 'spare:2' },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--delete-profile', 'main'], { home, env: stub.env });
  assert.equal(result.code, 0, result.stderr);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.profiles.main, undefined);
  assert.equal(saved.active_profile, 'spare', '删掉 active profile 后应自动指向剩下的一个');
});

test('the last remaining profile cannot be deleted', async (t) => {
  const home = createTempDir();
  const outputDir = createTempDir();
  const stub = createSecurityStub(t);
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  writeConfig(home, {
    version: 1,
    active_profile: 'only',
    current_model: 'image-2',
    profiles: {
      only: { family: 'openai', base_url: 'https://a.example/v1', root_output_dir: outputDir, keychain_account: 'only:1' },
    },
  }, outputDir);

  const result = await runNode(setupPath, ['--delete-profile', 'only'], { home, env: stub.env });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /最后一个 profile/);
});
