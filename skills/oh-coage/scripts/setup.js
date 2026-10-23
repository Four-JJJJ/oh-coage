#!/usr/bin/env node
/**
 * oh-coage 首次初始化和 profile 管理脚本。
 * 敏感信息只写入 macOS Keychain，本地配置只保存非敏感字段。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getFamilyConfig, normalizeFamilySelection, inferModelFamily } = require('./family-config');
const https = require('https');
const http = require('http');
const {
  APP_DIR,
  STATE_PATH,
  RUNS_PATH,
  normalizeBaseUrl,
  assertValidBaseUrl,
  loadActiveConfig,
  loadConfigFromPath,
  saveState,
  getDefaultConfigPath,
  saveConfig,
  buildKeychainAccount,
  saveKeychainSecret,
  readKeychainSecret,
  deleteKeychainSecret,
  setActiveProfile,
  ensureDir,
} = require('./config-store');
const {
  DEFAULT_MODEL_KEY,
  buildModelCatalog,
  resolveModel,
  resolveConfiguredModel,
  isClearModelInput,
  isBuiltinModelKey,
  normalizeModelInput,
} = require('./models');const { resolveDefaultOutputDir } = require('./resolve-output-dir');
const {
  FAMILIES,
  normalizeFamily,
  normalizeApiStyle,
  normalizeImageField,
  normalizeImageTransport,
  normalizeImageShape,
  resolveImageOptions,
  modelEntriesFromList,
  buildModelListRequest,
} = require('./providers');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--output-dir': {
        const value = args[++i];
        if (!value) {
          console.error('--output-dir 缺少参数值。');
          process.exit(1);
        }
        parsed.outputDir = path.resolve(value);
        break;
      }
      case '--profile': parsed.profile = args[++i]; break;
      case '--family': parsed.family = args[++i]; break;
      case '--api': parsed.apiStyle = args[++i]; break;
      case '--sync-models': parsed.syncModels = true; break;
      case '--base-url': parsed.baseUrl = args[++i]; break;
      case '--api-key': parsed.apiKey = args[++i]; break;
      case '--activate': parsed.activate = true; break;
      case '--list': parsed.list = true; break;
      case '--activate-profile': parsed.activateProfile = args[++i]; break;
      case '--delete-profile': parsed.deleteProfile = args[++i]; break;
      case '--rename-profile': parsed.renameProfile = args[++i]; break;
      case '--to': parsed.renameTo = args[++i]; break;
      case '--uninstall-skill': parsed.uninstallSkill = true; break;
      case '--keep-config-file': parsed.keepConfigFile = true; break;
      case '--keep-keychain': parsed.keepKeychain = true; break;
      case '--purge-logs': parsed.purgeLogs = true; break;
      case '--model': parsed.model = args[++i]; break;
      case '--list-models': parsed.listModels = true; break;
      case '--add-model': parsed.addModel = args[++i]; break;
      case '--model-id': parsed.modelId = args[++i]; break;
      case '--label': parsed.label = args[++i]; break;
      case '--delete-model': parsed.deleteModel = args[++i]; break;
      case '--health-check': parsed.healthCheck = true; break;
      case '--live': parsed.live = true; break;
      case '--profile-model': {
        const value = args[++i];
        if (!value || value.startsWith('--')) {
          console.error('--profile-model 需要一个模型短名，或用 "none" 取消固定');
          process.exit(1);
        }
        parsed.profileModel = value;
        break;
      }
      case '--primary-model': {
        const value = args[++i];
        if (!value || value.startsWith('--')) {
          console.error('--primary-model 需要一个模型短名，或用 "none" 取消固定');
          process.exit(1);
        }
        parsed.profileModel = value;
        break;
      }
      case '--fallback-model': {
        const value = args[++i];
        if (!value || value.startsWith('--')) {
          console.error('--fallback-model 需要一个模型短名，可重复传入多个');
          process.exit(1);
        }
        parsed.fallbackModels ||= [];
        parsed.fallbackModels.push(value);
        break;
      }
      case '--clear-fallback-models': parsed.clearFallbackModels = true; break;
      case '--image-field': parsed.imageField = args[++i]; break;
      case '--image-transport': parsed.imageTransport = args[++i]; break;
      case '--image-shape': parsed.imageShape = args[++i]; break;
      case '--image-endpoint': parsed.imageEndpoint = args[++i]; break;
      case '--clear-image-options': parsed.clearImageOptions = true; break;
    }
  }

  return parsed;
}

function printUsage() {
  console.error('用法:');
  console.error('  初始化或新增 profile（--output-dir 可省，默认落到项目根或桌面）:');
  console.error('    node setup.js --profile "main" --base-url "https://example.com/v1" --api-key "KEY" [--output-dir "/path/to/images"] [--activate] [--family openai|gemini|grok] [--api openai|official] [--model "image-2"] [--fallback-model "image-2.5-flare"]');
  console.error('  拉取该 profile 支持的模型（用它的 URL + Key）:');
  console.error('    node setup.js --sync-models [--profile "main"]');
  console.error('  列出 profile:');
  console.error('    node setup.js --list');
  console.error('  切换当前 profile:');
  console.error('    node setup.js --activate-profile "main"');
  console.error('  删除 profile:');
  console.error('    node setup.js --delete-profile "main"');
  console.error('  重命名 profile:');
  console.error('    node setup.js --rename-profile "old-name" --to "new-name"');
  console.error('  删除 skill 本地配置和 Keychain 记录:');
  console.error('    node setup.js --uninstall-skill [--keep-config-file] [--keep-keychain] [--purge-logs]');
  console.error('  profile 健康检查:');
  console.error('    node setup.js --health-check [--live]');
  console.error('  查看当前模型和所有可选模型:');
  console.error('    node setup.js --list-models');
  console.error('  切换当前模型:');
  console.error('    node setup.js --model "image-2.5-flare"');
  console.error('  添加或更新自定义模型:');
  console.error('    node setup.js --add-model "my-model" --model-id "vendor-model-id" [--label "说明"]');
  console.error('  删除自定义模型:');
  console.error('    node setup.js --delete-model "my-model"');
  console.error('  给某个 profile 固定模型（不写 --profile 则作用于当前 profile）:');
  console.error('    node setup.js --profile-model "image-2.5-flare" [--profile "main"]');
  console.error('  取消固定，让它跟随全局当前模型:');
  console.error('    node setup.js --profile-model none [--profile "main"]');
  console.error('  给同一 profile 配置主备模型链（首选 + 备用，失败自动换备用）:');
  console.error('    node setup.js --primary-model "image-2" --fallback-model "image-2.5-flare" --fallback-model "banana-2.1" [--profile "main"]');
  console.error('  只改备用模型（不动首选）:');
  console.error('    node setup.js --fallback-model "image-2.5-flare" [--profile "main"]');
  console.error('  清除备用模型（保留首选）:');
  console.error('    node setup.js --clear-fallback-models [--profile "main"]');
  console.error('  配置图生图适配（不写 --profile 则作用于当前 profile）:');
  console.error('    node setup.js --image-transport json|multipart [--image-field image_urls] [--image-shape array|array-object|single] [--image-endpoint /images/edits] [--profile "main"]');
  console.error('  清除图生图适配，回到内置默认:');
  console.error('    node setup.js --clear-image-options [--profile "main"]');
}

function requireConfig() {
  const context = loadActiveConfig();
  if (!context.config || !context.configPath) {
    throw new Error('尚未初始化。');
  }
  return context;
}

function profileFamily(profile) {
  try {
    return normalizeFamily(profile?.family || 'openai');
  } catch {
    return 'openai';
  }
}

function profileApiStyle(profile, family) {
  try {
    return normalizeApiStyle(profile?.api_style, family || profileFamily(profile));
  } catch {
    return 'openai';
  }
}

function describeProfile(profile) {
  const family = profileFamily(profile);
  const apiStyle = profileApiStyle(profile, family);
  const apiLabel = apiStyle === 'official' ? '官方接口' : 'OpenAI 兼容接口';
  return `${family} / ${apiLabel}`;
}

/** profile 是否写了图生图适配项（写了才在 --list 里显示，避免默认配置变啰嗦）。 */
function hasImageOptions(profile) {
  return Boolean(profile?.image_field || profile?.image_transport || profile?.image_shape || profile?.image_endpoint);
}

