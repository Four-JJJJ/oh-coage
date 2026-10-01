#!/usr/bin/env node
/**
 * GPT-Image-2 图片生成脚本
 * 支持 profile 配置、自动 fallback、运行日志，以及同步/异步接口结果保存。
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  DEFAULT_BASE_URL,
  RUNS_PATH,
  normalizeBaseUrl,
  assertValidBaseUrl,
  loadActiveConfig,
  readKeychainSecret,
  ensureDir,
  appendJsonl,
} = require('./config-store');
const { resolveModel, resolveModelForProfile } = require('./models');

const VALID_4K_SIZES = new Set(['16:9', '9:16', '2:1', '1:2', '21:9', '9:21']);
const REQUEST_TIMEOUT_MS = 90 * 1000;
const POLL_TIMEOUT_MS = 20 * 1000;
const TASK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 2;
const MAX_POLL_FAILURES = 3;
const MAX_REDIRECTS = 5;
const MAX_ERROR_SNIPPET = 300;
const MAX_LOG_ERROR_LENGTH = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
// 站点各写各的，把常见的终态写法定下来，避免因为不认某个词而空转到 5 分钟超时
const COMPLETED_TASK_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished']);
const FAILED_TASK_STATUSES = new Set(['failed', 'failure', 'error', 'canceled', 'cancelled']);
const POLL_DELAYS_MS = [5, 10, 20, 30, 60, 60, 60].map((seconds) => seconds * 1000);
const IMAGE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

function printSetupInstructions() {
  console.error('错误：尚未完成 oh-coage 初始化。');
  console.error('请先让 agent 收集以下信息后运行 setup.js：');
  console.error('1. 图片总保存目录');
  console.error('2. profile 名称');
  console.error('3. base_url');
  console.error('4. api_key');
  console.error('');
  console.error('示例：');
  console.error('node "$SKILL_DIR/scripts/setup.js" \\');
  console.error('  --output-dir "/absolute/path/to/save" \\');
  console.error('  --profile "default" \\');
  console.error('  --base-url "https://your-image-site.example/v1" \\');
  console.error('  --api-key "YOUR_KEY"');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateForLog(value, maxLength = MAX_ERROR_SNIPPET) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…（已截断，原始 ${text.length} 字符）` : text;
}

/** 给错误打上标记，让 classifyError 明确知道它是「该换 profile」而不是「无法归类」。 */
function markFallback(error, kind) {
  error.fallback = true;
  if (kind) error.kind = kind;
  return error;
}

function parseHttpStatus(error) {
  const match = String(error?.message || '').match(/HTTP\s+(\d{3})/);
  return match ? Number(match[1]) : null;
}

function classifyError(error) {
  const message = String(error?.message || '');
  const statusCode = parseHttpStatus(error);
  const lower = message.toLowerCase();

  if (error?.fallback === true) {
    return { kind: error.kind || 'unknown', statusCode, retryable: false, fallback: true };
  }

  if (statusCode === 401 || statusCode === 403) {
    return { kind: 'auth', statusCode, retryable: false, fallback: true };
  }
  if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return { kind: statusCode === 429 ? 'rate_limit' : 'upstream', statusCode, retryable: true, fallback: true };
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('socket hang up') || lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('enotfound')) {
    return { kind: 'network', statusCode, retryable: true, fallback: true };
  }

  return { kind: 'unknown', statusCode, retryable: false, fallback: false };
}

