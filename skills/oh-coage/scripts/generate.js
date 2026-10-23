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
const { safeDetail, formatGenerationError } = require('./generation-errors');
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
const { resolveModel, resolveProfileModel, resolveModelChainForProfile } = require('./models');
const { FAMILIES, getFamilyConfig } = require('./family-config');
const {
  normalizeFamily,
  normalizeApiStyle,
  normalizeImageField,
  normalizeImageTransport,
  normalizeImageShape,
  resolveImageOptions,
  buildRequest,
  extractImages,
  extractTaskImages,
  resolveEndpointBaseUrl,
} = require('./providers');

const REQUEST_TIMEOUT_MS = 90 * 1000;
const POLL_TIMEOUT_MS = 20 * 1000;
const TASK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 2;
const MAX_POLL_FAILURES = 3;
const MAX_REDIRECTS = 5;
const MAX_ERROR_SNIPPET = 300;
const MAX_LOG_ERROR_LENGTH = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
// 这些状态码需继续检查服务错误码，只有明确的模型拒绝才允许尝试备选。
const MODEL_LEVEL_STATUS_CODES = new Set([400, 404, 422]);
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
  console.error('还没有连接生图服务。完成配置后，就可以开始创作。');
  console.error('请打开初始化表单，填写配置名称、服务地址和 API Key，再选择模型。入口：onboarding.js --render-connection；无法展示表单时使用固定文字流程。');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateForLog(value, maxLength = MAX_ERROR_SNIPPET) {
  const text = safeDetail(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…（已截断，原始 ${text.length} 字符）` : text;
}

/** 给错误打上标记，让 classifyError 明确知道它是「该换 profile」而不是「无法归类」。 */
function markFallback(error, kind) {
  error.fallback = true;
  if (kind) error.kind = kind;
  return error;
}

function parseHttpStatus(error) {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  const match = String(error?.message || '').match(/HTTP\s+(\d{3})/);
  return match ? Number(match[1]) : null;
}

// 这些错误说明「连接压根没建起来」，请求一定没到达服务端，重发是安全的
const NEVER_SENT_NETWORK_ERRORS = ['econnrefused', 'enotfound', 'eai_again'];
// 这些错误含义模糊：请求可能已经被服务端收下并处理了
const AMBIGUOUS_NETWORK_ERRORS = ['timed out', 'timeout', 'socket hang up', 'econnreset', 'epipe'];

/**
 * 把错误归类，决定「要不要重试」和「要不要换 profile / 换模型」。
 *
 * @param {Error} error
 * @param {{ idempotent?: boolean }} options
 *   idempotent=true（默认）：幂等请求（轮询用的 GET）。超时/重置可以放心重试。
 *   idempotent=false：非幂等请求（提交生成的 POST）。超时/重置**不能**重试——
 *     服务端可能已经收下并计费了，重发就是重复扣费。这类错误暂停提交并保留恢复记录。
 *
 * 返回值里的 resubmittable 表示「能不能再发一次生成请求」（换备用模型或换 profile 都算）：
 * 只有明确未送达或服务明确拒绝时才允许重发；这不代表已核实账单。
 */
function classifyError(error, options = {}) {
  if (error?.generationClassification) return error.generationClassification;
  const idempotent = options.idempotent !== false;
  const message = String(error?.message || '');
  const statusCode = parseHttpStatus(error);
  const lower = message.toLowerCase();
  const result = (kind, retryable, fallback, resubmittable) => ({ kind, statusCode, retryable, fallback, resubmittable });
  if (error?.generationAccepted) return result(error.kind || 'recovery', false, false, false);
  const serviceError = `${error?.serviceCode || ''} ${message}`;
  if (statusCode === 402 || /insufficient[_ -]?(quota|balance|credit|funds)|quota[_ -]?(exceeded|exhausted)|billing[_ -](hard[_ -]limit|not[_ -]active)|余额不足|额度不足|配额.{0,4}(不足|用尽|耗尽)/i.test(serviceError)) return result('quota', false, false, false);
  if (error?.stage === 'preflight') return result(error.kind || 'parameters', false, false, false);
  if (error?.fallback === true) {
    const kind = error.kind || 'unknown';
    return result(kind, false, kind !== 'download', kind !== 'download');
  }
  if (statusCode === 401) return result('auth', false, true, true);
  if (/content_policy|safety|moderation|内容.{0,4}(拒绝|违规)/i.test(serviceError)) return result('content', false, false, false);
  if (statusCode === 403) {
    const modelPermission = /model.{0,60}(permission|access|not allowed)|(?:permission|access).{0,60}model/i.test(serviceError);
    return result(modelPermission ? 'model' : 'permission', false, modelPermission, modelPermission);
  }
  if (statusCode === 429) return result('rate_limit', true, true, true);
  if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) return result('upstream', idempotent, idempotent, idempotent);
  if (statusCode && MODEL_LEVEL_STATUS_CODES.has(statusCode)) {
    const modelUnavailable = /model[_ -]?(not[_ -]?found|unavailable|unsupported)|(?:unknown|unsupported|invalid|no such) model|model.{0,100}(not found|not exist|does not exist|not supported|unavailable)/i.test(serviceError);
    return result(modelUnavailable ? 'model' : 'parameters', false, modelUnavailable, modelUnavailable);
  }
  if (NEVER_SENT_NETWORK_ERRORS.some((token) => lower.includes(token))) return result('network', true, true, true);
  if (/certificate|cert_|tls|ssl|self.signed|unable_to_verify|hostname.*match/i.test(`${error?.code || ''} ${message}`)) return result('tls', false, false, false);
  if (AMBIGUOUS_NETWORK_ERRORS.some((token) => lower.includes(token))) return result('network', idempotent, idempotent, false);
  return result('unknown', false, false, false);
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
          const error = new Error(`HTTP ${res.statusCode}: ${truncateForLog(raw)}`);
          error.statusCode = res.statusCode;
          try {
            const parsed = JSON.parse(raw);
            error.serviceCode = String(parsed?.error?.code || parsed?.error?.type || parsed?.code || '');
          } catch { /* Non-JSON error responses retain their HTTP status and text. */ }
          const retryAfter = res.headers['retry-after'];
          const seconds = Number(retryAfter);
          error.retryAfterMs = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : null;
          reject(error);
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

async function submitGeneration({ apiKey, baseUrl, family, apiStyle, imageOptions, params }) {
  let stage = 'preflight';
  try {
    const requestSpec = buildRequest({ family, apiStyle, ...params, apiKey, imageOptions });
    const endpointBase = resolveEndpointBaseUrl({ family, apiStyle, baseUrl });
    let url;
    if (/^https?:\/\//i.test(requestSpec.path)) {
      // 允许跨域端点（少数网关把生图和改图放在不同域名），但要把 key 的去向说清楚。
      // 否则一个写错的 --image-endpoint 就会把 Authorization 静默发到任意主机。
      const target = new URL(requestSpec.path);
      const origin = new URL(endpointBase);
      if (target.origin !== origin.origin) {
        process.stderr.write(
          `警告：本次请求发往 ${target.origin}，与 profile 的 base_url (${origin.origin}) 不同，`
          + 'API Key 会一并发送到该地址。请确认它可信。\n',
        );
      }
      url = requestSpec.path;
    } else {
      url = `${endpointBase}${requestSpec.path}`;
    }

    let contentType = 'application/json';
    let payload = JSON.stringify(requestSpec.body);

    if (requestSpec.transport === 'multipart') {
      const multipart = buildMultipartBody(requestSpec);
      contentType = multipart.contentType;
      payload = multipart.payload;
    }

    stage = 'submit';
    const result = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...requestSpec.headers,
      },
    }, payload, REQUEST_TIMEOUT_MS);

    const extracted = extractImages({ family, apiStyle }, result);
    if (extracted.mode === 'async' || extracted.images.length > 0) {
      return extracted;
    }

    const error = new Error(`无法识别生成接口返回结构: ${truncateForLog(JSON.stringify(result), MAX_ERROR_SNIPPET)}`);
    error.kind = 'response';
    throw error;
  } catch (error) {
    error.stage = stage;
    throw error;
  }
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
      throw Object.assign(new Error(`任务超时（超过 ${TASK_TIMEOUT_MS}ms，已轮询 ${pollCount} 次）`), { kind: 'task_timeout' });
    }

    let payload;
    try {
      const result = await requestFn(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }, null, POLL_TIMEOUT_MS);

      payload = result?.data;
      if (!payload || typeof payload !== 'object') {
        throw new Error(`任务查询返回结构无法识别: ${truncateForLog(JSON.stringify(result), MAX_ERROR_SNIPPET)}`);
      }

      consecutiveFailures = 0;
    } catch (error) {
      // 轮询是幂等 GET，超时/重置都可以放心重试
      const classification = classifyError(error, { idempotent: true });
      consecutiveFailures += 1;

      if (!classification.retryable || consecutiveFailures > MAX_POLL_FAILURES) {
        // 查询失败保留原任务，不触发新的生成提交。
        throw markFallback(error, classification.kind);
      }

      const delay = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : pollDelayForAttempt(consecutiveFailures - 1);
      if (delay > 60000) throw error;
      const status = classification.statusCode ? ` ${classification.statusCode}` : '';
      process.stderr.write(`任务已提交，暂时无法获取最新进度。${Math.round(delay / 1000)} 秒后重新查询，不会重复生成（${consecutiveFailures}/${MAX_POLL_FAILURES}${status}）。\n`);
      await sleepFn(delay);
      continue;
    }

    pollCount += 1;
    const normalizedStatus = String(payload.status || '').toLowerCase();

    if (COMPLETED_TASK_STATUSES.has(normalizedStatus)) {
      const images = extractTaskImages(payload);
      if (images.length > 0) {
        return images;
      }
      throw Object.assign(new Error('任务已完成，但未找到图片结果'), { kind: 'task_empty', terminalTask: true });
    }

    if (FAILED_TASK_STATUSES.has(normalizedStatus)) {
      throw Object.assign(new Error(payload.error?.message || `任务未完成（status=${payload.status}）`), { kind: 'task_failed', terminalTask: true });
    }

    // 少数站点不返回 status，直接把结果放在轮询响应里
    if (!normalizedStatus) {
      const images = extractTaskImages(payload);
      if (images.length > 0) {
        return images;
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

/** 把 data URI 拆成可上传的文件字段；multipart 不能直接塞 data URI 字符串。 */
function dataUriToUpload(value) {
  const match = String(value || '').match(/^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  const extension = [...IMAGE_MIME_TYPES.entries()].find(([, mime]) => mime === mimeType)?.[0] || '.png';
  return {
    mimeType,
    extension,
    buffer: Buffer.from(match[2], 'base64'),
  };
}

/**
 * 拼 multipart/form-data 请求体。
 * 参考图字段按 OpenAI /images/edits 的习惯写成 `image[]`（多张）或 `image`（单张），
 * 其余标量字段照旧平铺成普通表单字段。
 */
function buildMultipartBody(requestSpec) {
  const boundary = `----ohcoage${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];

  const pushField = (name, value) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };

  for (const [name, value] of Object.entries(requestSpec.body || {})) {
    if (value === undefined || value === null) continue;
    // 数组和对象在表单里没有标准表示，按 JSON 字符串发，和多数中转站一致
    pushField(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  const images = requestSpec.imageUrls || [];
  const fieldName = requestSpec.imageField || 'image';
  images.forEach((reference, index) => {
    const upload = dataUriToUpload(reference);
    if (!upload) {
      throw new Error(
        'multipart 图生图只能上传本地图片或 data URI。'
        + `当前第 ${index + 1} 张参考图是远程 URL，请先下载到本地，或改用 --image-transport json。`,
      );
    }

    // 多张时用 image[]，单张时用 image：OpenAI 官方两种都认，其他站点也更宽容
    const name = images.length > 1 ? `${fieldName}[]` : fieldName;
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"; filename="reference-${index + 1}${upload.extension}"\r\n`
      + `Content-Type: ${upload.mimeType}\r\n\r\n`,
    ));
    chunks.push(upload.buffer);
    chunks.push(Buffer.from('\r\n'));
  });

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat(chunks),
  };
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

