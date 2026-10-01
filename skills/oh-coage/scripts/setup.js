#!/usr/bin/env node
/**
 * oh-coage 首次初始化和 profile 管理脚本。
 * 敏感信息只写入 macOS Keychain，本地配置只保存非敏感字段。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const {
  APP_DIR,
  STATE_PATH,
  RUNS_PATH,
  normalizeBaseUrl,
  assertValidBaseUrl,
  loadActiveConfig,
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
} = require('./models');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--output-dir': parsed.outputDir = path.resolve(args[++i]); break;
      case '--profile': parsed.profile = args[++i]; break;
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
    }
  }

  return parsed;
}

function printUsage() {
  console.error('用法:');
  console.error('  初始化或新增 profile:');
  console.error('    node setup.js --output-dir "/path/to/images" --profile "main" --base-url "https://example.com/v1" --api-key "KEY" [--activate] [--model "image-2"]');
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
}

function requireConfig() {
  const context = loadActiveConfig();
  if (!context.config || !context.configPath) {
    throw new Error('尚未初始化。');
  }
  return context;
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
    console.log(`${flag} ${name} -> ${profile.base_url} -> ${profile.root_output_dir || profile.output_dir}${modelNote}`);
  });
}

function probeUrl(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'GET' }, (res) => {
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
    return;
  }

  for (const name of names) {
    const profile = config.profiles[name];
    const checks = [];

    checks.push({ item: 'enabled', ok: profile.enabled !== false, detail: profile.enabled === false ? 'disabled' : 'enabled' });

    try {
      const rootOutputDir = profile.resolved_root_output_dir || profile.root_output_dir || profile.output_dir;
      ensureDir(rootOutputDir);
      fs.accessSync(rootOutputDir, fs.constants.W_OK);
      checks.push({ item: 'root_output_dir', ok: true, detail: `${profile.root_output_dir || profile.output_dir} -> ${rootOutputDir}` });
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
        ? resolveModel(profile.model, config.custom_models)
        : resolveConfiguredModel(config);
      checks.push({
        item: 'model',
        ok: true,
        detail: `${profileModel.model}${profile.model ? '（profile 固定）' : '（跟随全局）'}`,
      });
    } catch (error) {
      checks.push({ item: 'model', ok: false, detail: error.message.split('\n')[0] });
    }

    const healthy = checks.every((check) => check.ok);
    const activeFlag = name === config.active_profile ? '*' : ' ';
    console.log(`${activeFlag} ${name}: ${healthy ? 'ok' : 'needs_attention'}`);
    checks.forEach((check) => {
      console.log(`  - ${check.item}: ${check.ok ? 'ok' : 'fail'} (${check.detail})`);
    });
  }
}

function activateProfile(profileName) {
  const { config, configPath } = requireConfig();
  setActiveProfile(config, profileName);
  saveConfig(configPath, config);
  console.log(`已切换当前 profile: ${profileName}`);
}

function listModels() {
  const { config } = loadActiveConfig();
  const catalog = buildModelCatalog(config?.custom_models);
  const current = resolveConfiguredModel(config);

  console.log(`current_model: ${current.key} -> ${current.model}`);
  if (!config) {
    console.log('（尚未初始化，以下仅为内置模型）');
  }

  catalog.forEach((entry) => {
    const flag = entry.key === current.key ? '*' : ' ';
    console.log(`${flag} ${entry.key} -> ${entry.model}${entry.builtin ? '' : '（自定义）'}`);
  });
}

function switchModel(modelInput) {
  if (!modelInput) {
    printUsage();
    process.exit(1);
  }

  const { config, configPath } = requireConfig();
  const resolved = resolveModel(modelInput, config.custom_models);

  config.current_model = resolved.key;
  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);

  console.log(`已切换当前模型: ${resolved.key} -> ${resolved.model}`);
  console.log('后续生成都会使用这个模型，直到你再次切换。');
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

  config.custom_models[key] = {
    model: options.modelId,
    ...(options.label ? { label: options.label } : {}),
    updated_at: new Date().toISOString(),
  };
  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);

  console.log(`已${existed ? '更新' : '添加'}自定义模型: ${key} -> ${options.modelId}`);
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

function setProfileModel(options) {
  const { config, configPath } = requireConfig();
  const targetName = options.profile || config.active_profile;
  const profile = config.profiles?.[targetName];

  if (!profile) {
    throw new Error(`profile 不存在: ${targetName}`);
  }

  profile.updated_at = new Date().toISOString();
  config.updated_at = profile.updated_at;

  if (isClearModelInput(options.profileModel)) {
    delete profile.model;
    saveConfig(configPath, config);
    console.log(`已取消 profile ${targetName} 的固定模型，将跟随全局当前模型。`);
    return;
  }

  const resolved = resolveModel(options.profileModel, config.custom_models);
  profile.model = resolved.key;
  saveConfig(configPath, config);

  console.log(`已固定 profile ${targetName} 使用模型: ${resolved.key} -> ${resolved.model}`);
}

/**
 * 是否给出了初始化参数，用来区分「切换模型」和「初始化顺带指定模型」。
 * 注意不含 --profile：它既能当初始化参数，也能给 --profile-model 指定目标，
 * 单独出现时不足以说明用户想初始化。
 */
