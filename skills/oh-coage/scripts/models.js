/**
 * oh-coage 可用模型注册表。
 *
 * 内置模型按模型族分组：openai（image）、gemini（banana）、grok。
 * 默认目录保持旧行为（只有 3 个 GPT Image 模型），其他族用 family 收窄后再展开，
 * 这样 `setup.js --list-models` 不会突然多出一堆用户没配过的模型。
 * 这里只做名称解析，不发网络请求。
 */

const {
  normalizeFamily,
  allBuiltinModels,
  defaultModel,
} = require('./providers');

const DEFAULT_MODEL_KEY = 'image-2';

// 保持旧导出的语义：BUILTIN_MODELS 只含默认的 OpenAI 兼容模型。
// 全量列表用 ALL_BUILTIN_MODELS，避免旧测试和旧调用方被新族模型撑破。
const BUILTIN_MODELS = allBuiltinModels().filter((entry) => entry.family === 'openai');
const ALL_BUILTIN_MODELS = allBuiltinModels();

// 用户只说「2.5」时对应两个 OpenAI 模型，不能替他瞎猜（两者可能计费/效果不同）
const AMBIGUOUS_MODEL_INPUTS = new Map([
  ['2.5', ['image-2.5-sunburst', 'image-2.5-flare']],
  ['image-2.5', ['image-2.5-sunburst', 'image-2.5-flare']],
  ['gpt-image-2.5', ['image-2.5-sunburst', 'image-2.5-flare']],
]);

function normalizeModelInput(value) {
  return String(value ?? '').trim().toLowerCase();
}

function modelEntries(record, source) {
  return Object.entries(record || {})
    .map(([key, definition]) => {
      const model = typeof definition === 'string' ? definition : definition?.model;
      if (!model) return null;

      const label = typeof definition === 'object' ? definition?.label : undefined;
      let family;
      try {
        family = normalizeFamily(definition?.family || definition?.provider || 'openai');
      } catch {
        family = 'openai';
      }

      return {
        key,
        model,
        family,
        ...(label ? { label } : {}),
        builtin: false,
        sourceKind: source,
      };
    })
    .filter(Boolean);
}

/**
 * family 为空时只给 openai 内置模型（保持旧行为）；
 * family 有值时才展开该族的内置模型、自定义模型和拉取结果。
 */
function buildModelCatalog(configOrCustomModels, family) {
  const config = configOrCustomModels && (configOrCustomModels.custom_models || configOrCustomModels.discovered_models)
    ? configOrCustomModels
    : { custom_models: configOrCustomModels };
  const scopedFamily = family ? normalizeFamily(family) : null;

  const builtins = ALL_BUILTIN_MODELS
    .filter((entry) => (scopedFamily ? entry.family === scopedFamily : entry.family === 'openai'))
    .map((entry) => ({ ...entry, builtin: true, sourceKind: 'builtin' }));
  const builtinKeys = new Set(builtins.map((entry) => normalizeModelInput(entry.key)));

  const extras = modelEntries(config.custom_models, 'custom')
    .concat(modelEntries(config.discovered_models, 'discovered'))
    .filter((entry) => !builtinKeys.has(normalizeModelInput(entry.key)))
    .filter((entry) => (scopedFamily ? entry.family === scopedFamily : entry.family === 'openai'));

  return builtins.concat(extras);
}

function formatModelOptions(catalog) {
  return catalog
    .map((entry) => {
      const origin = entry.builtin ? '' : entry.sourceKind === 'discovered' ? '（已拉取）' : '（自定义）';
      return `  ${entry.family}:${entry.key} -> ${entry.model}${origin}`;
    })
    .join('\n');
}

function defaultCatalogEntry(catalog, family) {
  if (family) {
    const preferred = defaultModel(family);
    return catalog.find((entry) => entry.key === preferred.key)
      || catalog.find((entry) => entry.family === family)
      || null;
  }

  return catalog.find((entry) => entry.key === DEFAULT_MODEL_KEY) || catalog[0] || null;
}

function finishResolved(entry, source) {
  return {
    key: entry.key,
    model: entry.model,
    family: entry.family,
    label: entry.label,
    builtin: entry.builtin,
    source,
  };
}

/**
 * 把用户输入（短名、family:短名或原始 model ID）解析成实际要发给接口的模型。
 * 无法识别或跨族多义时抛错，避免把错误 ID 发到接口白烧配额。
 */
