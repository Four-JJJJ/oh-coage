#!/usr/bin/env node
/**
 * images2-gen 首次初始化和 profile 管理脚本。
 * 敏感信息只写入 macOS Keychain，本地配置只保存非敏感字段。
 */

const path = require('path');
const {
  normalizeBaseUrl,
  loadActiveConfig,
  saveState,
  getDefaultConfigPath,
  saveConfig,
  buildKeychainAccount,
  saveKeychainSecret,
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
    console.log(`${flag} ${name} -> ${profile.base_url} -> ${profile.output_dir}`);
  });
}

function activateProfile(profileName) {
  const { config, configPath } = loadActiveConfig();
  if (!config || !configPath) {
    throw new Error('尚未初始化，无法切换 profile');
  }

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
    output_dir: options.outputDir,
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
  console.log(`output_dir: ${config.profiles[options.profile].output_dir}`);
  console.log(`active_profile: ${config.active_profile}`);
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

  upsertProfile(options);
}

try {
  main();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exit(1);
}