function describeImageOptions(profile) {
  const resolved = resolveImageOptions({
    imageField: profile?.image_field,
    imageTransport: profile?.image_transport,
    imageShape: profile?.image_shape,
    imageEndpoint: profile?.image_endpoint,
  });
  const shapeLabel = resolved.shape === 'array'
    ? '字符串数组'
    : resolved.shape === 'array-object' ? '对象数组' : '单值';
  return `端点=${resolved.endpoint}, 传输=${resolved.transport}, 字段=${resolved.field}, 形状=${shapeLabel}`;
}

function listProfiles() {
  const { config, configPath } = loadActiveConfig();
  if (!config) {
    console.log('尚未初始化。');
    return;
  }

  console.log(`config: ${configPath}`);
  console.log(`current_model: ${resolveConfiguredModel(config).key}`);
  Object.entries(config.profiles || {}).forEach(([name, profile]) => {
    const flag = name === config.active_profile ? '*' : ' ';
    const modelNote = profile.model ? ` [model: ${profile.model}]` : '';
    const fallbackNote = Array.isArray(profile.fallback_models) && profile.fallback_models.length
      ? ` [备用: ${profile.fallback_models.join(' -> ')}]`
      : '';
    const syncedNote = Array.isArray(profile.synced_models) && profile.synced_models.length
      ? ` [synced: ${profile.synced_models.length}]`
      : '';
    const imageNote = hasImageOptions(profile) ? ` [图生图: ${describeImageOptions(profile)}]` : '';
    console.log(`${flag} ${name} (${describeProfile(profile)}) -> ${profile.base_url} -> ${profile.root_output_dir || profile.output_dir}${modelNote}${fallbackNote}${syncedNote}${imageNote}`);
  });
}

