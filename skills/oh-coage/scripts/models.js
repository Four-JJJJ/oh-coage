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
const { inferModelFamily } = require('./family-config');

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
  // 判断传进来的是「完整配置」还是「裸的 custom_models 映射」。
  // 早期只看 custom_models / discovered_models 是否存在，导致全新配置（这两个键都还没建）
  // 会把 version / created_at / active_profile / current_model 这些元数据当成自定义模型，
  // 进而让 `setup.js --model created_at` 把 current_model 永久写成时间戳。
  // 改为看配置的特征键：profiles / current_model 只可能出现在完整配置里。
  const isConfigObject = Boolean(configOrCustomModels)
    && typeof configOrCustomModels === 'object'
    && !Array.isArray(configOrCustomModels)
    && (
      'profiles' in configOrCustomModels
      || 'current_model' in configOrCustomModels
      || 'custom_models' in configOrCustomModels
      || 'discovered_models' in configOrCustomModels
    );
  const config = isConfigObject
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
function resolveModel(input, configOrCustomModels, family, allFamilies = false) {
  const catalog = allFamilies
    ? ['openai', 'gemini', 'grok'].flatMap(value => buildModelCatalog(configOrCustomModels, value))
    : buildModelCatalog(configOrCustomModels, family);
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
  const resolvedFamily = family === 'other' ? 'other' : normalizeFamily(family || 'openai');

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

/**
 * 解析一个 profile 内部的主备模型链：
 *   [首选, 备用1, 备用2, ...]
 *
 * 主备都写进**同一个 profile**，因为站点、Key、协议、输出目录完全一样，
 * 只是模型不同。这样失败时不需要再造一个 profile 就能换模型重试。
 *
 * 规则：
 *   - --model 显式指定 = 只用它，不参与主备（用户点名了就照办）
 *   - 首选：profile.model > config.current_model > 该族默认
 *   - 备用：profile.fallback_models，按写入顺序
 *   - 备用里解析失败（写错、已被删除）只跳过该条并告警，不中断整轮
 *   - 按 model ID 去重，避免同一个模型被重复尝试、重复计费
 *
 * @param {{cliModelEntry?: object|null, profileModelKey?: string|null, profileFallbackKeys?: string[], config?: object, family?: string, allowModelFallback?: boolean, warn?: (message: string) => void}} options
 */
function resolveModelChainForProfile({
  cliModelEntry,
  profileModelKey,
  profileFallbackKeys,
  profile,
  config,
  family,
  allowModelFallback = true,
  warn = () => {},
} = {}) {
  const resolvedFamily = family === 'other' ? 'other' : normalizeFamily(family || 'openai');

  if (cliModelEntry) {
    return [{ ...cliModelEntry, source: 'cli' }];
  }

  const chain = [];
  const resolveSaved = (key) => {
    const ids = [...(profile?.synced_models || []), ...(profile?.manual_models || [])]
      .map(row => typeof row === 'string' ? row : row?.id || row?.model);
    if (ids.length) return resolveProfileModel(key, profile, config);
    const entry = resolveModel(key, config, null, true);
    if (profile && !entry.builtin) throw new Error(`模型 ${key} 未在此配置的当前模型列表或手动模型中验证，请刷新模型列表或重新添加准确 ID。`);
    return entry;
  };
  const push = (entry) => {
    if (!entry) return false;
    if (chain.some((item) => item.model === entry.model)) return false;
    chain.push(entry);
    return true;
  };

  try {
    push(profileModelKey
      ? { ...resolveSaved(profileModelKey), source: 'profile' }
      : resolveConfiguredModel(config, resolvedFamily));
  } catch (error) {
    if (!allowModelFallback) throw error;
    warn(`跳过首选模型 ${profileModelKey || ''}：${error.message.split('\n')[0]}`);
  }

  if (!allowModelFallback) {
    return chain;
  }

  const fallbackKeys = Array.isArray(profileFallbackKeys) ? profileFallbackKeys : [];
  const backup = fallbackKeys.find(key => key && key !== profileModelKey);
  for (const key of backup ? [backup] : []) {
    if (!key) continue;
    try {
      const entry = { ...resolveSaved(key), source: 'fallback' };
      if (inferModelFamily(entry.model, profile, config) !== (family === 'other' ? 'other' : resolvedFamily)) {
        warn(`备用模型 ${key} 不属于当前厂家，已跳过；请重新配置主备模型。`);
        continue;
      }
      if (!push(entry)) {
        warn(`备用模型 ${key} 与已选模型重复（${entry.model}），已跳过。`);
      }
    } catch (error) {
      warn(`跳过备用模型 ${key}：${error.message.split('\n')[0]}`);
    }
  }

  if (!chain.length) throw new Error('当前配置没有可用的已保存模型，请刷新列表并修改主备模型。');
  return chain;
}

/** --profile-model 接受这些值表示「取消固定，跟随全局当前模型」。 */
function isClearModelInput(value) {
  return ['none', 'default', 'clear', 'auto'].includes(normalizeModelInput(value));
}

function isBuiltinModelKey(key) {
  const raw = normalizeModelInput(key);
  return ALL_BUILTIN_MODELS.some((entry) => normalizeModelInput(entry.key) === raw);
}

/** Resolve conversational names against this site's actual IDs, not another site's catalog. */
function resolveProfileModel(input, profile, config) {
  const ids = [...new Set([...(profile?.synced_models || []), ...(profile?.manual_models || [])]
    .map(row => typeof row === 'string' ? row : row?.id || row?.model).filter(Boolean))];
  if (!ids.length) return resolveModel(input, config, null, true);
  const raw = normalizeModelInput(input);
  const exact = ids.filter(id => normalizeModelInput(id) === raw);
  const matches = exact.length ? exact : ids.filter(id => normalizeModelInput(id).includes(raw));
  if (!raw || matches.length !== 1) {
    throw new Error(matches.length > 1
      ? `\`${input}\` 对应多个站点模型，请明确选择：${matches.join('、')}`
      : `当前站点列表中没有模型 \`${input}\`，请刷新模型列表或切换配置。`);
  }
  const model = matches[0];
  const family = inferModelFamily(model, profile, config);
  return { key: model, model, family, builtin: false, source: 'profile-catalog' };
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
  resolveModelChainForProfile,
  isClearModelInput,
  isBuiltinModelKey,
  normalizeModelInput,
  resolveProfileModel,
};
