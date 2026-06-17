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
  normalizeBaseUrl,
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
      case '--health-check': parsed.healthCheck = true; break;
      case '--live': parsed.live = true; break;
    }
  }

  return parsed;
}

function printUsage() {
  console.error('用法:');
  console.error('  初始化或新增 profile:');
  console.error('    node setup.js --output-dir "/path/to/images" --profile "main" --base-url "https://example.com/v1" --api-key "KEY" [--activate]');
  console.error('  列出 profile:');
  console.error('    node setup.js --list');
  console.error('  切换当前 profile:');
  console.error('    node setup.js --activate-profile "main"');
  console.error('  删除 profile:');
  console.error('    node setup.js --delete-profile "main"');
  console.error('  重命名 profile:');
  console.error('    node setup.js --rename-profile "old-name" --to "new-name"');
  console.error('  删除 skill 本地配置和 Keychain 记录:');
  console.error('    node setup.js --uninstall-skill [--keep-config-file] [--keep-keychain]');
  console.error('  profile 健康检查:');
  console.error('    node setup.js --health-check [--live]');
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
  Object.entries(config.profiles || {}).forEach(([name, profile]) => {
    const flag = name === config.active_profile ? '*' : ' ';
    console.log(`${flag} ${name} -> ${profile.base_url} -> ${profile.root_output_dir || profile.output_dir}`);
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
  console.log(`config: ${configPath}`);
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
      const rootOutputDir = profile.root_output_dir || profile.output_dir;
      ensureDir(rootOutputDir);
      fs.accessSync(rootOutputDir, fs.constants.W_OK);
      checks.push({ item: 'root_output_dir', ok: true, detail: rootOutputDir });
    } catch (error) {
      checks.push({ item: 'root_output_dir', ok: false, detail: error.message });
    }

    try {
      const baseUrl = normalizeBaseUrl(profile.base_url);
      new URL(baseUrl);
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

function upsertProfile(options) {
  if (!options.outputDir || !options.profile || !options.baseUrl || !options.apiKey) {
    printUsage();
    process.exit(1);
  }

  ensureDir(options.outputDir);

  const { config: existingConfig, configPath: activeConfigPath } = loadActiveConfig();
  const configPath = activeConfigPath || getDefaultConfigPath(options.outputDir);
  const config = existingConfig || {
    version: 1,
    created_at: new Date().toISOString(),
    active_profile: options.profile,
    profiles: {},
  };

  const keychainAccount = config.profiles[options.profile]?.keychain_account || buildKeychainAccount(options.profile, configPath);
  saveKeychainSecret(keychainAccount, options.apiKey);

  config.profiles[options.profile] = {
    base_url: normalizeBaseUrl(options.baseUrl),
    root_output_dir: options.outputDir,
    keychain_account: keychainAccount,
    updated_at: new Date().toISOString(),
  };

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

  if (fs.existsSync(APP_DIR) && fs.readdirSync(APP_DIR).length === 0) {
    fs.rmdirSync(APP_DIR);
  }

  console.log('已执行 skill 本地卸载。');
  console.log(`state 文件: ${fs.existsSync(STATE_PATH) ? '保留' : '已删除'}`);
  console.log(`config 文件: ${options.keepConfigFile ? '保留' : '已删除或不存在'}`);
  console.log(`Keychain 记录: ${options.keepKeychain ? '保留' : `已删除 ${deletedKeychainCount} 条`}`);
  console.log('说明：此命令不会删除 skill 仓库目录本身；如需移除仓库，请由用户自行删除该文件夹。');
}

function main() {
  const options = parseArgs();

  if (options.list) {
    listProfiles();
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

  upsertProfile(options);
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