function resolveModel(input, configOrCustomModels, family) {
  const catalog = buildModelCatalog(configOrCustomModels, family);
  const raw = normalizeModelInput(input);

  if (!raw) {
    const entry = defaultCatalogEntry(catalog, family);
    if (!entry) {
      throw new Error(`模型族 ${family} 没有可用模型，请先用 setup.js --sync-models 拉取。`);
    }
    return finishResolved(entry, 'default');
  }

  const ambiguous = AMBIGUOUS_MODEL_INPUTS.get(raw);
  if (ambiguous) {
    const options = catalog.filter((entry) => ambiguous.includes(entry.key));
    throw new Error(`\`${input}\` 对应多个模型，请明确指定其中一个：\n${formatModelOptions(options)}`);
  }

  const qualified = raw.match(/^(openai|gemini|grok):(.+)$/);
  const wantedFamily = qualified ? qualified[1] : family || null;
  const wantedName = qualified ? qualified[2] : raw;
  const scoped = wantedFamily
    ? buildModelCatalog(configOrCustomModels, wantedFamily)
    : catalog;

  const byKey = scoped.filter((entry) => normalizeModelInput(entry.key) === wantedName);
  if (byKey.length === 1) return finishResolved(byKey[0], 'key');
  if (byKey.length > 1) {
    throw new Error(`\`${input}\` 在多个模型族中同名，请明确指定：\n${formatModelOptions(byKey)}`);
  }

  const byModelId = scoped.filter((entry) => normalizeModelInput(entry.model) === wantedName);
  if (byModelId.length === 1) return finishResolved(byModelId[0], 'model-id');
  if (byModelId.length > 1) {
    throw new Error(`\`${input}\` 匹配到多个模型，请明确指定其中一个：\n${formatModelOptions(byModelId)}`);
  }

  // 用户口语里常只叫后半截（「用 flare 画」）。只在能唯一确定时接受，多义一律报错。
  const bySuffix = scoped.filter((entry) => (
    normalizeModelInput(entry.key).endsWith(`-${wantedName}`)
    || normalizeModelInput(entry.model).endsWith(`-${wantedName}`)
  ));

  if (bySuffix.length === 1) return finishResolved(bySuffix[0], 'suffix');
  if (bySuffix.length > 1) {
    throw new Error(`\`${input}\` 匹配到多个模型，请明确指定其中一个：\n${formatModelOptions(bySuffix)}`);
  }

  throw new Error(`未知模型：${input}\n可用模型：\n${formatModelOptions(scoped.length ? scoped : catalog)}`);
}

/**
 * 取当前应当使用的模型：配置里的 current_model，失效（例如自定义模型被删）时退回该族默认。
 */
function resolveConfiguredModel(config, family) {
  const catalog = buildModelCatalog(config, family);
  const currentKey = config?.current_model;

  if (currentKey) {
    const entry = catalog.find((item) => item.key === currentKey);
    if (entry) return finishResolved(entry, 'config');

    // current_model 可能属于另一族：只有当前族能解析时才用，否则落回默认
    const global = buildModelCatalog(config).find((item) => item.key === currentKey);
    if (global && (!family || global.family === normalizeFamily(family))) {
      return finishResolved(global, 'config');
    }
  }

  const fallback = defaultCatalogEntry(catalog, family) || defaultCatalogEntry(buildModelCatalog(config));
  return finishResolved(fallback, 'default');
}

/**
 * 解析某个候选 profile 实际要用的模型，优先级：
 *   --model（本次显式指定） > profile.model（该 profile 固定） > config.current_model > 该族默认
 */
function resolveModelForProfile({ cliModelEntry, profileModelKey, config, family } = {}) {
  const resolvedFamily = normalizeFamily(family || 'openai');

  if (cliModelEntry) {
    if (cliModelEntry.family !== resolvedFamily) {
      throw new Error(`模型 ${cliModelEntry.key} 属于 ${cliModelEntry.family}，不能用于 ${resolvedFamily} profile。`);
    }
    return { ...cliModelEntry, source: 'cli' };
  }

  if (profileModelKey) {
    return { ...resolveModel(profileModelKey, config, resolvedFamily), source: 'profile' };
  }

  return resolveConfiguredModel(config, resolvedFamily);
}

/** --profile-model 接受这些值表示「取消固定，跟随全局当前模型」。 */
function isClearModelInput(value) {
  return ['none', 'default', 'clear', 'auto'].includes(normalizeModelInput(value));
}

function isBuiltinModelKey(key) {
  const raw = normalizeModelInput(key);
  return ALL_BUILTIN_MODELS.some((entry) => normalizeModelInput(entry.key) === raw);
}

module.exports = {
  DEFAULT_MODEL_KEY,
  BUILTIN_MODELS,
  ALL_BUILTIN_MODELS,
  buildModelCatalog,
  formatModelOptions,
  resolveModel,
  resolveConfiguredModel,
  resolveModelForProfile,
  isClearModelInput,
  isBuiltinModelKey,
  normalizeModelInput,
};