function fetchJson(url, headers, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`模型列表地址不合法: ${url}`));
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('error', reject);
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('模型列表返回的不是 JSON'));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Refresh the actual site catalog without changing the saved model order. */
async function syncProfileModels(profileName) {
  const { config, configPath } = requireConfig();
  const targetName = profileName || config.active_profile;
  const profile = config.profiles?.[targetName];
  if (!profile) throw new Error(`profile 不存在: ${targetName}`);
  const family = profileFamily(profile);
  const apiStyle = profileApiStyle(profile, family);
  const baseUrl = normalizeBaseUrl(profile.base_url);
  assertValidBaseUrl(baseUrl);
  const apiKey = readKeychainSecret(profile.keychain_account);
  const spec = buildModelListRequest({ family, apiStyle, baseUrl, apiKey });
  const ids = new Set();
  const pages = new Set();
  let next = spec.url;
  for (let page = 0; next; page++) {
    if (page >= 100 || pages.has(next)) throw new Error('模型列表分页异常；旧列表和模型顺序未修改。');
    pages.add(next);
    let response;
    try { response = await fetch(next, { headers: spec.headers, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('模型列表连接失败；请重试刷新，旧列表和模型顺序未修改。'); }
    if (!response.ok) throw new Error(`模型列表 HTTP ${response.status}；旧列表和模型顺序未修改。`);
    const payload = await response.json();
    const rows = payload.data || payload.models;
    if (!Array.isArray(rows)) throw new Error('模型列表格式无效；旧列表未修改。');
    for (const row of rows) {
      const id = typeof row === 'string' ? row : row?.id || row?.name || row?.model;
      if (typeof id === 'string' && id.trim()) ids.add(id.replace(/^models\//, ''));
    }
    next = null;
    if (payload.nextPageToken) {
      const url = new URL(spec.url);
      url.searchParams.set('pageToken', payload.nextPageToken);
      next = url.href;
    } else if (payload.has_more === true) {
      const cursor = rows.at(-1)?.id;
      if (!cursor) throw new Error('模型列表分页缺少游标；旧列表未修改。');
      const url = new URL(spec.url);
      url.searchParams.set('after', cursor);
      next = url.href;
    }
  }
  if (!ids.size) throw new Error('站点返回空模型列表；旧列表未修改。可重新验证连接或手动填写准确模型 ID。');
  const syncedAt = new Date().toISOString();
  profile.synced_models = [...ids];
  profile.models_synced_at = syncedAt;
  profile.updated_at = syncedAt;
  config.updated_at = syncedAt;
  config.discovered_models ||= {};
  for (const model of ids) {
    const inferred = /gemini|banana|imagen/i.test(model) ? 'gemini' : /grok/i.test(model) ? 'grok' : family;
    config.discovered_models[model] = { model, family: inferred, source_profile: targetName, updated_at: syncedAt };
  }
  saveConfig(configPath, config);
  console.log(`已从 ${baseUrl} 全量拉取模型：${ids.size} 个；已保存的使用顺序保持不变。`);
  ids.forEach(model => console.log(`  ${model}`));
  return [...ids].map(model => ({ model }));
}

function probeUrl(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'GET' }, (res) => {
      res.on('error', (error) => resolve({ reachable: false, error: error.message }));
      res.resume();
      resolve({ reachable: true, statusCode: res.statusCode });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (error) => resolve({ reachable: false, error: error.message }));
    req.end();
  });
}

async function healthCheck(options) {
  const { config, configPath } = requireConfig();
  const currentModel = resolveConfiguredModel(config);
  console.log(`config: ${configPath}`);
  console.log(`current_model: ${currentModel.key} -> ${currentModel.model}`);
  console.log(`mode: ${options.live ? 'live' : 'local'}`);

  const names = Object.keys(config.profiles || {});
  if (!names.length) {
    console.log('没有可检查的 profile。');
    return [];
  }

  const unhealthyProfiles = [];

  for (const name of names) {
    const profile = config.profiles[name];
    const checks = [];

    checks.push({ item: 'enabled', ok: profile.enabled !== false, detail: profile.enabled === false ? 'disabled' : 'enabled' });

    try {
      const rootOutputDir = profile.resolved_root_output_dir || profile.root_output_dir || profile.output_dir;
      if (!rootOutputDir) {
        checks.push({ item: 'root_output_dir', ok: false, detail: 'profile 未配置输出目录' });
      } else if (fs.existsSync(rootOutputDir)) {
        fs.accessSync(rootOutputDir, fs.constants.W_OK);
        checks.push({ item: 'root_output_dir', ok: true, detail: `${profile.root_output_dir || profile.output_dir} -> ${rootOutputDir}` });
      } else {
        checks.push({ item: 'root_output_dir', ok: true, detail: `${profile.root_output_dir || profile.output_dir} -> ${rootOutputDir}（尚不存在，首次生成时自动创建）` });
      }
    } catch (error) {
      checks.push({ item: 'root_output_dir', ok: false, detail: error.message });
    }

    try {
      const baseUrl = normalizeBaseUrl(profile.base_url);
      assertValidBaseUrl(baseUrl);
      checks.push({ item: 'base_url', ok: true, detail: baseUrl });

      if (options.live) {
        const probe = await probeUrl(baseUrl);
        checks.push({
          item: 'live_probe',
          ok: probe.reachable,
          detail: probe.reachable ? `reachable (HTTP ${probe.statusCode})` : probe.error,
        });
      }
    } catch (error) {
      checks.push({ item: 'base_url', ok: false, detail: error.message });
    }

    try {
      const key = readKeychainSecret(profile.keychain_account);
      checks.push({ item: 'keychain', ok: true, detail: `loaded (${key.length} chars)` });
    } catch (error) {
      checks.push({ item: 'keychain', ok: false, detail: error.message });
    }

    try {
      const profileModel = profile.model
        ? resolveModel(profile.model, config, null, true)
        : resolveConfiguredModel(config, profileFamily(profile));
      checks.push({
        item: 'model',
        ok: true,
        detail: `${profileModel.model}${profile.model ? '（profile 固定）' : '（跟随全局）'}`,
      });
    } catch (error) {
      checks.push({ item: 'model', ok: false, detail: error.message.split('\n')[0] });
    }

    // 备用模型写错了不应该等到出图时才发現：在健康检查里先报出来
    if (Array.isArray(profile.fallback_models) && profile.fallback_models.length) {
      const resolvedFallbacks = [];
      const brokenFallbacks = [];
      for (const key of profile.fallback_models) {
        try {
          resolvedFallbacks.push(resolveModel(key, config, null, true).model);
        } catch (error) {
          brokenFallbacks.push(`${key}（${error.message.split('\n')[0]}）`);
        }
      }
      checks.push({
        item: 'fallback_models',
        ok: brokenFallbacks.length === 0,
        detail: brokenFallbacks.length
          ? `无效: ${brokenFallbacks.join('; ')}`
          : resolvedFallbacks.join(' -> '),
      });
    }

    checks.push({ item: 'interface', ok: true, detail: describeProfile(profile) });

    const healthy = checks.every((check) => check.ok);
    if (!healthy) unhealthyProfiles.push(name);
    const activeFlag = name === config.active_profile ? '*' : ' ';
    console.log(`${activeFlag} ${name}: ${healthy ? 'ok' : 'needs_attention'}`);
    checks.forEach((check) => {
      console.log(`  - ${check.item}: ${check.ok ? 'ok' : 'fail'} (${check.detail})`);
    });
  }

  // 退出码要能反映健康状态，否则 CI 里 --health-check 永远「通过」
  if (unhealthyProfiles.length > 0) {
    console.log(`\n有 ${unhealthyProfiles.length} 个 profile 需要处理: ${unhealthyProfiles.join(', ')}`);
    process.exitCode = 1;
  }

  return unhealthyProfiles;
}

function activateProfile(profileName) {
  const { config, configPath } = requireConfig();
  setActiveProfile(config, profileName);
  saveConfig(configPath, config);
  console.log(`已切换当前 profile: ${profileName}`);
}

function listModels() {
  const { config } = loadActiveConfig();
  // 传完整 config：只传 custom_models 会把 --sync-models 拉回来的 discovered_models 漏掉
  const catalog = buildModelCatalog(config);
  const current = resolveConfiguredModel(config);

  console.log(`current_model: ${current.key} -> ${current.model}`);
  if (!config) {
    console.log('（尚未初始化，以下仅为内置模型）');
  }

  catalog.forEach((entry) => {
    const flag = entry.key === current.key ? '*' : ' ';
    console.log(`${flag} ${entry.key} -> ${entry.model}${entry.builtin ? '' : '（自定义）'}`);
  });

  // 其他模型族的内置模型单独列，避免撑坏默认目录的旧输出
  const otherFamilies = Object.fromEntries(
    FAMILIES.filter((family) => family !== 'openai').map((family) => [family, buildModelCatalog(config, family)]),
  );
  for (const [family, entries] of Object.entries(otherFamilies)) {
    if (!entries.length) continue;
    console.log(`\n${family}（需用 --family ${family} 或对应的 profile）:`);
    entries.forEach((entry) => console.log(`  ${entry.key} -> ${entry.model}${entry.builtin ? '' : '（自定义）'}`));
  }
}

function switchModel(modelInput, family) {
  if (!modelInput) {
    printUsage();
    process.exit(1);
  }

  const { config, configPath } = requireConfig();

  // 没显式给 --family 时，按当前活跃 profile 的族解析，
  // 否则 banana-* / grok-* 这类短名永远找不到。
  const activeProfile = config.profiles?.[config.active_profile];
  const resolvedFamily = family
    ? normalizeFamily(family)
    : (activeProfile ? profileFamily(activeProfile) : null);
  const resolved = resolveModel(modelInput, config, resolvedFamily);

  config.current_model = resolved.key;
  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);

  console.log(`已切换当前模型: ${resolved.key} -> ${resolved.model}（${resolved.family}）`);
  console.log('这是旧版全局设置；配置内已固定的模型优先。日常切换请使用 manage.js --apply 修改当前配置。');
}