function buildOutputPath(output, extension, runDir, index = 0) {
  if (output) {
    ensureDir(path.dirname(output));
    const ext = path.extname(output);
    // 用户没写扩展名时补上，否则会产出没有后缀、双击打不开的文件
    const base = ext ? output.slice(0, -ext.length) : output;
    const suffix = ext || extension;
    // 多图时第 1 张用用户指定文件名，后续追加序号，避免互相覆盖
    if (index === 0) return `${base}${suffix}`;
    return `${base}-${index + 1}${suffix}`;
  }

  ensureDir(runDir);
  return path.join(runDir, `oh-coage-${Date.now()}${index ? `-${index + 1}` : ''}${extension}`);
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

/**
 * 时间戳目录只精确到秒，同一秒内的两个并发 run 会撞进同一个目录，
 * 后写入的 meta.json 会覆盖前一个。目录已存在时追加序号，保证互不干扰。
 */
function buildRunDir(rootOutputDir, timestamp) {
  const base = path.join(rootOutputDir, formatTimestampForDir(timestamp));
  ensureDir(rootOutputDir);

  // 用 mkdir 的原子性抢占目录：目录已存在时 mkdirSync 抛 EEXIST。
  // 不能用 existsSync 判断完再创建——两个并发进程之间存在空窗，会抢到同一个目录，
  // 结果后写入的 meta.json 覆盖前一个。
  for (let counter = 0; counter < 1000; counter += 1) {
    const candidate = counter === 0 ? base : `${base}-${counter}`;
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  throw new Error(`无法为本次生成创建独立的输出目录（已尝试 1000 个序号）：${base}`);
}

function writeRunMeta(runDir, meta) {
  if (!runDir) return;
  ensureDir(runDir);
  fs.writeFileSync(path.join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * 按文件头判断是不是真图片。
 * 站点的错误页、限流 JSON、登录跳转页都可能带着 200 返回，
 * 不校验就会把 HTML 存成 .png，还对外报 success。
 */
function looksLikeImageBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  // WEBP: RIFF....WEBP
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  // GIF: GIF87a / GIF89a
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return true;
  return false;
}

/** 从磁盘上已有的文件做同样的魔数校验。 */
function assertFileIsImage(filePath, sourceLabel) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`无法读取${sourceLabel}：${error.message}`);
  }

  if (!looksLikeImageBuffer(buffer)) {
    const preview = buffer.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ').trim();
    throw new Error(
      `${sourceLabel}不是有效图片（内容开头：${preview || '空'}）。`
      + '通常是站点返回了错误页或限流响应，请检查 base_url / API Key / 配额。',
    );
  }
}

