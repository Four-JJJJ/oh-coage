const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(os.homedir(), '.oh-coage');
const STATE_PATH = path.join(APP_DIR, 'state.json');
const RUNS_PATH = path.join(APP_DIR, 'runs.jsonl');
const DEFAULT_BASE_URL = 'https://your-image-site.example/v1';
const DEFAULT_CONFIG_FILENAME = 'oh-coage-config.json';
const KEYCHAIN_SERVICE = 'oh-coage';

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

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
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

function resolveProfileOutputDir(profile, configPath) {
  const configuredDir = profile?.root_output_dir || profile?.output_dir;
  if (!configuredDir) {
    return null;
  }

  if (path.isAbsolute(configuredDir)) {
    return path.resolve(configuredDir);
  }

  return path.resolve(path.dirname(path.resolve(configPath)), configuredDir);
}

function loadConfigFromPath(configPath) {
  const config = readJson(configPath, null);
  if (!config) {
    return null;
  }

  config.profiles ||= {};
  for (const profile of Object.values(config.profiles)) {
    if (profile && !profile.root_output_dir && profile.output_dir) {
      profile.root_output_dir = profile.output_dir;
    }
    if (profile) {
      profile.resolved_root_output_dir = resolveProfileOutputDir(profile, configPath);
    }
  }
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

function formatKeychainError(action, stderr, account) {
  const message = String(stderr || '').trim();
  const actionLabel = action === 'read'
    ? '读取 Keychain 失败'
    : action === 'delete'
      ? '删除 Keychain 记录失败'
      : '写入 Keychain 失败';

  if (message.includes('The authorization was canceled by the user')) {
    return `${actionLabel}：你取消了 macOS 的 Keychain 授权弹窗。请重新执行一次，并在系统弹窗中点“允许”。${account ? ` account=${account}` : ''}`;
  }

  if (message.includes('User interaction is not allowed')) {
    return `${actionLabel}：当前 macOS 不允许进行 Keychain 交互。请确认你已登录桌面会话、登录钥匙串已解锁，然后重试。${account ? ` account=${account}` : ''}`;
  }

  if (action === 'read' && message.includes('could not be found')) {
    return `无法从 Keychain 读取 key：没有找到对应记录，请重新执行一次 setup.js 以写回该 profile 的 key。account=${account}`;
  }

  if (action === 'delete' && message.includes('could not be found')) {
    return '';
  }

  return message;
}

function saveKeychainSecret(account, secret) {
  if (!commandExists('security')) {
    throw new Error('缺少 macOS Keychain 依赖：未找到 security 命令。请先征求用户同意，再补齐该依赖，因为此 skill 需要用 Keychain 安全存储 API Key。');
  }

  const result = spawnSync('security', ['add-generic-password', '-U', '-a', account, '-s', KEYCHAIN_SERVICE, '-w', secret], {
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(formatKeychainError('write', result.stderr, account) || '写入 Keychain 失败');
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
    throw new Error(formatKeychainError('read', result.stderr, account) || `无法从 Keychain 读取 key，请检查 profile 配置: ${account}`);
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
    const stderr = formatKeychainError('delete', result.stderr, account);
    if (stderr.includes('could not be found')) {
      return false;
    }
    if (!stderr) {
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
  RUNS_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_CONFIG_FILENAME,
  KEYCHAIN_SERVICE,
  ensureDir,
  normalizeBaseUrl,
  readJson,
  writeJson,
  appendJsonl,
  loadState,
  saveState,
  getDefaultConfigPath,
  loadConfigFromPath,
  loadActiveConfig,
  resolveProfileOutputDir,
  saveConfig,
  buildKeychainAccount,
  saveKeychainSecret,
  readKeychainSecret,
  deleteKeychainSecret,
  setActiveProfile,
  commandExists,
};