function request(url, options, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, (res) => {
      const chunks = [];
      // 响应流中途出错（如连接被重置）会触发 'error'，不处理会变成未捕获异常直接崩进程
      res.on('error', reject);
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${truncateForLog(raw)}`));
          return;
        }

        if (!raw) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function extractImagePayload(result) {
  const data = result?.data;
  const firstData = Array.isArray(data) ? data[0] : data;
  const taskResult = data?.result || result?.result;
  const firstImage = taskResult?.images?.[0] || firstData?.image || firstData;
  const urlValue = firstData?.url || firstImage?.url || firstImage?.image_url;
  const b64Value = firstData?.b64_json || firstImage?.b64_json || firstImage?.base64;

  const imageUrl = Array.isArray(urlValue) ? urlValue[0] : urlValue;
  const base64 = Array.isArray(b64Value) ? b64Value[0] : b64Value;

  return { imageUrl, base64 };
}

async function submitGeneration(apiKey, baseUrl, prompt, size, resolution, imageUrls, model) {
  const body = {
    model,
    prompt,
    n: 1,
    size,
    resolution,
  };

  if (imageUrls.length > 0) {
    body.image_urls = imageUrls;
  }

  const result = await request(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  }, JSON.stringify(body), REQUEST_TIMEOUT_MS);

  const taskId = result?.data?.[0]?.task_id || result?.data?.task_id || result?.task_id;
  if (taskId) {
    return { mode: 'async', taskId };
  }

  const image = extractImagePayload(result);
  if (image.imageUrl || image.base64) {
    return { mode: 'sync', image };
  }

  throw new Error(`无法识别生成接口返回结构: ${truncateForLog(JSON.stringify(result), MAX_ERROR_SNIPPET)}`);
}

/**
 * 轮询响应里的图片可能藏在 {result: {...}} 里，也可能就直接铺在顶层。
 * 两种形状都试一遍，避免因为站点风格不同而误报「找不到图片结果」。
 */
function extractTaskImage(payload) {
  const fromResult = extractImagePayload({ data: { result: payload?.result } });
  if (fromResult.imageUrl || fromResult.base64) {
    return fromResult;
  }

  return extractImagePayload({ data: payload });
}

function pollDelayForAttempt(attemptIndex) {
  return POLL_DELAYS_MS[Math.min(attemptIndex, POLL_DELAYS_MS.length - 1)];
}

async function pollTask(apiKey, baseUrl, taskId, options = {}) {
  const sleepFn = options.sleep || sleep;
  const requestFn = options.request || request;
  const now = options.now || Date.now;
  const start = now();
  let pollCount = 0;
  let consecutiveFailures = 0;

  while (true) {
    if (now() - start > TASK_TIMEOUT_MS) {
      throw new Error(`任务超时（超过 ${TASK_TIMEOUT_MS}ms，已轮询 ${pollCount} 次）`);
    }

    let payload;
    try {
      const result = await requestFn(`${baseUrl}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }, null, POLL_TIMEOUT_MS);

      payload = result?.data;
      if (!payload || typeof payload !== 'object') {
        throw new Error(`任务查询返回结构无法识别: ${truncateForLog(JSON.stringify(result), MAX_ERROR_SNIPPET)}`);
      }

      consecutiveFailures = 0;
    } catch (error) {
      const classification = classifyError(error);
      consecutiveFailures += 1;

      if (!classification.retryable || consecutiveFailures > MAX_POLL_FAILURES) {
        // 不可重试（结构非法、鉴权失败），或连续失败过多：交给上层 fallback，避免无限轮询
        throw markFallback(error, classification.kind);
      }

      const delay = pollDelayForAttempt(consecutiveFailures - 1);
      const status = classification.statusCode ? ` ${classification.statusCode}` : '';
      process.stderr.write(`任务查询失败（${classification.kind}${status}），${Math.round(delay / 1000)}s 后重试（连续失败 ${consecutiveFailures}/${MAX_POLL_FAILURES}）\n`);
      await sleepFn(delay);
      continue;
    }

    pollCount += 1;
    const normalizedStatus = String(payload.status || '').toLowerCase();

    if (COMPLETED_TASK_STATUSES.has(normalizedStatus)) {
      const image = extractTaskImage(payload);
      if (image.imageUrl || image.base64) {
        return image;
      }
      throw new Error('任务已完成，但未找到图片结果');
    }

    if (FAILED_TASK_STATUSES.has(normalizedStatus)) {
      throw new Error(payload.error?.message || `任务失败（status=${payload.status}）`);
    }

    // 少数站点不返回 status，直接把结果放在轮询响应里
    if (!normalizedStatus) {
      const image = extractTaskImage(payload);
      if (image.imageUrl || image.base64) {
        return image;
      }
    }

    const delay = pollDelayForAttempt(pollCount - 1);
    process.stderr.write(`生成中... ${payload.progress || 0}%（status=${normalizedStatus || '未提供'}，第 ${pollCount} 次回收，${Math.round(delay / 1000)}s 后继续）\n`);
    await sleepFn(delay);
  }
}

