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

const commandExistsCache = new Map();

function commandExists(command) {
  if (!commandExistsCache.has(command)) {
    const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf-8' });
    commandExistsCache.set(command, result.status === 0);
  }

  return commandExistsCache.get(command);
}

function ensureDir(dirPath, mode) {
  fs.mkdirSync(dirPath, mode ? { recursive: true, mode } : { recursive: true });
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function assertValidBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`base_url 不是合法 URL: ${baseUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`base_url 仅支持 http/https，当前为 ${parsed.protocol}//`);
  }

  return parsed;
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`无法解析 JSON 配置文件 ${filePath}：${error.message}`);
  }
}

/** APP_DIR 里存的是运行日志（含 prompt），收紧到 0700；其他目录保持默认权限。 */
function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  ensureDir(dir, dir === APP_DIR ? 0o700 : undefined);
}

function writeJson(filePath, value) {
  ensureParentDir(filePath);

  // 原子写：先落临时文件再 rename，避免写到一半崩溃留下半个 JSON 把配置整个弄坏
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function appendJsonl(filePath, value) {
  ensureParentDir(filePath);
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
  // resolved_root_output_dir 是按配置文件所在位置算出来的派生值，绝不能落盘：
  // 配置文件一旦被搬动（典型场景是放进 iCloud 同步到另一台机器），
  // 过期的绝对路径会盖掉本应重新解析的相对 root_output_dir
  const persisted = {
    ...config,
    profiles: Object.fromEntries(
      Object.entries(config.profiles || {}).map(([name, profile]) => {
        const { resolved_root_output_dir, ...rest } = profile || {};
        return [name, rest];
      }),
    ),
  };

  writeJson(configPath, persisted);
}

function buildKeychainAccount(profileName, configPath) {
  const hash = crypto.createHash('sha1').update(path.resolve(configPath)).digest('hex').slice(0, 12);
  return `${profileName}:${hash}`;
}

function formatKeychainError(action, stderr) {
  const message = String(stderr || '').trim();
  const actionLabel = action === 'read'
    ? '读取 Keychain 失败'
    : action === 'delete'
      ? '删除 Keychain 记录失败'
      : '写入 Keychain 失败';

  if (message.includes('The authorization was canceled by the user')) {
    return `${actionLabel}：你取消了 macOS 的 Keychain 授权弹窗。请重新执行一次，并在系统弹窗中点“允许”。`;
  }

  if (message.includes('User interaction is not allowed')) {
    return `${actionLabel}：当前 macOS 不允许进行 Keychain 交互。请确认你已登录桌面会话、登录钥匙串已解锁，然后重试。`;
  }

  if (action === 'read' && message.includes('could not be found')) {
    return '无法从 Keychain 读取 key：没有找到对应记录，请重新执行一次 setup.js 以写回该 profile 的 key。';
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

  // 首选交互式写入：security 自己都标注 -w <password> 不安全，因为明文密码会出现在进程 argv 里，
  // 同机其他进程在那一瞬间可以读到。把 -w 放在末位可以让它从 stdin 读密码（会问两次：输入 + 确认）。
  const prompted = spawnSync(
    'security',
    ['add-generic-password', '-U', '-a', account, '-s', KEYCHAIN_SERVICE, '-w'],
    { encoding: 'utf-8', input: `${secret}\n${secret}\n` },
  );

  if (prompted.status === 0) {
    return;
  }

  // 少数环境（没有可用 stdin / tty）下提示式写入会失败，退回 argv 方式，保证初始化不被打断
  process.stderr.write('提示：当前环境无法通过 stdin 写入密钥，已退回命令行参数方式，该值会短暂出现在进程列表里。\n');
  const fallback = spawnSync('security', ['add-generic-password', '-U', '-a', account, '-s', KEYCHAIN_SERVICE, '-w', secret], {
    encoding: 'utf-8',
  });

  if (fallback.status !== 0) {
    const stderr = fallback.stderr || prompted.stderr;
    throw new Error(formatKeychainError('write', stderr) || '写入 Keychain 失败');
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
    throw new Error(formatKeychainError('read', result.stderr) || '无法从 Keychain 读取 key，请检查 profile 配置。');
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
    const stderr = formatKeychainError('delete', result.stderr);
    if (stderr.includes('could not be found')) {
      return false;
    }
    if (!stderr) {
      return false;
    }
    throw new Error(stderr || '删除 Keychain 记录失败');
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
  assertValidBaseUrl,
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