function addCustomModel(options) {
  const key = normalizeModelInput(options.addModel);
  if (!key) {
    printUsage();
    process.exit(1);
  }

  if (isBuiltinModelKey(key)) {
    throw new Error(`短名 ${key} 与内置模型冲突，请换一个短名（例如 ${key}-custom）。`);
  }

  if (!options.modelId) {
    throw new Error(
      '缺少 --model-id：添加自定义模型前，必须先向用户确认该站点要求的 model ID 字符串。\n'
      + '示例：node setup.js --add-model "my-model" --model-id "vendor-model-id" [--label "说明"]',
    );
  }

  const { config, configPath } = requireConfig();
  config.custom_models ||= {};
  const existed = Boolean(config.custom_models[key]);

  let customFamily = 'openai';
  try {
    customFamily = normalizeFamily(options.family || 'openai');
  } catch {
    customFamily = 'openai';
  }

  config.custom_models[key] = {
    model: options.modelId,
    family: customFamily,
    ...(options.label ? { label: options.label } : {}),
    updated_at: new Date().toISOString(),
  };
  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);

  console.log(`已${existed ? '更新' : '添加'}自定义模型: ${key} -> ${options.modelId}（${customFamily}）`);
  console.log(`切换到这个模型：node setup.js --model "${key}"`);
}

