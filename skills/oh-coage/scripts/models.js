/**
 * oh-coage 可用模型注册表。
 *
 * 内置三个模型；用户在配置文件里可以追加自定义模型（custom_models）。
 * 这里只负责「短名 / 原始 model ID -> 实际发给接口的 model 字符串」的解析，
 * 不做任何网络请求。
 */

const DEFAULT_MODEL_KEY = 'image-2';

const BUILTIN_MODELS = [
  { key: 'image-2', model: 'gpt-image-2' },
  { key: 'image-2.5-sunburst', model: 'gpt-image-2.5-sunburst' },
  { key: 'image-2.5-flare', model: 'gpt-image-2.5-flare' },
];

// 用户只说「2.5」时对应两个模型，不能替他瞎猜（两者可能计费/效果不同）
const AMBIGUOUS_MODEL_INPUTS = new Map([
  ['2.5', ['image-2.5-sunburst', 'image-2.5-flare']],
  ['image-2.5', ['image-2.5-sunburst', 'image-2.5-flare']],
  ['gpt-image-2.5', ['image-2.5-sunburst', 'image-2.5-flare']],
]);

function normalizeModelInput(value) {
  return String(value ?? '').trim().toLowerCase();
}

function customModelEntries(customModels) {
  return Object.entries(customModels || {})
    .map(([key, definition]) => {
      const model = typeof definition === 'string' ? definition : definition?.model;
      if (!model) return null;

      const label = typeof definition === 'object' ? definition?.label : undefined;
      return { key, model, ...(label ? { label } : {}), builtin: false };
    })
    .filter(Boolean);
}

function buildModelCatalog(customModels) {
  // 内置模型优先，同名短名不允许被自定义覆盖
  const builtins = BUILTIN_MODELS.map((entry) => ({ ...entry, builtin: true }));
  const builtinKeys = new Set(builtins.map((entry) => normalizeModelInput(entry.key)));

  return builtins.concat(
    customModelEntries(customModels).filter((entry) => !builtinKeys.has(normalizeModelInput(entry.key))),
  );
}

function formatModelOptions(catalog) {
  return catalog
    .map((entry) => `  ${entry.key} -> ${entry.model}${entry.builtin ? '' : '（自定义）'}`)
    .join('\n');
}

function defaultCatalogEntry(catalog) {
  return catalog.find((entry) => entry.key === DEFAULT_MODEL_KEY) || catalog[0] || null;
}

/**
 * 把用户输入（短名或原始 model ID）解析成实际要发给接口的模型。
 * 无法识别时抛错，并把可用模型一起列出来，避免把错误 ID 发到接口白烧配额。
 */
function resolveModel(input, customModels) {
  const catalog = buildModelCatalog(customModels);
  const raw = normalizeModelInput(input);

  if (!raw) {
    const entry = defaultCatalogEntry(catalog);
    return { ...entry, source: 'default' };
  }

  const ambiguous = AMBIGUOUS_MODEL_INPUTS.get(raw);
  if (ambiguous) {
    const options = catalog.filter((entry) => ambiguous.includes(entry.key));
    throw new Error(`\`${input}\` 对应多个模型，请明确指定其中一个：\n${formatModelOptions(options)}`);
  }

  const byKey = catalog.find((entry) => normalizeModelInput(entry.key) === raw);
  if (byKey) {
    return { ...byKey, source: 'key' };
  }

  const byModelId = catalog.find((entry) => normalizeModelInput(entry.model) === raw);
  if (byModelId) {
    return { ...byModelId, source: 'model-id' };
  }

  throw new Error(`未知模型：${input}\n可用模型：\n${formatModelOptions(catalog)}`);
}

/**
 * 取当前应当使用的模型：配置里的 current_model，失效（例如自定义模型被删）时退回默认。
 */
function resolveConfiguredModel(config) {
  const catalog = buildModelCatalog(config?.custom_models);
  const currentKey = config?.current_model;

  if (currentKey) {
    const entry = catalog.find((item) => item.key === currentKey);
    if (entry) {
      return { ...entry, source: 'config' };
    }
  }

  return { ...defaultCatalogEntry(catalog), source: 'default' };
}

/**
 * 解析某个候选 profile 实际要用的模型，优先级：
 *   --model（本次显式指定） > profile.model（该 profile 固定） > config.current_model > 默认
 *
 * cliModelEntry 需要调用方先用 resolveModel 解析好，这样非法的 --model 只需报错一次，
 * 而不是在每个候选上重复失败。
 */
function resolveModelForProfile({ cliModelEntry, profileModelKey, config } = {}) {
  if (cliModelEntry) {
    return { ...cliModelEntry, source: 'cli' };
  }

  if (profileModelKey) {
    return { ...resolveModel(profileModelKey, config?.custom_models), source: 'profile' };
  }

  return resolveConfiguredModel(config);
}

/** --profile-model 接受这些值表示「取消固定，跟随全局当前模型」。 */
function isClearModelInput(value) {
  return ['none', 'default', 'clear', 'auto'].includes(normalizeModelInput(value));
}

function isBuiltinModelKey(key) {
  const raw = normalizeModelInput(key);
  return BUILTIN_MODELS.some((entry) => normalizeModelInput(entry.key) === raw);
}

module.exports = {
  DEFAULT_MODEL_KEY,
  BUILTIN_MODELS,
  buildModelCatalog,
  formatModelOptions,
  resolveModel,
  resolveConfiguredModel,
  resolveModelForProfile,
  isClearModelInput,
  isBuiltinModelKey,
  normalizeModelInput,
};