function inferExtension(contentType, source) {
  if (contentType?.includes('png') || source?.startsWith('data:image/png')) return '.png';
  if (contentType?.includes('webp') || source?.startsWith('data:image/webp')) return '.webp';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg') || source?.startsWith('data:image/jpeg')) return '.jpg';
  return '.png';
}

/** 只在响应头明确给出图片类型时返回扩展名，无法判断时返回 null。 */
function inferExtensionFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('gif')) return '.gif';
  return null;
}

/** 从下载地址的 pathname 猜扩展名，忽略 query string，猜不出返回 null。 */
function inferExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    for (const extension of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
      if (pathname.endsWith(extension)) {
        return extension === '.jpeg' ? '.jpg' : extension;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function looksLikeRemoteImageReference(value) {
  return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
}

function imageFileToDataUri(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('参考图片不存在');
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error('参考图片不是文件');
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES.get(extension);
  if (!mimeType) {
    throw new Error(`不支持的参考图片格式: ${extension || '无扩展名'}。支持 png、jpg、jpeg、webp、gif。`);
  }

  const encoded = fs.readFileSync(resolvedPath).toString('base64');
  return `data:${mimeType};base64,${encoded}`;
}

function normalizeImageReferences(imageUrls) {
  return imageUrls.map((value) => {
    if (looksLikeRemoteImageReference(value)) {
      return value;
    }

    return imageFileToDataUri(value);
  });
}

function formatTimestampForDir(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function buildOutputPath(output, extension, runDir) {
  if (output) {
    ensureDir(path.dirname(output));
    return output;
  }

  ensureDir(runDir);
  return path.join(runDir, `oh-coage-${Date.now()}${extension}`);
}

/** 判断主机名是否指向本地/内网/保留地址。用于下载前给出 SSRF 提示。 */
function isPrivateOrReservedHost(hostname) {
  if (!hostname) return false;

  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === 'localhost.localdomain') return true;

  const ip = host.replace(/^\[|\]$/g, ''); // 去掉 IPv6 的方括号

  // IPv4 字面量
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                 // 169.254.0.0/16（链路本地 + 云元数据）
    if (a === 127) return true;                              // 127.0.0.0/8
    if (a === 0) return true;                                // 0.0.0.0/8
    return false;
  }

  // IPv6 字面量
  if (ip === '::' || ip === '::1') return true;              // 未指定 / 回环
  if (ip.startsWith('fe80:')) return true;                   // 链路本地
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 唯一本地

  return false;
}

function downloadToFile(url, filePath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`下载地址不合法: ${truncateForLog(url)}`));
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`不支持的下载协议: ${parsed.protocol}//`));
      return;
    }

    // SSRF 提示：下载地址若指向本地/内网/云元数据地址，脚本会直接访问，提醒用户确认可信。
    if (isPrivateOrReservedHost(parsed.hostname)) {
      process.stderr.write(`警告：图片下载地址指向本地/内网/保留地址 (${parsed.hostname})，脚本会直接访问该地址，请确认其可信。\n`);
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'oh-coage/0.1 (+https://github.com/Four-JJJJ/oh-coage)',
        'Accept': 'image/*,*/*;q=0.8',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;

      if (REDIRECT_STATUS_CODES.has(statusCode)) {
        const location = res.headers.location;
        res.resume();

        if (!location) {
          reject(new Error(`下载失败，HTTP ${statusCode} 但响应缺少 Location`));
          return;
        }
        if (redirectsLeft <= 0) {
          reject(new Error(`下载失败，重定向次数超过 ${MAX_REDIRECTS} 次`));
          return;
        }

        let nextUrl;
        try {
          nextUrl = new URL(location, url).toString();
        } catch {
          reject(new Error(`下载失败，重定向地址不合法: ${truncateForLog(location)}`));
          return;
        }

        downloadToFile(nextUrl, filePath, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (statusCode >= 400) {
        res.resume();
        reject(new Error(`下载失败，HTTP ${statusCode}`));
        return;
      }

      const target = fs.createWriteStream(filePath);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        target.destroy();
        // 清理写了一半的残文件，避免留下看起来正常的空图
        fs.rm(filePath, { force: true }, () => reject(error));
      };

      res.on('error', fail);
      target.on('error', fail);
      res.pipe(target);
      target.on('finish', () => {
        if (settled) return;
        settled = true;
        target.close(() => resolve(String(res.headers['content-type'] || '')));
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

function buildRunDir(rootOutputDir, timestamp) {
  return path.join(rootOutputDir, formatTimestampForDir(timestamp));
}

function writeRunMeta(runDir, meta) {
  if (!runDir) return;
  ensureDir(runDir);
  fs.writeFileSync(path.join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

async function saveImage(image, output, runDir) {
  if (!output && !runDir) {
    return null;
  }

  if (image.base64) {
    const dataUri = image.base64.startsWith('data:') ? image.base64 : `data:image/png;base64,${image.base64}`;
    const [, meta, encoded] = dataUri.match(/^data:([^;]+);base64,([\s\S]+)$/) || [];
    if (!encoded) {
      throw new Error('base64 图片格式不合法');
    }

    const filePath = buildOutputPath(output, inferExtension(meta, dataUri), runDir);
    fs.writeFileSync(filePath, Buffer.from(encoded, 'base64'));
    return filePath;
  }

  if (image.imageUrl) {
    // 先按 URL 猜扩展名落到磁盘，下载后再按响应头纠正
    const guessedExtension = inferExtensionFromUrl(image.imageUrl) || '.png';
    const filePath = buildOutputPath(output, guessedExtension, runDir);
    const contentType = await downloadToFile(image.imageUrl, filePath);

    if (!output) {
      const actualExtension = inferExtensionFromContentType(contentType);
      if (actualExtension && actualExtension !== guessedExtension) {
        const renamedPath = `${filePath.slice(0, -guessedExtension.length)}${actualExtension}`;
        fs.renameSync(filePath, renamedPath);
        return renamedPath;
      }
    }

    return filePath;
  }

  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { size: '1:1', resolution: '2k', imageUrls: [], autoFallback: true };

  // 取值并校验「后面确实跟着一个非 -- 的值」，避免缺值时后续 path.resolve / 读文件抛难懂的 TypeError
  const value = (index, flag) => {
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      console.error(`${flag} 缺少参数值。`);
      process.exit(1);
    }
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      // prompt 允许以 - 开头，且缺失会在下面统一拦截
      case '--prompt': parsed.prompt = args[++i]; break;
      case '--model': parsed.model = value(i++, '--model'); break;
      case '--size': parsed.size = value(i++, '--size'); break;
      case '--resolution': parsed.resolution = value(i++, '--resolution'); break;
      case '--image-url': parsed.imageUrls.push(value(i++, '--image-url')); break;
      case '--base-url': parsed.baseUrl = value(i++, '--base-url'); break;
      case '--api-key': parsed.apiKey = value(i++, '--api-key'); break;
      case '--output': parsed.output = path.resolve(value(i++, '--output')); break;
      case '--out-dir': parsed.outDir = path.resolve(value(i++, '--out-dir')); break;
      case '--profile': parsed.profile = value(i++, '--profile'); break;
      case '--no-fallback': parsed.autoFallback = false; break;
    }
  }

  if (!parsed.prompt) {
    console.error('用法: node generate.js --prompt "提示词" [--model NAME] [--profile NAME] [--size 1:1] [--resolution 2k] [--image-url URL] [--base-url URL] [--api-key KEY] [--output FILE | --out-dir DIR] [--no-fallback]');
    process.exit(1);
  }

  return parsed;
}

function getProfilePriority(profile, name, activeProfileName, preferredProfileName) {
  if (preferredProfileName && name === preferredProfileName) return -1000;
  if (!preferredProfileName && name === activeProfileName) return -500;
  if (typeof profile.priority === 'number') return profile.priority;
  return 100;
}

function resolveRuntimeConfig(cli) {
  const { config } = loadActiveConfig();
  const activeProfileName = config?.active_profile;
  const explicitProfile = cli.profile;
  const profiles = config?.profiles || {};

  // 安全提示：--base-url 覆盖站点地址后，若仍从 Keychain 取 key，会把该 key 发到新地址。
  // 这是「临时测试新站点」的合法用法，但要让用户知道代价，避免被诱导把真实 key 发到不可信主机。
  const baseUrlOverridden = Boolean(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL);
  if (baseUrlOverridden && !cli.apiKey && !process.env.IMAGES2_GEN_API_KEY && Object.keys(profiles).length > 0) {
    process.stderr.write('警告：本次用 --base-url 覆盖了站点地址，但仍会使用 profile 存于 Keychain 的 API Key，该 key 会被发送到上面的新地址。请确认目标地址可信；临时测试新站点建议同时用 --api-key 显式传一个测试 key。\n');
  }

  if (!cli.apiKey && !process.env.IMAGES2_GEN_API_KEY && !Object.keys(profiles).length) {
    printSetupInstructions();
    process.exit(1);
  }

  const candidateProfiles = Object.entries(profiles)
    .filter(([, profile]) => profile && profile.enabled !== false)
    .sort((a, b) => {
      const pa = getProfilePriority(a[1], a[0], activeProfileName, explicitProfile);
      const pb = getProfilePriority(b[1], b[0], activeProfileName, explicitProfile);
      if (pa !== pb) return pa - pb;
      return a[0].localeCompare(b[0]);
    });

  if (explicitProfile && !profiles[explicitProfile] && !cli.apiKey) {
    throw new Error(`profile 不存在: ${explicitProfile}`);
  }

  const manualCandidate = cli.apiKey ? [{
    name: explicitProfile || 'manual',
    apiKey: cli.apiKey || process.env.IMAGES2_GEN_API_KEY,
    baseUrl: normalizeBaseUrl(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL || DEFAULT_BASE_URL),
    rootOutputDir: cli.outDir ? path.resolve(cli.outDir) : null,
    outputOverride: cli.output || null,
    modelInput: null,
    source: cli.apiKey ? 'cli' : 'env',
  }] : [];

  const configCandidates = candidateProfiles.map(([name, profile]) => ({
    name,
    keychainAccount: profile.keychain_account,
    baseUrl: normalizeBaseUrl(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL || profile.base_url || DEFAULT_BASE_URL),
    rootOutputDir: cli.outDir ? path.resolve(cli.outDir) : path.resolve(profile.resolved_root_output_dir || profile.root_output_dir || profile.output_dir || process.cwd()),
    outputOverride: cli.output || null,
    // profile 可以固定自己的模型；没有就跟随全局
    modelInput: profile.model || null,
    source: 'profile',
  }));

  const candidates = manualCandidate.length > 0
    ? (cli.autoFallback ? manualCandidate.concat(configCandidates) : manualCandidate)
    : (cli.autoFallback ? configCandidates : configCandidates.slice(0, 1));

  if (!candidates.length) {
    printSetupInstructions();
    process.exit(1);
  }

  // --model 是本次全局指定的，先解析一次：写错了就直接报错，不在每个候选上重复失败
  const cliModelEntry = cli.model ? resolveModel(cli.model, config?.custom_models) : null;

  // base_url 不合法（拼错、用了非 http/https 协议）或固定了未知模型的 profile
  // 直接跳过，不拖垮整轮 fallback
  const usableCandidates = [];
  for (const candidate of candidates) {
    try {
      assertValidBaseUrl(candidate.baseUrl);
    } catch (error) {
      process.stderr.write(`跳过 profile=${candidate.name}：${error.message}\n`);
      continue;
    }

    try {
      candidate.model = resolveModelForProfile({
        cliModelEntry,
        profileModelKey: candidate.modelInput,
        config,
      });
    } catch (error) {
      process.stderr.write(`跳过 profile=${candidate.name}：${error.message.split('\n')[0]}\n`);
      continue;
    }

    usableCandidates.push(candidate);
  }

  if (!usableCandidates.length) {
    throw new Error('没有可用的 profile 可尝试，请运行 setup.js --health-check 检查配置。');
  }

  return {
    candidates: usableCandidates,
  };
}

function buildLogRecordBase(cli, startedAt) {
  return {
    started_at: startedAt.toISOString(),
    prompt: cli.prompt,
    prompt_preview: cli.prompt.slice(0, 200),
    prompt_sha1: crypto.createHash('sha1').update(cli.prompt).digest('hex'),
    image_url_count: cli.imageUrls.length,
    size: cli.size,
    resolution: cli.resolution,
    // 实际使用的模型可能因候选 profile 而异，成功后再补 model/model_key/model_source
    requested_model: cli.model || null,
    explicit_profile: cli.profile || null,
    auto_fallback: cli.autoFallback,
  };
}

function writeRunLog(record) {
  appendJsonl(RUNS_PATH, record);
}

const RETRY_DELAY_MS = { rate_limit: 1500, network: 1000, upstream: 1000 };

async function runCandidate(candidate, cli, finalResolution, runRecord) {
  const attemptStartedAt = new Date();
  const attempt = {
    profile: candidate.name,
    base_url: candidate.baseUrl,
    model: candidate.model.model,
    model_key: candidate.model.key,
    model_source: candidate.model.source,
    started_at: attemptStartedAt.toISOString(),
  };

  let candidateApiKey;
  try {
    candidateApiKey = candidate.apiKey || readKeychainSecret(candidate.keychainAccount);
  } catch (error) {
    // Keychain 读不到 key 只说明这一个 profile 不可用，应该交给上层 fallback，而不是整轮退出
    attempt.status = 'failed';
    attempt.last_error = truncateForLog(error.message, MAX_LOG_ERROR_LENGTH);
    attempt.error_kind = 'keychain';
    attempt.completed_at = new Date().toISOString();
    attempt.duration_ms = Date.now() - attemptStartedAt.getTime();
    runRecord.attempts.push({ ...attempt });
    throw markFallback(error, 'keychain');
  }

  const mode = cli.imageUrls.length > 0 ? '图生图' : '文生图';
  process.stderr.write(`正在提交${mode}任务: profile=${candidate.name}, base_url=${candidate.baseUrl}, model=${candidate.model.model}, prompt=${cli.prompt}, size=${cli.size}, resolution=${finalResolution}\n`);
  if (candidate.model.source === 'default') {
    process.stderr.write(`提示：当前使用默认模型 ${candidate.model.model}，可用 setup.js --model 切换。\n`);
  }
  if (cli.imageUrls.length > 0) {
    process.stderr.write(`参考图片: ${cli.imageUrls.length} 张\n`);
  }

  let lastError = null;
  for (let index = 1; index <= MAX_RETRY_ATTEMPTS; index++) {
    attempt.try_count = index;
    try {
      const submitted = await submitGeneration(candidateApiKey, candidate.baseUrl, cli.prompt, cli.size, finalResolution, cli.imageUrls, candidate.model.model);
      attempt.response_mode = submitted.mode;

      const image = submitted.mode === 'async'
        ? await (attempt.task_id = submitted.taskId, process.stderr.write(`任务已提交: ${submitted.taskId}\n`), pollTask(candidateApiKey, candidate.baseUrl, submitted.taskId))
        : (process.stderr.write('接口直接返回了图片结果\n'), submitted.image);

      const runDir = candidate.outputOverride
        ? null
        : buildRunDir(candidate.rootOutputDir || process.cwd(), attemptStartedAt);
      const savedPath = await saveImage(image, candidate.outputOverride, runDir);

      attempt.status = 'success';
      attempt.completed_at = new Date().toISOString();
      attempt.duration_ms = Date.now() - attemptStartedAt.getTime();
      attempt.saved_path = savedPath;
      attempt.run_dir = runDir;

      writeRunMeta(runDir, {
        prompt: cli.prompt,
        profile: candidate.name,
        base_url: candidate.baseUrl,
        model: candidate.model.model,
        model_key: candidate.model.key,
        size: cli.size,
        resolution: finalResolution,
        started_at: attemptStartedAt.toISOString(),
        completed_at: attempt.completed_at,
        saved_path: savedPath,
        task_id: attempt.task_id || null,
        image_url_count: cli.imageUrls.length,
      });

      runRecord.attempts.push(attempt);
      return { attempt, savedPath, runDir, image };
    } catch (error) {
      lastError = error;
      const classification = classifyError(error);
      attempt.status = 'failed';
      attempt.last_error = truncateForLog(error.message, MAX_LOG_ERROR_LENGTH);
      attempt.error_kind = classification.kind;
      attempt.status_code = classification.statusCode;
      attempt.completed_at = new Date().toISOString();
      attempt.duration_ms = Date.now() - attemptStartedAt.getTime();

      // retryable 覆盖限流、网络抖动和 5xx 上游故障，统一在同 profile 上退避重试一次
      if (classification.retryable && index < MAX_RETRY_ATTEMPTS) {
        const delay = (RETRY_DELAY_MS[classification.kind] || 1000) * index;
        const status = classification.statusCode ? ` ${classification.statusCode}` : '';
        process.stderr.write(`遇到 ${classification.kind}${status}，${delay}ms 后重试当前 profile...\n`);
        await sleep(delay);
        continue;
      }

      runRecord.attempts.push({ ...attempt });
      throw error;
    }
  }

  throw lastError;
}

async function main() {
  const cli = parseArgs();
  if (cli.apiKey) {
    process.stderr.write('提示：--api-key 的密钥会短暂出现在进程列表（ps 可见）。介意请改用 IMAGES2_GEN_API_KEY 环境变量。\n');
  }
  cli.imageUrls = normalizeImageReferences(cli.imageUrls);
  const runtime = resolveRuntimeConfig(cli);
  const startedAt = new Date();
  const runRecord = {
    ...buildLogRecordBase(cli, startedAt),
    attempts: [],
  };

  let finalResolution = cli.resolution;
  if (cli.resolution === '4k' && !VALID_4K_SIZES.has(cli.size)) {
    process.stderr.write(`注意：4K 不支持 ${cli.size} 比例，自动降为 2K\n`);
    finalResolution = '2k';
  }

  for (let index = 0; index < runtime.candidates.length; index++) {
    const candidate = runtime.candidates[index];

    try {
      const result = await runCandidate(candidate, cli, finalResolution, runRecord);
      const completedAt = new Date();
      runRecord.status = 'success';
      runRecord.completed_at = completedAt.toISOString();
      runRecord.duration_ms = completedAt.getTime() - startedAt.getTime();
      runRecord.selected_profile = candidate.name;
      runRecord.model = candidate.model.model;
      runRecord.model_key = candidate.model.key;
      runRecord.model_source = candidate.model.source;
      runRecord.saved_path = result.savedPath || null;
      runRecord.run_dir = result.runDir || null;
      writeRunLog(runRecord);

      if (result.savedPath) {
        process.stderr.write(`图片已保存到本地: ${result.savedPath}\n`);
        if (result.runDir) {
          process.stderr.write(`图片目录: ${result.runDir}\n`);
        }
        console.log(result.savedPath);
        return;
      }

      if (result.image.imageUrl) {
        console.log(result.image.imageUrl);
        return;
      }

      console.log(result.image.base64);
      return;
    } catch (error) {
      const classification = classifyError(error);
      const shouldFallback = classification.fallback && index < runtime.candidates.length - 1;

      if (shouldFallback) {
        process.stderr.write(`当前 profile=${candidate.name} 失败（${classification.kind}${classification.statusCode ? ` ${classification.statusCode}` : ''}），切换到下一个 profile...\n`);
        continue;
      }

      const failedAt = new Date();
      runRecord.status = 'failed';
      runRecord.completed_at = failedAt.toISOString();
      runRecord.duration_ms = failedAt.getTime() - startedAt.getTime();
      runRecord.model = candidate.model.model;
      runRecord.model_key = candidate.model.key;
      runRecord.model_source = candidate.model.source;
      runRecord.final_error = truncateForLog(error.message, MAX_LOG_ERROR_LENGTH);
      runRecord.final_error_kind = classification.kind;
      runRecord.final_status_code = classification.statusCode;
      writeRunLog(runRecord);
      throw error;
    }
  }

  throw new Error('没有可用的 profile 可继续尝试');
}

if (process.env.OH_COAGE_TEST === '1') {
  module.exports = {
    POLL_DELAYS_MS,
    MAX_POLL_FAILURES,
    pollDelayForAttempt,
    pollTask,
    classifyError,
    truncateForLog,
    inferExtensionFromUrl,
    inferExtensionFromContentType,
    isPrivateOrReservedHost,
    downloadToFile,
    saveImage,
  };
} else {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exit(1);
  });
}