function deleteCustomModel(modelInput) {
  const key = normalizeModelInput(modelInput);
  if (!key) {
    printUsage();
    process.exit(1);
  }

  if (isBuiltinModelKey(key)) {
    throw new Error(`内置模型 ${key} 不能删除。`);
  }

  const { config, configPath } = requireConfig();
  if (!config.custom_models?.[key]) {
    throw new Error(`自定义模型不存在: ${key}`);
  }

  delete config.custom_models[key];
  if (Object.keys(config.custom_models).length === 0) {
    delete config.custom_models;
  }

  if (config.current_model === key) {
    config.current_model = DEFAULT_MODEL_KEY;
    console.log(`被删除的模型正是当前模型，已回到默认: ${DEFAULT_MODEL_KEY}`);
  }

  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);

  console.log(`已删除自定义模型: ${key}`);
}

function syncGroupedProfile(profile, config) {
  if (!profile.model_families) return;
  if (!profile.model) throw new Error('按厂家配置不支持取消固定模型；请使用 manage.js --render 为厂家选择主要模型或移除该组。');
  const exact = key => resolveModel(key, config, null, true).model;
  const primary = exact(profile.model);
  const family = inferModelFamily(primary, profile, config);
  const fallbacks = (profile.fallback_models || []).map(exact).filter(id => id !== primary);
  if (fallbacks.some(id => inferModelFamily(id, profile, config) !== family)) throw new Error('主备模型必须属于同一厂家；请使用 manage.js --render 分别配置各厂家的主要和备选模型。');
  const { modelFamilies } = getFamilyConfig(profile, config);
  modelFamilies[family] = { primary, fallbacks: [...new Set(fallbacks)] };
  const normalized = normalizeFamilySelection(modelFamilies, family, { profile, config });
  profile.model_families = normalized.modelFamilies;
  profile.active_model_family = normalized.activeFamily;
  profile.model = primary;
  profile.fallback_models = modelFamilies[family].fallbacks;
}

function setProfileModel(options) {
  const { config, configPath } = requireConfig();
  const targetName = options.profile || config.active_profile;
  const profile = config.profiles?.[targetName];

  if (!profile) {
    throw new Error(`profile 不存在: ${targetName}`);
  }

  const wantsFallbackChange = Boolean(options.fallbackModels?.length) || options.clearFallbackModels === true;
  const family = profileFamily(profile);

  // 先把所有输入都验一遍再落盘，避免写进一半合法一半非法的配置
  const nextFallbackKeys = [];
  if (options.fallbackModels?.length) {
    for (const input of options.fallbackModels) {
      const resolved = resolveModel(input, config, null, true);
      if (!nextFallbackKeys.includes(resolved.key)) nextFallbackKeys.push(resolved.key);
    }
  }

  let nextPrimaryKey;
  if (options.profileModel !== undefined && !isClearModelInput(options.profileModel)) {
    nextPrimaryKey = resolveModel(options.profileModel, config, null, true).key;
  }

  profile.updated_at = new Date().toISOString();
  config.updated_at = profile.updated_at;

  if (nextPrimaryKey !== undefined) {
    profile.model = nextPrimaryKey;
  } else if (options.profileModel !== undefined) {
    delete profile.model;
  }

  if (wantsFallbackChange) {
    const merged = options.clearFallbackModels ? [] : [...nextFallbackKeys];
    // 备用模型不能和首选重复，否则同一模型会被尝试两次，白花配额
    const primaryKey = profile.model || resolveConfiguredModel(config, family).key;
    const deduped = merged.filter((key) => key !== primaryKey);
    if (deduped.length > 0) {
      profile.fallback_models = deduped;
    } else {
      delete profile.fallback_models;
    }
  }

  syncGroupedProfile(profile, config);
  saveConfig(configPath, config);

  if (nextPrimaryKey !== undefined) {
    console.log(`已固定 profile ${targetName} 使用模型: ${nextPrimaryKey} -> ${resolveModel(nextPrimaryKey, config, null, true).model}`);
  } else if (options.profileModel !== undefined) {
    console.log(`已取消 profile ${targetName} 的固定模型，将跟随全局当前模型。`);
  }

  if (wantsFallbackChange) {
    const fallbacks = profile.fallback_models || [];
    console.log(fallbacks.length
      ? `已设置 profile ${targetName} 的备用模型: ${fallbacks.join(' -> ')}`
      : `已清除 profile ${targetName} 的备用模型。`);
    if (fallbacks.length) {
      console.log('生成时首选模型失败（鉴权/限流/5xx/模型不可用）会自动按顺序换备用模型，站点、Key 和输出目录不变。');
    }
  }

  if (nextPrimaryKey === undefined && options.profileModel === undefined && !wantsFallbackChange) {
    console.log(`profile ${targetName} 当前模型: ${profile.model || '（跟随全局）'}，备用: ${(profile.fallback_models || []).join(' -> ') || '（无）'}`);
  }
}