async function saveImage(image, output, runDir, index = 0) {
  if (!output && !runDir) {
    return null;
  }

  if (image.base64) {
    const dataUri = image.base64.startsWith('data:') ? image.base64 : `data:image/png;base64,${image.base64}`;
    const [, meta, encoded] = dataUri.match(/^data:([^;]+);base64,([\s\S]+)$/) || [];
    if (!encoded) {
      throw new Error('base64 图片格式不合法');
    }

    const buffer = Buffer.from(encoded, 'base64');
    if (!looksLikeImageBuffer(buffer)) {
      throw new Error(
        `接口返回的 base64 数据不是有效图片（开头：${buffer.subarray(0, 80).toString('utf8').replace(/\s+/g, ' ').trim() || '空'}）。`,
      );
    }

    const filePath = buildOutputPath(output, inferExtension(meta, dataUri), runDir, index);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  if (image.imageUrl) {
    // 先按 URL 猜扩展名落到磁盘，下载后再按响应头纠正
    const guessedExtension = inferExtensionFromUrl(image.imageUrl) || '.png';
    const filePath = buildOutputPath(output, guessedExtension, runDir, index);

    let contentType;
    try {
      contentType = await downloadToFile(image.imageUrl, filePath);
    } catch (downloadError) {
      fs.rmSync(filePath, { force: true });
      // 已收到图片引用；下载失败不能据此推断账单，也不能重新提交生成。
      throw markFallback(
        new Error(`已收到图片结果，但下载失败（不会重试提交）：${downloadError.message}`),
        'download',
      );
    }

    // 下载回来的是 HTML 错误页时，不要当成图片留在磁盘上
    try {
      assertFileIsImage(filePath, '下载到的内容');
    } catch (invalidError) {
      fs.rmSync(filePath, { force: true });
      throw markFallback(invalidError, 'download');
    }

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
  const parsed = { imageUrls: [], autoFallback: true, profileFallback: false };

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
      case '--family': parsed.family = value(i++, '--family'); break;
      case '--api': parsed.apiStyle = value(i++, '--api'); break;
      case '--model': parsed.model = value(i++, '--model'); break;
      case '--size': parsed.size = value(i++, '--size'); break;
      case '--resolution': parsed.resolution = value(i++, '--resolution'); break;
      case '--image-size': parsed.imageSize = value(i++, '--image-size'); break;
      case '--n': parsed.n = value(i++, '--n'); break;
      case '--quality': parsed.quality = value(i++, '--quality'); break;
      case '--background': parsed.background = value(i++, '--background'); break;
      case '--output-format': parsed.outputFormat = value(i++, '--output-format'); break;
      case '--output-compression': parsed.outputCompression = value(i++, '--output-compression'); break;
      case '--moderation': parsed.moderation = value(i++, '--moderation'); break;
      case '--style': parsed.style = value(i++, '--style'); break;
      case '--response-format': parsed.responseFormat = value(i++, '--response-format'); break;
      case '--user': parsed.user = value(i++, '--user'); break;
      case '--image-url': parsed.imageUrls.push(value(i++, '--image-url')); break;
      case '--image-field': parsed.imageField = value(i++, '--image-field'); break;
      case '--image-transport': parsed.imageTransport = value(i++, '--image-transport'); break;
      case '--image-shape': parsed.imageShape = value(i++, '--image-shape'); break;
      case '--image-endpoint': parsed.imageEndpoint = value(i++, '--image-endpoint'); break;
      case '--base-url': parsed.baseUrl = value(i++, '--base-url'); break;
      case '--api-key': parsed.apiKey = value(i++, '--api-key'); break;
      case '--output': parsed.output = path.resolve(value(i++, '--output')); break;
      case '--out-dir': parsed.outDir = path.resolve(value(i++, '--out-dir')); break;
      case '--profile': parsed.profile = value(i++, '--profile'); break;
      case '--no-fallback': parsed.autoFallback = false; parsed.profileFallback = false; break;
      case '--no-model-fallback': parsed.autoFallback = false; break;
      case '--no-profile-fallback': parsed.profileFallback = false; break;
      case '--allow-profile-fallback': parsed.profileFallback = true; break;
      case '--max-submissions': parsed.maxSubmissions = Number(value(i++, '--max-submissions')); break;
      case '--resume': parsed.resume = path.resolve(value(i++, '--resume')); break;
      case '--json': parsed.json = true; break;
    }
  }

  if (args.includes('--no-fallback')) { parsed.autoFallback = false; parsed.profileFallback = false; }
  if (args.includes('--no-profile-fallback')) parsed.profileFallback = false;
  if (parsed.maxSubmissions !== undefined && (!Number.isInteger(parsed.maxSubmissions) || parsed.maxSubmissions < 1)) throw new Error('--max-submissions 必须是正整数');
  if (!parsed.prompt && !parsed.resume) {
    console.error('用法: node generate.js --prompt "提示词" [--family openai|gemini|grok|other] [--api openai|official] [--model NAME] [--profile NAME] [--size SIZE] [--resolution 1k|2k|4k] [--image-size 512|1K|2K|4K] [--n COUNT] [--quality QUALITY] [--style STYLE] [--background auto] [--output-format png] [--output-compression 0-100] [--moderation auto] [--response-format url|b64_json] [--user USER] [--image-url URL] [--image-field FIELD] [--image-transport json|multipart] [--image-shape array|array-object|single] [--image-endpoint PATH] [--base-url URL] [--api-key KEY] [--output FILE | --out-dir DIR] [--json] [--no-fallback] [--no-model-fallback] [--no-profile-fallback] [--allow-profile-fallback] [--max-submissions 3]；恢复：node generate.js --resume RECOVERY_JSON [--out-dir DIR] [--json]');
    console.error('图生图适配：--image-field 指定参考图字段名（默认 image_urls，multipart 默认 image）；--image-transport multipart 会把参考图作为文件字段上传；--image-endpoint 覆盖默认的 /images/generations 或 /images/edits。');
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
  const requestedProfile = explicitProfile || activeProfileName;
  if (requestedProfile && profiles[requestedProfile]?.enabled === false) {
    throw new Error(`配置 ${requestedProfile} 已停用；请启用它或明确选择其他配置。`);
  }

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

  // --family / --api 是本次显式覆盖；没给就跟随 profile，profile 再没写就是 openai。
  // 默认全部走 OpenAI 兼容接口，Gemini / Grok 只有在用户明确指定时才发官方协议。
  const cliFamily = cli.family ? (cli.family === 'other' ? 'other' : normalizeFamily(cli.family)) : null;
  const cliApiStyle = cli.apiStyle ? normalizeApiStyle(cli.apiStyle, cliFamily) : null;

  const profileFamily = (profile) => {
    try {
      return normalizeFamily(profile?.family || 'openai');
    } catch {
      return 'openai';
    }
  };
  const profileApiStyle = (profile, family) => {
    try {
      return normalizeApiStyle(profile?.api_style, family);
    } catch {
      return 'openai';
    }
  };

  // 图生图适配项：CLI 显式值 > profile 配置 > 内置默认。
  // 这里只合并原始值，真正的校验放到候选循环里，写错的 profile 会被跳过而不是拖垮整轮。
  const mergeImageOptions = (profile) => ({
    imageField: cli.imageField || profile?.image_field || null,
    imageTransport: cli.imageTransport || profile?.image_transport || null,
    imageShape: cli.imageShape || profile?.image_shape || null,
    imageEndpoint: cli.imageEndpoint || profile?.image_endpoint || null,
  });

  // 只传 --api-key 时，优先继承当前活跃 profile 的地址/模型族/协议，
  // 否则会回落到 DEFAULT_BASE_URL 那个示例域名，把请求发错地方。
  const fallbackProfileName = explicitProfile || activeProfileName;
  const baseProfileConfig = fallbackProfileName ? profiles[fallbackProfileName] : null;
  const baseSelection = getFamilyConfig(baseProfileConfig || {}, config || {});
  const manualGroup = cliFamily || baseSelection.activeFamily || 'openai';
  const manualFamily = baseProfileConfig && profileApiStyle(baseProfileConfig) === 'official' ? profileFamily(baseProfileConfig) : (manualGroup === 'other' ? 'openai' : manualGroup);
  const manualApiStyle = cliApiStyle || (baseProfileConfig ? profileApiStyle(baseProfileConfig, manualFamily) : 'openai');

  // 环境变量 IMAGES2_GEN_API_KEY 单独给出时也要能跑（文档承诺支持 CI 注入）。
  // 早期这里只判断 cli.apiKey，导致纯环境变量路径永远进不来。
  const manualApiKey = cli.apiKey || process.env.IMAGES2_GEN_API_KEY;
  const manualCandidate = manualApiKey ? [{
    name: explicitProfile || 'manual',
    apiKey: manualApiKey,
    baseUrl: normalizeBaseUrl(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL || baseProfileConfig?.base_url || DEFAULT_BASE_URL),
    rootOutputDir: cli.outDir ? path.resolve(cli.outDir) : null,
    outputOverride: cli.output || null,
    modelInput: baseSelection.modelFamilies[manualGroup]?.primary || null,
    modelFallbackInputs: baseSelection.modelFamilies[manualGroup]?.fallbacks || [],
    modelGroup: manualGroup,
    missingGroup: Boolean(cliFamily && baseProfileConfig && !baseSelection.modelFamilies[manualGroup]?.primary),
    family: manualFamily,
    apiStyle: manualApiStyle,
    imageOptions: mergeImageOptions(baseProfileConfig),
    source: cli.apiKey ? 'cli' : 'env',
  }] : [];

  const configCandidates = candidateProfiles.map(([name, profile]) => {
    const selection = getFamilyConfig(profile, config);
    const group = cliFamily || selection.activeFamily || 'openai';
    const declaredFamily = profileApiStyle(profile) === 'official' ? profileFamily(profile) : (group === 'other' ? 'openai' : group);
    return {
      name,
      keychainAccount: profile.keychain_account,
      baseUrl: normalizeBaseUrl(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL || profile.base_url || DEFAULT_BASE_URL),
      rootOutputDir: cli.outDir ? path.resolve(cli.outDir) : path.resolve(profile.resolved_root_output_dir || profile.root_output_dir || profile.output_dir || process.cwd()),
      outputOverride: cli.output || null,
      // profile 可以固定自己的模型；没有就跟随全局
      modelInput: selection.modelFamilies[group]?.primary || null,
      modelGroup: group,
      missingGroup: Boolean(cliFamily && !selection.modelFamilies[group]?.primary),
      // 同一 profile 内的备用模型：站点/Key/协议/目录都一样，只是模型不同
      modelFallbackInputs: selection.modelFamilies[group]?.fallbacks || [],
      // 这里用 profile 自己声明的族，--family 只用来过滤，不拿来改 profile 的身份
      family: declaredFamily,
      apiStyle: cliApiStyle || profileApiStyle(profile, declaredFamily),
      imageOptions: mergeImageOptions(profile),
      source: 'profile',
    };
  });

  let candidates = manualCandidate.length > 0
    ? (cli.profileFallback ? manualCandidate.concat(configCandidates) : manualCandidate)
    : (cli.profileFallback ? configCandidates : configCandidates.slice(0, 1));

  if (!candidates.length) {
    printSetupInstructions();
    process.exit(1);
  }

  // --model 是本次全局指定的，先解析一次：写错了就直接报错，不在每个候选上重复失败
  // 传完整 config，否则 --sync-models 拉回来的 discovered_models 在这里查不到，
  // 用户照着文档用 --model <拉到的ID> 会被判成「未知模型」。
  const cliModelEntry = cli.model ? resolveProfileModel(cli.model, baseProfileConfig, config) : null;

  // base_url 不合法（拼错、用了非 http/https 协议）或固定了未知模型的 profile
  // 直接跳过，不拖垮整轮 fallback
  const usableCandidates = [];
  for (const candidate of candidates) {
    if (!cliModelEntry && candidate.missingGroup) {
      process.stderr.write(`跳过配置 ${candidate.name}：尚未设置 ${candidate.modelGroup} 的主模型。不会改用其他厂家。\n`);
      continue;
    }
    if (cliModelEntry && profiles[candidate.name]?.synced_models?.length) {
      try { resolveProfileModel(cliModelEntry.model, profiles[candidate.name], config); }
      catch (error) { process.stderr.write(`跳过 profile=${candidate.name}：${error.message}\n`); continue; }
    }
    try {
      assertValidBaseUrl(candidate.baseUrl);
    } catch (error) {
      process.stderr.write(`跳过 profile=${candidate.name}：${error.message}\n`);
      continue;
    }

    try {
      candidate.modelChain = resolveModelChainForProfile({
        cliModelEntry,
        profile: profiles[candidate.name],
        profileModelKey: candidate.modelInput,
        profileFallbackKeys: candidate.modelFallbackInputs,
        config,
        family: candidate.modelGroup || candidate.family,
        // --no-fallback 的意思是「只跑当前这一条」，主备模型切换也一并关掉
        allowModelFallback: cli.autoFallback,
        warn: (message) => process.stderr.write(`${message}\n`),
      });
    } catch (error) {
      process.stderr.write(`跳过 profile=${candidate.name}：${error.message.split('\n')[0]}\n`);
      continue;
    }

    if (candidate.apiStyle === 'official') {
      const incompatible = candidate.modelChain.find(entry => entry.family && entry.family !== candidate.family);
      if (incompatible) {
        process.stderr.write(`跳过配置 ${candidate.name}：官方 ${candidate.family} 接口不能使用 ${incompatible.family} 模型 ${incompatible.model}。\n`);
        continue;
      }
    }

    // 保持旧字段：第一个就是首选模型，其他消费方（日志、提示）不用改
    candidate.model = candidate.modelChain[0];
    usableCandidates.push(candidate);
  }

  if (!usableCandidates.length) {
    if (cliFamily || candidates.some(candidate => candidate.missingGroup)) {
      throw new Error(`没有可用配置设置 ${cliFamily || candidates[0]?.modelGroup || '当前厂家'} 的主模型；请在模型管理中配置该厂家，不会自动改用其他厂家。`);
    }
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
    profile_fallback: cli.profileFallback === true,
  };
}

function writeRunLog(record) {
  appendJsonl(RUNS_PATH, record);
}

// 重试退避时长。测试里用 OH_COAGE_RETRY_DELAY_MS 归零，避免端到端用例真的等 1 秒
// （那会让测试变慢、且依赖真实定时器，是最容易 flaky 的一类）。
const RETRY_DELAY_BASE_OVERRIDE = process.env.OH_COAGE_RETRY_DELAY_MS === undefined
  ? null
  : Number(process.env.OH_COAGE_RETRY_DELAY_MS);
const RETRY_DELAY_MS = { rate_limit: 1500, network: 1000, upstream: 1000 };

function retryDelayFor(kind, attemptIndex) {
  if (RETRY_DELAY_BASE_OVERRIDE !== null && Number.isFinite(RETRY_DELAY_BASE_OVERRIDE)) {
    return Math.max(0, RETRY_DELAY_BASE_OVERRIDE);
  }
  return (RETRY_DELAY_MS[kind] || 1000) * attemptIndex;
}

/** 把图生图适配项写成一行，供日志和 stderr 提示使用。 */
function describeImageOptions(imageOptions, context = {}) {
  const resolved = resolveImageOptions(imageOptions, context);
  const shapeLabel = resolved.shape === 'array'
    ? '字符串数组'
    : resolved.shape === 'array-object' ? '对象数组' : '单值';
  return `端点=${resolved.endpoint}, 传输=${resolved.transport}, 字段=${resolved.field}, 形状=${shapeLabel}`;
}

async function runCandidate(candidate, cli, runRecord, options = {}) {
  const sleepFn = options.sleep || sleep;
  const attemptStartedAt = new Date();

  // 图生图适配项可能在 profile 里写错（例如 image_field 含空格）。
  // 这种情况只说明「这一个 profile 不可用」，应该跳过它继续 fallback，
  // 而不是在构造 attempt 时抛错、把整轮拖垮。
  let imageOptionsLabel = null;
  if (cli.imageUrls.length > 0) {
    try {
      imageOptionsLabel = describeImageOptions(
        candidate.imageOptions,
        { family: candidate.family, apiStyle: candidate.apiStyle },
      );
    } catch (error) {
      process.stderr.write(`跳过 profile=${candidate.name}：${error.message.split('\n')[0]}\n`);
      throw markFallback(error, 'config');
    }
  }

  let candidateApiKey;
  try {
    candidateApiKey = candidate.apiKey || readKeychainSecret(candidate.keychainAccount);
  } catch (error) {
    // Keychain 读不到 key 只说明这一个 profile 不可用，应该交给上层 fallback，而不是整轮退出
    runRecord.attempts.push({
      profile: candidate.name,
      base_url: candidate.baseUrl,
      family: candidate.family,
      api_style: candidate.apiStyle,
      model: candidate.model.model,
      model_key: candidate.model.key,
      model_source: candidate.model.source,
      image_options: imageOptionsLabel,
      started_at: attemptStartedAt.toISOString(),
      status: 'failed',
      last_error: truncateForLog(error.message, MAX_LOG_ERROR_LENGTH),
      error_kind: 'keychain',
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - attemptStartedAt.getTime(),
    });
    throw markFallback(error, 'keychain');
  }

  // 同一 profile 内的主备模型链：站点/Key/协议/输出目录都一样，只有模型不同。
  const chain = Array.isArray(candidate.modelChain) && candidate.modelChain.length > 0
    ? candidate.modelChain
    : [candidate.model];
  runRecord.model_chain = chain.map((entry) => entry.model);

  if (chain.length > 1) {
    process.stderr.write(
      `主模型：${chain[0].model}；备选：${chain.slice(1).map((entry) => entry.model).join('、')}（仅在主模型明确不可用时尝试）\n`,
    );
  }

  let lastError = null;
  for (let modelIndex = 0; modelIndex < chain.length; modelIndex += 1) {
    const modelEntry = chain[modelIndex];
    try {
      return await runModelAttempt({
        candidate,
        modelEntry,
        cli,
        runRecord,
        candidateApiKey,
        imageOptionsLabel,
        attemptStartedAt,
        sleepFn,
      });
    } catch (error) {
      lastError = error;
      const classification = classifyError(error, { idempotent: false });
      const nextEntry = chain[modelIndex + 1];

      // 换模型会再次提交，仅对明确的模型拒绝尝试备选。
      const canSwitchModel = Boolean(nextEntry)
        && classification.kind === 'model'
        && classification.fallback
        && classification.resubmittable !== false;

      if (!canSwitchModel) {
        error.modelsExhausted = modelIndex > 0;
        throw error;
      }

      process.stderr.write(
        `${modelEntry.model} 暂不可用，正在尝试你设置的备选 ${nextEntry.model}。\n`,
      );
    }
  }

  throw lastError;
}

/**
 * 在单个 profile + 单个模型上跑一次完整的「提交 + 回收 + 落盘」，含同模型内的退避重试。
 * 拆出来是为了让 runCandidate 能在主备模型之间循环，同时让每次尝试都能单独落日志。
 */
async function runModelAttempt({
  candidate,
  modelEntry,
  cli,
  runRecord,
  candidateApiKey,
  imageOptionsLabel,
  attemptStartedAt,
  sleepFn,
}) {
  const attempt = {
    profile: candidate.name,
    base_url: candidate.baseUrl,
    family: candidate.family,
    model_family: modelEntry.family || candidate.modelGroup || candidate.family,
    api_style: candidate.apiStyle,
    model: modelEntry.model,
    model_key: modelEntry.key,
    model_source: modelEntry.source,
    // 图生图适配信息按候选记入 attempt，日后排查 400 能看出当时用的字段名/传输方式
    image_options: imageOptionsLabel,
    started_at: attemptStartedAt.toISOString(),
  };

  if (candidate.apiStyle === 'official' && modelEntry.family && modelEntry.family !== candidate.family) {
    const error = new Error('该模型需要不同的官方接口协议；请使用 OpenAI 兼容接口，或为它建立对应官方接口配置。');
    error.generationClassification = { kind: 'interface', statusCode: null, retryable: false, fallback: false, resubmittable: false };
    error.stage = 'preflight';
    throw error;
  }
  const mode = cli.imageUrls.length > 0 ? '图生图' : '文生图';
  const interfaceLabel = candidate.apiStyle === 'official' ? `${candidate.family} 官方接口` : 'OpenAI 兼容接口';
  process.stderr.write(`正在提交${mode}任务: profile=${candidate.name}, 接口=${interfaceLabel}, base_url=${candidate.baseUrl}, model=${modelEntry.model}, prompt=${cli.prompt}, size=${cli.size || '默认'}\n`);
  if (modelEntry.source === 'default') {
    process.stderr.write(`提示：当前使用默认模型 ${modelEntry.model}，可用 manage.js 管理厂家分组和模型顺序。\n`);
  }
  if (cli.imageUrls.length > 0) {
    // 图生图时把适配结果说清楚，否则用户遇到 400 很难判断是字段名还是传输方式不对
    process.stderr.write(`参考图片: ${cli.imageUrls.length} 张；适配: ${imageOptionsLabel}\n`);
  }

  const params = {
    prompt: cli.prompt,
    model: modelEntry.model,
    size: cli.size,
    resolution: cli.resolution,
    imageSize: cli.imageSize,
    n: cli.n,
    quality: cli.quality,
    style: cli.style,
    background: cli.background,
    outputFormat: cli.outputFormat,
    outputCompression: cli.outputCompression,
    moderation: cli.moderation,
    responseFormat: cli.responseFormat,
    user: cli.user,
    imageUrls: cli.imageUrls,
    // 将供应商参数提示回传给用户。
    warn: (message) => process.stderr.write(`${message}\n`),
  };

  const runDir = candidate.outputOverride
    ? path.dirname(candidate.outputOverride)
    : buildRunDir(candidate.rootOutputDir || process.cwd(), attemptStartedAt);
  try {
    ensureDir(runDir);
    fs.accessSync(runDir, fs.constants.W_OK);
    const probe = path.join(runDir, `.oh-coage-write-${crypto.randomBytes(8).toString('hex')}`);
    fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
    fs.unlinkSync(probe);
  } catch (error) {
    error.stage = 'preflight';
    throw error;
  }
  const recoveryPath = path.join(runDir, `recovery-${crypto.randomBytes(8).toString('hex')}.json`);
  const recovery = { version: 1, status: 'submitting', profile: candidate.name, baseUrl: candidate.baseUrl,
    keychainAccount: candidate.keychainAccount || null, model: modelEntry.model,
    output: candidate.outputOverride || null, requestedCount: Number(cli.n) || 1,
    runDir, taskId: null, images: [], saved: {} };
  const persistRecovery = () => {
    const temp = `${recoveryPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(recovery, null, 2), { mode: 0o600 });
    fs.renameSync(temp, recoveryPath);
  };
  try { persistRecovery(); } catch (error) { error.stage = 'preflight'; throw error; }
  process.stderr.write(`本次记录: ${recoveryPath}\n`);
  let accepted = false;
  let lastError = null;
  for (let index = 1; index <= MAX_RETRY_ATTEMPTS; index++) {
    attempt.try_count = index;
    try {
      const limit = cli.maxSubmissions || 3;
      runRecord.submission_count ||= 0;
      if (runRecord.submission_count >= limit) throw Object.assign(new Error(`已达到本次提交上限 ${limit}；请检查尝试记录后再决定是否继续`), { kind: 'budget' });
      runRecord.submission_count += 1;
      const submitted = await submitGeneration({
        apiKey: candidateApiKey,
        baseUrl: candidate.baseUrl,
        family: candidate.apiStyle === 'official'
          ? candidate.family
          : (modelEntry.family && modelEntry.family !== 'other' ? modelEntry.family : (candidate.modelGroup === 'other' ? 'openai' : candidate.modelGroup || candidate.family)),
        apiStyle: candidate.apiStyle,
        imageOptions: candidate.imageOptions,
        params,
      });
      accepted = true;
      attempt.response_mode = submitted.mode;
      recovery.status = 'accepted';
      recovery.taskId = submitted.taskId || null;
      recovery.images = submitted.images || [];
      persistRecovery();

      let images;
      if (submitted.mode === 'async') {
        attempt.task_id = submitted.taskId;
        process.stderr.write(`任务已提交: ${submitted.taskId}\n`);
        // pollTask 现在返回全部图片：异步任务也可能一次产出多张，
        // 只取第一张会让用户白付其余几张的钱。
        images = await pollTask(candidateApiKey, candidate.baseUrl, submitted.taskId);
        process.stderr.write(`任务回收完成，拿到 ${images.length} 张图片\n`);
      } else {
        process.stderr.write(`接口直接返回了 ${submitted.images.length} 张图片\n`);
        images = submitted.images;
      }

      recovery.images = images;
      recovery.status = 'saving';
      persistRecovery();
      const savedPaths = [];
      const results = [];
      for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
        const image = images[imageIndex];
        const savedPath = await saveImage(image, candidate.outputOverride, runDir, imageIndex);
        if (savedPath) savedPaths.push(savedPath);
        recovery.saved[imageIndex] = savedPath;
        persistRecovery();
        results.push({
          savedPath: savedPath || null,
          // 远程 URL 原样保留；base64 落盘后靠本地路径展示
          url: image.imageUrl || null,
          mimeType: image.mimeType || null,
          source: image.imageUrl ? 'url' : 'base64',
        });
      }
      const savedPath = savedPaths[0] || null;

      recovery.status = 'complete';
      persistRecovery();
      attempt.status = 'success';
      attempt.completed_at = new Date().toISOString();
      attempt.duration_ms = Date.now() - attemptStartedAt.getTime();
      attempt.saved_path = savedPath;
      attempt.saved_paths = savedPaths;
      attempt.run_dir = runDir;

      writeRunMeta(runDir, {
        prompt: cli.prompt,
        profile: candidate.name,
        base_url: candidate.baseUrl,
        family: modelEntry.family || candidate.modelGroup || candidate.family,
        api_family: candidate.family,
        api_style: candidate.apiStyle,
        model: modelEntry.model,
        model_key: modelEntry.key,
        size: cli.size || null,
        resolution: cli.resolution || null,
        image_size: cli.imageSize || null,
        n: cli.n || null,
        started_at: attemptStartedAt.toISOString(),
        completed_at: attempt.completed_at,
        saved_path: savedPath,
        saved_paths: savedPaths,
        results,
        task_id: attempt.task_id || null,
        image_url_count: cli.imageUrls.length,
        image_options: imageOptionsLabel,
      });

      runRecord.attempts.push(attempt);
      return { attempt, savedPath, savedPaths, runDir, images, results, model: modelEntry };
    } catch (error) {
      lastError = error;
      if (accepted) error.generationAccepted = true;
      recovery.status = error.generationAccepted ? 'recoverable' : 'failed_or_unknown';
      if (Object.keys(recovery.saved).length) process.stderr.write(`已保存图片保留: ${Object.values(recovery.saved).filter(Boolean).join('、')}\n`);
      recovery.lastError = truncateForLog(error.message, MAX_LOG_ERROR_LENGTH);
      try { persistRecovery(); } catch (recordError) {
        process.stderr.write(`本次记录更新失败：${truncateForLog(recordError.message)}；已保留先前记录。\n`);
      }
      const failureClassification = classifyError(error, { idempotent: false });
      error.generationClassification = failureClassification;
      error.definitelyRejected = failureClassification.resubmittable || ['quota', 'auth', 'permission', 'content', 'model', 'parameters', 'rate_limit', 'tls'].includes(failureClassification.kind);
      error.recovery = { path: recoveryPath, taskId: recovery.taskId, images: recovery.images.length, saved: recovery.saved };
      // 这里是提交（非幂等 POST）。超时/连接重置时服务端可能已经生成并计费，
      // 所以只对明确未送达或限流的情况重试，其余保留恢复记录。
      const classification = failureClassification;
      attempt.status = 'failed';
      attempt.last_error = truncateForLog(error.message, MAX_LOG_ERROR_LENGTH);
      attempt.error_kind = classification.kind;
      attempt.status_code = classification.statusCode;
      attempt.completed_at = new Date().toISOString();
      attempt.duration_ms = Date.now() - attemptStartedAt.getTime();

      // retryable 覆盖限流、明确失败的上游故障，以及「连接根本没建起来」的网络错误，
      // 统一在同 profile 上退避重试一次
      if (classification.retryable && index < MAX_RETRY_ATTEMPTS) {
        const requestedDelay = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : retryDelayFor(classification.kind, index);
        if (requestedDelay > 60000) {
          error.message += '；服务要求等待超过 60 秒，请稍后重试';
          error.generationClassification = { ...classification, retryable: false, fallback: false, resubmittable: false };
          runRecord.attempts.push({ ...attempt });
          throw error;
        }
        const delay = requestedDelay;
        const status = classification.statusCode ? ` ${classification.statusCode}` : '';
        process.stderr.write(classification.kind === 'rate_limit'
          ? `当前请求较多，${Math.ceil(delay / 1000)} 秒后重试当前模型（${index}/${MAX_RETRY_ATTEMPTS}）${status}。\n`
          : `暂时连接不上生图服务，${Math.ceil(delay / 1000)} 秒后重试（${index}/${MAX_RETRY_ATTEMPTS}）。\n`);
        await sleepFn(delay);
        continue;
      }

      runRecord.attempts.push({ ...attempt });
      throw error;
    }
  }

  throw lastError;
}

async function resumeGeneration(cli) {
  let recovery;
  try {
    return await resumeGenerationRecord(cli, (record) => { recovery = record; });
  } catch (error) {
    error.stage = 'resume';
    error.kind ||= recovery?.images?.length ? 'download' : recovery?.taskId ? 'recovery' : 'resume';
    if (recovery) {
      error.generationAccepted = Boolean(recovery.taskId || recovery.images?.length);
      error.recovery = { path: cli.resume, taskId: recovery.taskId, images: recovery.images?.length || 0, saved: recovery.saved };
    }
    throw error;
  }
}

async function resumeGenerationRecord(cli, onRecord) {
  const recoveryPath = cli.resume;
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  if (recovery.version !== 1 || !recovery.runDir || !recovery.baseUrl) throw new Error('恢复记录格式无效');
  if (recovery.images !== undefined && !Array.isArray(recovery.images)) throw new Error('恢复记录的图片列表无效');
  onRecord(recovery);
  const persist = () => {
    const temp = `${recoveryPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(recovery, null, 2), { mode: 0o600 });
    fs.renameSync(temp, recoveryPath);
  };
  assertValidBaseUrl(recovery.baseUrl);
  if (!recovery.images?.length && recovery.taskId) {
    let key = cli.apiKey || process.env.IMAGES2_GEN_API_KEY;
    if (!key) {
      const { config } = loadActiveConfig();
      const profile = config?.profiles?.[recovery.profile];
      if (!profile || normalizeBaseUrl(profile.base_url) !== recovery.baseUrl) throw new Error('原配置已变更；请恢复原站点连接，或通过 IMAGES2_GEN_API_KEY 提供原站点密钥后继续查询');
      key = readKeychainSecret(profile.keychain_account);
    }
    recovery.images = await pollTask(key, recovery.baseUrl, recovery.taskId);
    persist();
  }
  if (!recovery.images?.length) throw Object.assign(new Error('提交结果未知且没有任务 ID。请检查服务端记录；不会自动重新生成。'), { kind: 'no_recovery' });
  if (cli.outDir) recovery.runDir = cli.outDir;
  if (cli.output) recovery.output = cli.output;
  ensureDir(recovery.runDir);
  recovery.saved ||= {};
  persist();
  const results = [];
  for (let index = 0; index < recovery.images.length; index++) {
    const image = recovery.images[index];
    let savedPath = recovery.saved[index];
    if (!savedPath || !fs.existsSync(savedPath)) {
      savedPath = await saveImage(image, cli.output || recovery.output, cli.outDir || recovery.runDir, index);
      recovery.saved[index] = savedPath;
      persist();
    }
    results.push({ path: savedPath, display: savedPath, url: image.imageUrl || null });
  }
  recovery.status = 'complete';
  persist();
  const requestedCount = Number(recovery.requestedCount) || results.length;
  const missingCount = Math.max(0, requestedCount - results.length);
  if (missingCount) process.stderr.write(`已完成 ${results.length}/${requestedCount} 张，图片已保存；其余图片尚未返回，不会自动补发生成请求。\n`);
  if (cli.json) console.log(JSON.stringify({ status: missingCount ? 'partial' : 'success', resumed: true, model: recovery.model, requested_count: requestedCount, received_count: results.length, missing_count: missingCount, run_dir: recovery.runDir, images: results }));
  else results.forEach((image) => console.log(image.path));
}

async function main() {
  const cli = parseArgs();
  if (cli.resume) return resumeGeneration(cli);
  if (cli.apiKey) {
    process.stderr.write('提示：--api-key 的密钥会短暂出现在进程列表（ps 可见）。介意请改用 IMAGES2_GEN_API_KEY 环境变量。\n');
  }
  // CLI 上的图生图适配项先验一遍，拼错时立刻报错而不是等每个候选都失败
  let runtime;
  try {
    cli.imageOptions = {
      imageField: normalizeImageField(cli.imageField),
      imageTransport: normalizeImageTransport(cli.imageTransport),
      imageShape: normalizeImageShape(cli.imageShape),
      imageEndpoint: cli.imageEndpoint || null,
    };
    if (cli.imageUrls.length === 0
      && (cli.imageField || cli.imageTransport || cli.imageShape || cli.imageEndpoint)) {
      process.stderr.write('提示：没有提供 --image-url，本次是文生图，参考图适配项不会生效。\n');
    }
    cli.imageUrls = normalizeImageReferences(cli.imageUrls);
    runtime = resolveRuntimeConfig(cli);
  } catch (error) {
    error.stage = 'preflight';
    throw error;
  }
  const startedAt = new Date();
  const runRecord = {
    ...buildLogRecordBase(cli, startedAt),
    attempts: [],
  };

  for (let index = 0; index < runtime.candidates.length; index++) {
    const candidate = runtime.candidates[index];

    try {
      const result = await runCandidate(candidate, cli, runRecord);
      const completedAt = new Date();
      // 成功的那次可能是备用模型，日志和输出要记实际用的那个，而不是首选
      const usedModel = result.model || candidate.model;
      const results = result.results || [];
      const requestedCount = Number(cli.n) || 1;
      const missingCount = Math.max(0, requestedCount - results.length);
      runRecord.status = missingCount ? 'partial' : 'success';
      runRecord.requested_count = requestedCount;
      runRecord.received_count = results.length;
      runRecord.completed_at = completedAt.toISOString();
      runRecord.duration_ms = completedAt.getTime() - startedAt.getTime();
      runRecord.selected_profile = candidate.name;
      runRecord.family = usedModel.family || candidate.modelGroup || candidate.family;
      runRecord.api_family = candidate.family;
      runRecord.api_style = candidate.apiStyle;
      runRecord.model = usedModel.model;
      runRecord.model_key = usedModel.key;
      runRecord.model_source = usedModel.source;
      runRecord.saved_path = result.savedPath || null;
      runRecord.saved_paths = result.savedPaths || [];
      runRecord.run_dir = result.runDir || null;
      writeRunLog(runRecord);

      if (missingCount) process.stderr.write(`已完成 ${results.length}/${requestedCount} 张，图片已保存；其余图片尚未返回，不会自动补发生成请求。\n`);
      if (usedModel.source === 'fallback') {
        process.stderr.write(`本次首选模型不可用，已自动用备用模型生成：${usedModel.model}\n`);
      }
      if (result.runDir) {
        process.stderr.write(`图片目录: ${result.runDir}\n`);
      }
      results.forEach((item) => {
        if (item.savedPath) process.stderr.write(`图片已保存到本地: ${item.savedPath}\n`);
      });

      if (cli.json) {
        // 给调用方一份完整结构：URL 和 base64 两种返回都能落到可展示的引用
        console.log(JSON.stringify({
          status: runRecord.status,
          requested_count: requestedCount,
          received_count: results.length,
          missing_count: missingCount,
          profile: candidate.name,
          family: usedModel.family || candidate.modelGroup || candidate.family,
          api_family: candidate.family,
          api: candidate.apiStyle,
          model: usedModel.model,
          model_key: usedModel.key,
          model_source: usedModel.source,
          // 用了备用模型时告诉调用方，便于向用户解释为什么模型变了
          used_fallback_model: usedModel.source === 'fallback',
          run_dir: result.runDir || null,
          images: results.map((item) => ({
            source: item.source,
            url: item.url,
            path: item.savedPath,
            mime_type: item.mimeType,
            // 优先远程 URL（浏览器/宿主能直拉），否则用本地文件路径
            display: item.url || item.savedPath || null,
          })),
        }, null, 2));
        return;
      }

      if (result.savedPaths?.length) {
        // stdout 保持一行一个路径，方便调用方直接取
        result.savedPaths.forEach((savedPath) => console.log(savedPath));
        return;
      }

      const firstImage = result.images?.[0];
      if (firstImage?.imageUrl) {
        console.log(firstImage.imageUrl);
        return;
      }

      if (firstImage?.base64) {
        console.log(firstImage.base64);
        return;
      }

      throw new Error('生成成功但没有任何可用的图片结果。');
    } catch (error) {
      const classification = classifyError(error, { idempotent: false });
      const shouldFallback = classification.fallback && classification.resubmittable !== false && index < runtime.candidates.length - 1;

      if (shouldFallback) {
        process.stderr.write(`当前 profile=${candidate.name} 失败（${classification.kind}${classification.statusCode ? ` ${classification.statusCode}` : ''}），切换到下一个 profile...\n`);
        continue;
      }

      const failedAt = new Date();
      runRecord.status = 'failed';
      runRecord.completed_at = failedAt.toISOString();
      runRecord.duration_ms = failedAt.getTime() - startedAt.getTime();
      // 失败时记录真正最后试过的模型（可能是备用模型），而不是链首的首选
      const lastAttempt = runRecord.attempts[runRecord.attempts.length - 1];
      runRecord.model = lastAttempt?.model || candidate.model.model;
      runRecord.model_key = lastAttempt?.model_key || candidate.model.key;
      runRecord.model_source = lastAttempt?.model_source || candidate.model.source;
      runRecord.final_error = truncateForLog(error.message, MAX_LOG_ERROR_LENGTH);
      runRecord.final_error_kind = classification.kind;
      runRecord.final_status_code = classification.statusCode;
      try { writeRunLog(runRecord); } catch (logError) {
        process.stderr.write(`日志保存失败：${truncateForLog(logError.message)}；请以本次错误与已有图片记录为准。\n`);
      }
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
    runCandidate,
    runModelAttempt,
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
    console.error(formatGenerationError(error, classifyError(error, { idempotent: false })));
    process.exit(1);
  });
}