function isInitRequest(options) {
  return Boolean(options.outputDir || options.baseUrl || options.apiKey);
}

function upsertProfile(options) {
  if (!options.outputDir || !options.profile || !options.baseUrl || !options.apiKey) {
    printUsage();
    process.exit(1);
  }

  // 存进去之前就拦住非法 base_url，别等到生成时才发现
  const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl);
  assertValidBaseUrl(normalizedBaseUrl);

  ensureDir(options.outputDir);

  const { config: existingConfig, configPath: activeConfigPath } = loadActiveConfig();
  const configPath = activeConfigPath || getDefaultConfigPath(options.outputDir);
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

  const keychainAccount = config.profiles[options.profile]?.keychain_account || buildKeychainAccount(options.profile, configPath);
  saveKeychainSecret(keychainAccount, options.apiKey);

  config.profiles[options.profile] = {
    base_url: normalizedBaseUrl,
    root_output_dir: options.outputDir,
    keychain_account: keychainAccount,
    updated_at: new Date().toISOString(),
  };

  // 初始化时可以直接给这个 profile 固定模型
  if (options.profileModel && !isClearModelInput(options.profileModel)) {
    config.profiles[options.profile].model = resolveModel(options.profileModel, config.custom_models).key;
  }

  if (options.activate || !config.active_profile) {
    config.active_profile = options.profile;
  }
  config.updated_at = new Date().toISOString();

  saveConfig(configPath, config);
  saveState({ config_path: configPath });

  console.log(`配置已保存: ${configPath}`);
  console.log(`profile: ${options.profile}`);
  console.log(`base_url: ${config.profiles[options.profile].base_url}`);
  console.log(`root_output_dir: ${config.profiles[options.profile].root_output_dir}`);
  console.log(`active_profile: ${config.active_profile}`);
  console.log(`profile_model: ${config.profiles[options.profile].model || '（跟随全局）'}`);
}

function deleteProfile(profileName) {
  const { config, configPath } = requireConfig();
  const profile = config.profiles?.[profileName];

  if (!profile) {
    throw new Error(`profile 不存在: ${profileName}`);
  }

  const profileNames = Object.keys(config.profiles);
  if (profileNames.length === 1) {
    throw new Error('当前只剩最后一个 profile，不能直接删除。若要彻底移除，请使用 --uninstall-skill。');
  }

  if (profile.keychain_account) {
    deleteKeychainSecret(profile.keychain_account);
  }

  delete config.profiles[profileName];

  if (config.active_profile === profileName) {
    config.active_profile = Object.keys(config.profiles)[0];
  }

  config.updated_at = new Date().toISOString();
  saveConfig(configPath, config);

  console.log(`已删除 profile: ${profileName}`);
  console.log(`当前 active_profile: ${config.active_profile}`);
}

function renameProfile(oldName, newName) {
  if (!oldName || !newName) {
    printUsage();
    process.exit(1);
  }

  const { config, configPath } = requireConfig();
  const profile = config.profiles?.[oldName];
  if (!profile) {
    throw new Error(`profile 不存在: ${oldName}`);
  }
  if (config.profiles[newName]) {
    throw new Error(`目标 profile 已存在: ${newName}`);
  }

  const newKeychainAccount = buildKeychainAccount(newName, configPath);
  config.profiles[newName] = {
    ...profile,
    keychain_account: newKeychainAccount,
    updated_at: new Date().toISOString(),
  };

  if (profile.keychain_account) {
    try {
      const key = readKeychainSecret(profile.keychain_account);
      saveKeychainSecret(newKeychainAccount, key);
      deleteKeychainSecret(profile.keychain_account);
    } catch (error) {
      delete config.profiles[newName];
      throw error;
    }
  }

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
      switchModel(options.model);
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

  if (!isInitRequest(options)) {
    // 只有 --model 单独出现时才是「切换全局当前模型」
    if (options.model) {
      switchModel(options.model);
      return;
    }

    printUsage();
    process.exit(1);
  }

  // 初始化和 --model 同时给出时两件事都做：先按参数建好/更新 profile，再切换全局当前模型。
  // 以前 --model 会直接 return，把整个初始化静默吞掉。
  upsertProfile(options);
  if (options.model) {
    switchModel(options.model);
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