/**
 * 图生图适配：不同站点的参考图字段名/传输方式不一样，做成 profile 级配置。
 * 全部留空就等于内置默认（JSON + image_urls + /images/generations）。
 */
function setProfileImageOptions(options) {
  const { config, configPath } = requireConfig();
  const targetName = options.profile || config.active_profile;
  const profile = config.profiles?.[targetName];

  if (!profile) {
    throw new Error(`profile 不存在: ${targetName}`);
  }

  if (options.clearImageOptions) {
    for (const key of ['image_field', 'image_transport', 'image_shape', 'image_endpoint']) {
      delete profile[key];
    }
    profile.updated_at = new Date().toISOString();
    config.updated_at = profile.updated_at;
    saveConfig(configPath, config);
    console.log(`已清除 profile ${targetName} 的图生图适配，回到内置默认：${describeImageOptions(profile)}`);
    return;
  }

  // 先全部验一遍再落盘，避免写进一半合法一半非法的配置
  const next = {
    image_field: options.imageField !== undefined
      ? normalizeImageField(options.imageField)
      : profile.image_field,
    image_transport: options.imageTransport !== undefined
      ? normalizeImageTransport(options.imageTransport)
      : profile.image_transport,
    image_shape: options.imageShape !== undefined
      ? normalizeImageShape(options.imageShape)
      : profile.image_shape,
    image_endpoint: options.imageEndpoint !== undefined
      ? options.imageEndpoint
      : profile.image_endpoint,
  };

  // 只覆写本次显式给出的项，其余保持原样
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === '') {
      delete profile[key];
    } else {
      profile[key] = value;
    }
  }

  profile.updated_at = new Date().toISOString();
  config.updated_at = profile.updated_at;
  saveConfig(configPath, config);

  console.log(`已更新 profile ${targetName} 的图生图适配: ${describeImageOptions(profile)}`);
}

/**
 * 是否给出了初始化参数，用来区分「切换模型」和「初始化顺带指定模型」。
 * 注意不含 --profile：它既能当初始化参数，也能给 --profile-model 指定目标，
 * 单独出现时不足以说明用户想初始化。
 * 注意不含 --output-dir：输出目录已经不是必填项，单独给它也不该触发初始化。
 */
function isInitRequest(options) {
  return Boolean(options.baseUrl || options.apiKey);
}

/**
 * profile 名会进 Keychain account、配置文件 key 和 --list 输出，
 * 带路径分隔符或控制字符的名字没有意义，还容易在日志/命令拼接里出问题。
 */
