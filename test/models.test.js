const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_MODEL_KEY,
  BUILTIN_MODELS,
  buildModelCatalog,
  resolveModel,
  resolveConfiguredModel,
  isBuiltinModelKey,
} = require('../skills/oh-coage/scripts/models');

test('the built-in registry exposes exactly the three requested models', () => {
  assert.deepEqual(
    BUILTIN_MODELS.map((entry) => entry.model),
    ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'],
  );
  assert.equal(DEFAULT_MODEL_KEY, 'image-2');
  assert.equal(resolveModel(undefined, {}).model, 'gpt-image-2', '不带参数时用 image-2，保持历史行为');
});

test('resolveModel accepts short names, raw model IDs, and custom models', () => {
  const custom = { 'my-model': { model: 'vendor-x-1' } };

  assert.equal(resolveModel('image-2', custom).model, 'gpt-image-2');
  assert.equal(resolveModel('image-2.5-sunburst', custom).model, 'gpt-image-2.5-sunburst');
  assert.equal(resolveModel('IMAGE-2.5-FLARE', custom).model, 'gpt-image-2.5-flare');
  assert.equal(resolveModel('gpt-image-2.5-flare', custom).model, 'gpt-image-2.5-flare');
  assert.equal(resolveModel('my-model', custom).model, 'vendor-x-1');
  assert.equal(resolveModel('vendor-x-1', custom).model, 'vendor-x-1');
});

test('resolveModel refuses to guess between the two 2.5 models', () => {
  for (const input of ['2.5', 'image-2.5', 'gpt-image-2.5']) {
    assert.throws(() => resolveModel(input, {}), /对应多个模型/);
    assert.throws(() => resolveModel(input, {}), /image-2\.5-sunburst/);
    assert.throws(() => resolveModel(input, {}), /image-2\.5-flare/);
  }
});

test('resolveModel lists the options when the input is unknown', () => {
  assert.throws(() => resolveModel('image-9', {}), (error) => {
    assert.match(error.message, /未知模型：image-9/);
    assert.match(error.message, /gpt-image-2\.5-sunburst/);
    return true;
  });
});

test('a custom entry cannot shadow a built-in short name', () => {
  const custom = { 'image-2': { model: 'hijacked-model' } };

  assert.equal(buildModelCatalog(custom).find((entry) => entry.key === 'image-2').model, 'gpt-image-2');
  assert.equal(resolveModel('image-2', custom).model, 'gpt-image-2');
});

test('custom entries without a model id are ignored instead of breaking the catalog', () => {
  const catalog = buildModelCatalog({
    broken: {},
    alsoBroken: { label: 'x' },
    ok: { model: 'vendor-ok' },
  });

  assert.deepEqual(
    catalog.map((entry) => entry.key),
    ['image-2', 'image-2.5-sunburst', 'image-2.5-flare', 'ok'],
  );
});

test('resolveConfiguredModel uses current_model and falls back when it is stale', () => {
  assert.equal(resolveConfiguredModel({ current_model: 'image-2.5-flare' }).model, 'gpt-image-2.5-flare');
  assert.equal(resolveConfiguredModel({ current_model: 'image-2.5-flare' }).source, 'config');

  // 自定义模型被删掉之后，配置里可能还留着它的短名
  assert.equal(resolveConfiguredModel({ current_model: 'gone', custom_models: {} }).model, 'gpt-image-2');
  assert.equal(resolveConfiguredModel({ current_model: 'gone' }).source, 'default');

  assert.equal(resolveConfiguredModel(null).model, 'gpt-image-2');
  assert.equal(resolveConfiguredModel(undefined).model, 'gpt-image-2');
});

test('isBuiltinModelKey guards built-in models from deletion', () => {
  assert.equal(isBuiltinModelKey('image-2'), true);
  assert.equal(isBuiltinModelKey('image-2.5-flare'), true);
  assert.equal(isBuiltinModelKey('IMAGE-2.5-SUNBURST'), true);
  assert.equal(isBuiltinModelKey('my-model'), false);
});

test('resolveModel accepts the distinctive suffix of a model name', () => {
  assert.equal(resolveModel('flare', {}).model, 'gpt-image-2.5-flare');
  assert.equal(resolveModel('FLARE', {}).model, 'gpt-image-2.5-flare');
  assert.equal(resolveModel('sunburst', {}).model, 'gpt-image-2.5-sunburst');
  assert.equal(resolveModel('flare', {}).source, 'suffix');

  // 无意义的片段不该被当成后缀匹配
  assert.throws(() => resolveModel('fl', {}), /未知模型/);
  assert.throws(() => resolveModel('5', {}), /未知模型/);
});

test('suffix matching refuses to guess when a custom model makes it ambiguous', () => {
  const custom = { 'my-flare': { model: 'vendor-flare' } };

  assert.throws(() => resolveModel('flare', custom), /匹配到多个模型/);
  assert.throws(() => resolveModel('flare', custom), /my-flare/);
  assert.throws(() => resolveModel('flare', custom), /image-2\.5-flare/);

  // 写全名就还是唯一的
  assert.equal(resolveModel('image-2.5-flare', custom).model, 'gpt-image-2.5-flare');
  assert.equal(resolveModel('my-flare', custom).model, 'vendor-flare');
});
