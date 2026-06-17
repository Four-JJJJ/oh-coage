const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(os.homedir(), '.images2-gen');
const STATE_PATH = path.join(APP_DIR, 'state.json');
const DEFAULT_BASE_URL = 'https://dragoncode.codes/gpt-image/v1';
const DEFAULT_CONFIG_FILENAME = 'images2-gen-config.json';
const KEYCHAIN_SERVICE = 'images2-gen';

function commandExists(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf-8' });
  return result.status === 0;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`无法解析 JSON 文件 ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function loadState() {
  return readJson(STATE_PATH, {});
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

function getDefaultConfigPath(outputDir) {
  return path.join(path.resolve(outputDir), DEFAULT_CONFIG_FILENAME);
}

function loadConfigFromPath(configPath) {
  const config = readJson(configPath, null);
  if (!config) {
    return null;
  }

  config.profiles ||= {};
  return config;
}

function loadActiveConfig() {
  const state = loadState();
  if (!state.config_path) {
    return { state, config: null, configPath: null };
  }

  const configPath = path.resolve(state.config_path);
  return { state, config: loadConfigFromPath(configPath), configPath };
}

function saveConfig(configPath, config) {
  writeJson(configPath, config);
}

function buildKeychainAccount(profileName, configPath) {
  const hash = crypto.createHash('sha1').update(path.resolve(configPath)).digest('hex').slice(0, 12);
  return `${profileName}:${hash}`;
}

function saveKeychainSecret(account, secret) {
  if (!commandExists('security')) {
    throw new Error('缺少 macOS Keychain 依赖：未找到 security 命令。请先征求用户同意，再补齐该依赖，因为此 skill 需要用 Keychain 安全存储 API Key。');
  }

  const result = spawnSync('security', ['add-generic-password', '-U', '-a', account, '-s', KEYCHAIN_SERVICE, '-w', secret], {
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || '写入 Keychain 失败');
  }
}

function readKeychainSecret(account) {
  if (!commandExists('security')) {
    throw new Error('缺少 macOS Keychain 依赖：未找到 security 命令。请先征求用户同意，再补齐该依赖，因为此 skill 需要从 Keychain 读取 API Key。');
  }

  const result = spawnSync('security', ['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w'], {
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(`无法从 Keychain 读取 key，请检查 profile 配置: ${account}`);
  }

  return result.stdout.trim();
}

function deleteKeychainSecret(account) {
  if (!commandExists('security')) {
    throw new Error('缺少 macOS Keychain 依赖：未找到 security 命令。请先征求用户同意，再补齐该依赖，因为此 skill 需要清理 Keychain 中保存的 API Key。');
  }

  const result = spawnSync('security', ['delete-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE], {
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (stderr.includes('could not be found')) {
      return false;
    }
    throw new Error(stderr || `删除 Keychain 记录失败: ${account}`);
  }

  return true;
}

function setActiveProfile(config, profileName) {
  if (!config.profiles?.[profileName]) {
    throw new Error(`profile 不存在: ${profileName}`);
  }

  config.active_profile = profileName;
  config.updated_at = new Date().toISOString();
}

module.exports = {
  APP_DIR,
  STATE_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_CONFIG_FILENAME,
  KEYCHAIN_SERVICE,
  ensureDir,
  normalizeBaseUrl,
  readJson,
  writeJson,
  loadState,
  saveState,
  getDefaultConfigPath,
  loadConfigFromPath,
  loadActiveConfig,
  saveConfig,
  buildKeychainAccount,
  saveKeychainSecret,
  readKeychainSecret,
  deleteKeychainSecret,
  setActiveProfile,
  commandExists,
};