function validateProfileName(name) {
  if (!name) {
    throw new Error('profile 名称不能为空。');
  }
  if (name.length > 64 || /[\x00-\x1f\x7f/\\]/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {
    throw new Error(
      'profile 名称不合法：支持中文，长度 1-64，不能包含路径分隔符、控制字符或保留名称。',
    );
  }
  return name;
}

function upsertProfile(options) {
  if (!options.profile || !options.baseUrl || !options.apiKey) {
    printUsage();
    process.exit(1);
  }

  validateProfileName(options.profile);

  // 默认全部走 OpenAI 兼容接口，官方接口必须显式指定
  const family = options.family ? normalizeFamily(options.family) : 'openai';
  const apiStyle = options.apiStyle ? normalizeApiStyle(options.apiStyle, family) : 'openai';

  // 不强制用户选文件夹：没给就用「项目根 / 桌面」推导出来的默认目录
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : resolveDefaultOutputDir(process.cwd());

  // 存进去之前就拦住非法 base_url，别等到生成时才发现
  const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl);
  assertValidBaseUrl(normalizedBaseUrl);

  ensureDir(outputDir);

  const { config: existingConfig, configPath: activeConfigPath } = loadActiveConfig();
  const configPath = activeConfigPath || getDefaultConfigPath(outputDir);
  const config = existingConfig || {
    version: 1,
    created_at: new Date().toISOString(),
    active_profile: options.profile,
    current_model: DEFAULT_MODEL_KEY,
    profiles: {},
  };

  if (!config.current_model) {
    config.current_model = DEFAULT_MODEL_KEY;
  }

  const expectedRevision = existingConfig ? existingConfig._loadedRevision : null;
  const oldAccount = config.profiles[options.profile]?.keychain_account;
  const keychainAccount = `${buildKeychainAccount(options.profile, configPath)}:update:${crypto.randomBytes(16).toString('hex')}`;

  const previous = config.profiles[options.profile] || {};
  config.profiles[options.profile] = {
    ...previous,
    family,
    api_style: apiStyle,
    base_url: normalizedBaseUrl,
    root_output_dir: outputDir,
    keychain_account: keychainAccount,
    updated_at: new Date().toISOString(),
  };

  // 初始化时可以顺带把图生图适配项定下来，省得用户再跑一次 setup
  const imageOptionKeys = ['imageField', 'imageTransport', 'imageShape', 'imageEndpoint'];
  if (imageOptionKeys.some((key) => options[key] !== undefined)) {
    const target = config.profiles[options.profile];
    if (options.imageField !== undefined) target.image_field = normalizeImageField(options.imageField);
    if (options.imageTransport !== undefined) target.image_transport = normalizeImageTransport(options.imageTransport);
    if (options.imageShape !== undefined) target.image_shape = normalizeImageShape(options.imageShape);
    if (options.imageEndpoint !== undefined) target.image_endpoint = options.imageEndpoint;
  }

  // 初始化时可以直接给这个 profile 固定模型
  if (options.profileModel && !isClearModelInput(options.profileModel)) {
    config.profiles[options.profile].model = resolveModel(options.profileModel, config, null, true).key;
  }

  // 初始化时也可以一次把备用模型配好，省得再跑一次 setup
  if (options.fallbackModels?.length) {
    const primaryKey = config.profiles[options.profile].model || resolveConfiguredModel(config, family).key;
    const fallbackKeys = [];
    for (const input of options.fallbackModels) {
      const key = resolveModel(input, config, null, true).key;
      // 备用不能与首选/其他备用重复，否则同一模型会被试两次
      if (key !== primaryKey && !fallbackKeys.includes(key)) fallbackKeys.push(key);
    }
    if (fallbackKeys.length > 0) {
      config.profiles[options.profile].fallback_models = fallbackKeys;
    }
  }

  if (options.activate || !config.active_profile) {
    config.active_profile = options.profile;
  }
  config.updated_at = new Date().toISOString();

  syncGroupedProfile(config.profiles[options.profile], config);
  // Validate the complete update before writing any credential.
  const target = config.profiles[options.profile];
  resolveImageOptions({ imageField: target.image_field, imageTransport: target.image_transport, imageShape: target.image_shape, imageEndpoint: target.image_endpoint }, { family, apiStyle });
  if (options.model) resolveModel(options.model, config, options.family);
  let committed = false;
  try {
    saveKeychainSecret(keychainAccount, options.apiKey);
    saveConfig(configPath, config, { sha256: expectedRevision });
    committed = true;
  } catch (error) {
    // A failed CAS must never overwrite or remove an existing profile's key.
    try {
      const persisted = loadConfigFromPath(configPath);
      if (!Object.values(persisted?.profiles || {}).some(profile => profile.keychain_account === keychainAccount)) deleteKeychainSecret(keychainAccount);
    } catch {}
    throw error;
  }
  if (committed && oldAccount && oldAccount !== keychainAccount) {
    try {
      const persisted = loadConfigFromPath(configPath);
      if (!Object.values(persisted?.profiles || {}).some(profile => profile.keychain_account === oldAccount)) deleteKeychainSecret(oldAccount);
    } catch { console.error('提示：配置已保存，旧凭据暂未清理。'); }
  }
  saveState({ config_path: configPath });

  console.log(`配置已保存: ${configPath}`);
  console.log(`profile: ${options.profile}`);
  console.log(`interface: ${describeProfile(config.profiles[options.profile])}`);
  console.log(`base_url: ${config.profiles[options.profile].base_url}`);
  console.log(`root_output_dir: ${config.profiles[options.profile].root_output_dir}${options.outputDir ? '' : '（未指定，已自动推导）'}`);
  console.log(`active_profile: ${config.active_profile}`);
  console.log(`profile_model: ${config.profiles[options.profile].model || '（跟随全局）'}`);
  const savedFallbacks = config.profiles[options.profile].fallback_models || [];
  if (savedFallbacks.length) {
    console.log(`fallback_models: ${savedFallbacks.join(' -> ')}（首选失败时自动换）`);
  }
  if (hasImageOptions(config.profiles[options.profile])) {
    console.log(`图生图适配: ${describeImageOptions(config.profiles[options.profile])}`);
  }
}

function deleteProfile(profileName) {
  const { config, configPath } = requireConfig();
  const profile = config.profiles?.[profileName];

  if (!profile) {
    throw new Error(`profile 不存在: ${profileName}`);
  }

  const profileNames = Object.keys(config.profiles);
  delete config.profiles[profileName];

  if (config.active_profile === profileName) {
    config.active_profile = Object.keys(config.profiles).find(name => config.profiles[name].enabled !== false) || null;
  }

  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);
  if (profile.keychain_account && !Object.values(config.profiles).some(item => item.keychain_account === profile.keychain_account)) {
    try { deleteKeychainSecret(profile.keychain_account); }
    catch { console.error('配置已删除，但旧 Keychain 记录清理失败；可稍后重试清理，不影响其余配置。'); }
  }

  console.log(`已删除 profile: ${profileName}`);
  console.log(config.active_profile ? `当前 active_profile: ${config.active_profile}` : '当前没有配置；下次使用将进入初始化。已生成图片和日志保留。');
}

function renameProfile(oldName, newName) {
  if (!oldName || !newName) {
    printUsage();
    process.exit(1);
  }

  validateProfileName(newName);

  const { config, configPath } = requireConfig();
  const profile = config.profiles?.[oldName];
  if (!profile) {
    throw new Error(`profile 不存在: ${oldName}`);
  }
  if (config.profiles[newName]) {
    throw new Error(`目标 profile 已存在: ${newName}`);
  }

  config.profiles[newName] = {
    ...profile,
    updated_at: new Date().toISOString(),
  };

  delete config.profiles[oldName];

  if (config.active_profile === oldName) {
    config.active_profile = newName;
  }

  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);

  console.log(`已重命名 profile: ${oldName} -> ${newName}`);
  console.log(`当前 active_profile: ${config.active_profile}`);
}

function uninstallSkill(options) {
  const { config, configPath } = loadActiveConfig();
  let deletedKeychainCount = 0;

  if (config?.profiles && !options.keepKeychain) {
    Object.values(config.profiles).forEach((profile) => {
      if (profile.keychain_account && deleteKeychainSecret(profile.keychain_account)) {
        deletedKeychainCount += 1;
      }
    });
  }

  if (fs.existsSync(STATE_PATH)) {
    fs.unlinkSync(STATE_PATH);
  }

  if (configPath && fs.existsSync(configPath) && !options.keepConfigFile) {
    fs.unlinkSync(configPath);
  }

  // 运行日志里有历史 prompt，默认保留，只有显式要求时才清
  if (options.purgeLogs && fs.existsSync(RUNS_PATH)) {
    fs.unlinkSync(RUNS_PATH);
  }

  if (fs.existsSync(APP_DIR) && fs.readdirSync(APP_DIR).length === 0) {
    fs.rmdirSync(APP_DIR);
  }

  console.log('已执行 skill 本地卸载。');
  console.log(`state 文件: ${fs.existsSync(STATE_PATH) ? '保留' : '已删除'}`);
  console.log(`config 文件: ${options.keepConfigFile ? '保留' : '已删除或不存在'}`);
  console.log(`Keychain 记录: ${options.keepKeychain ? '保留' : `已删除 ${deletedKeychainCount} 条`}`);
  console.log(`运行日志: ${fs.existsSync(RUNS_PATH) ? '保留（含历史 prompt，如需一并删除请加 --purge-logs）' : '已删除或不存在'}`);
  console.log('说明：此命令不会删除 skill 仓库目录本身；如需移除仓库，请由用户自行删除该文件夹。');
}

function main() {
  const options = parseArgs();
  if (new Set(options.fallbackModels || []).size > 1) throw new Error('最多选择一个备选模型，请只传一个 --fallback-model。');

  if (options.list) {
    listProfiles();
    return;
  }

  if (options.listModels) {
    listModels();
    return;
  }

  if (options.addModel) {
    addCustomModel(options);
    if (options.model) {
      switchModel(options.model, options.family);
    }
    return;
  }

  if (options.deleteModel) {
    deleteCustomModel(options.deleteModel);
    return;
  }

  if (options.profileModel !== undefined && !isInitRequest(options)) {
    setProfileModel(options);
    return;
  }

  // 只给备用模型（不动首选）也是纯本地配置，不该触发初始化
  if ((options.fallbackModels?.length || options.clearFallbackModels) && !isInitRequest(options)) {
    setProfileModel(options);
    return;
  }

  // 图生图适配是纯本地配置，不触发初始化，也不要求 --base-url/--api-key
  const imageOptionFlags = [options.imageField, options.imageTransport, options.imageShape, options.imageEndpoint];
  const wantsImageOptions = options.clearImageOptions || imageOptionFlags.some((value) => value !== undefined);
  if (wantsImageOptions && !isInitRequest(options)) {
    setProfileImageOptions(options);
    return;
  }

  if (options.activateProfile) {
    activateProfile(options.activateProfile);
    return;
  }

  if (options.deleteProfile) {
    deleteProfile(options.deleteProfile);
    return;
  }

  if (options.renameProfile || options.renameTo) {
    renameProfile(options.renameProfile, options.renameTo);
    return;
  }

  if (options.uninstallSkill) {
    uninstallSkill(options);
    return;
  }

  if (options.healthCheck) {
    return healthCheck(options);
  }

  // 只有「纯 --sync-models」才在这里直接跑；带初始化参数时要先 upsert profile，
  // 否则 syncProfileModels 里的 requireConfig() 会报「尚未初始化」，profile 根本建不出来。
  if (options.syncModels && !isInitRequest(options)) {
    return syncProfileModels(options.profile);
  }

  if (!isInitRequest(options)) {
    // 只有 --model 单独出现时才是「切换全局当前模型」
    if (options.model) {
      switchModel(options.model, options.family);
      return;
    }

    printUsage();
    process.exit(1);
  }

  // 初始化和 --model 同时给出时两件事都做：先按参数建好/更新 profile，再切换全局当前模型。
  // 以前 --model 会直接 return，把整个初始化静默吞掉。
  upsertProfile(options);
  if (options.model) {
    switchModel(options.model, options.family);
  }
  if (options.syncModels) {
    return syncProfileModels(options.profile);
  }
}

try {
  Promise.resolve(main()).catch((error) => {
    console.error(`错误：${error.message}`);
    process.exit(1);
  });
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exit(1);
}
