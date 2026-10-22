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

// 这些错误说明「连接压根没建起来」，请求一定没到达服务端，重发是安全的
const NEVER_SENT_NETWORK_ERRORS = ['econnrefused', 'enotfound', 'eai_again'];
// 这些错误含义模糊：请求可能已经被服务端收下并处理了
const AMBIGUOUS_NETWORK_ERRORS = ['timed out', 'timeout', 'socket hang up', 'econnreset', 'epipe'];

/**
 * 把错误归类，决定「要不要重试」和「要不要换 profile」。
 *
 * @param {Error} error
 * @param {{ idempotent?: boolean }} options
 *   idempotent=true（默认）：幂等请求（轮询用的 GET）。超时/重置可以放心重试。
 *   idempotent=false：非幂等请求（提交生成的 POST）。超时/重置**不能**重试——
 *     服务端可能已经收下并计费了，重发就是重复扣费。这类错误只换 profile。
 */
function classifyError(error, options = {}) {
  const idempotent = options.idempotent !== false;
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
    // 服务端明确回了错误状态码，说明它知道自己失败了，重试是安全的
    return { kind: statusCode === 429 ? 'rate_limit' : 'upstream', statusCode, retryable: true, fallback: true };
  }

  const neverSent = NEVER_SENT_NETWORK_ERRORS.some((token) => lower.includes(token));
  if (neverSent) {
    return { kind: 'network', statusCode, retryable: true, fallback: true };
  }

  const ambiguous = AMBIGUOUS_NETWORK_ERRORS.some((token) => lower.includes(token));
  if (ambiguous) {
    // 非幂等请求遇到含义模糊的网络错误：不重发，只换 profile
    return { kind: 'network', statusCode, retryable: idempotent, fallback: true };
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

async function submitGeneration({ apiKey, baseUrl, family, apiStyle, imageOptions, params }) {
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

  throw new Error(`无法识别生成接口返回结构: ${truncateForLog(JSON.stringify(result), MAX_ERROR_SNIPPET)}`);
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
      // 轮询是幂等 GET，超时/重置都可以放心重试
      const classification = classifyError(error, { idempotent: true });
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
      const images = extractTaskImages(payload);
      if (images.length > 0) {
        return images;
      }
      throw new Error('任务已完成，但未找到图片结果');
    }

    if (FAILED_TASK_STATUSES.has(normalizedStatus)) {
      throw new Error(payload.error?.message || `任务失败（status=${payload.status}）`);
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
      // 图片其实已经生成、钱已经花掉了，只是下载没成功。
      // 这里必须标记成「不可重试、但可以换 profile」：重试提交等于重复计费。
      throw markFallback(
        new Error(`图片已生成但下载失败（不会重试提交，避免重复计费）：${downloadError.message}`),
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
  const parsed = { imageUrls: [], autoFallback: true };

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
      case '--no-fallback': parsed.autoFallback = false; break;
      case '--json': parsed.json = true; break;
    }
  }

  if (!parsed.prompt) {
    console.error('用法: node generate.js --prompt "提示词" [--family openai|gemini|grok] [--api openai|official] [--model NAME] [--profile NAME] [--size SIZE] [--resolution 1k|2k|4k] [--image-size 512|1K|2K|4K] [--n COUNT] [--quality QUALITY] [--style STYLE] [--background auto] [--output-format png] [--output-compression 0-100] [--moderation auto] [--response-format url|b64_json] [--user USER] [--image-url URL] [--image-field FIELD] [--image-transport json|multipart] [--image-shape array|array-object|single] [--image-endpoint PATH] [--base-url URL] [--api-key KEY] [--output FILE | --out-dir DIR] [--json] [--no-fallback]');
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
  const cliFamily = cli.family ? normalizeFamily(cli.family) : null;
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
  const manualFamily = cliFamily || (baseProfileConfig ? profileFamily(baseProfileConfig) : 'openai');
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
    modelInput: baseProfileConfig?.model || null,
    family: manualFamily,
    apiStyle: manualApiStyle,
    imageOptions: mergeImageOptions(baseProfileConfig),
    source: cli.apiKey ? 'cli' : 'env',
  }] : [];

  const configCandidates = candidateProfiles.map(([name, profile]) => {
    const declaredFamily = profileFamily(profile);
    return {
      name,
      keychainAccount: profile.keychain_account,
      baseUrl: normalizeBaseUrl(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL || profile.base_url || DEFAULT_BASE_URL),
      rootOutputDir: cli.outDir ? path.resolve(cli.outDir) : path.resolve(profile.resolved_root_output_dir || profile.root_output_dir || profile.output_dir || process.cwd()),
      outputOverride: cli.output || null,
      // profile 可以固定自己的模型；没有就跟随全局
      modelInput: profile.model || null,
      // 这里用 profile 自己声明的族，--family 只用来过滤，不拿来改 profile 的身份
      family: declaredFamily,
      apiStyle: cliApiStyle || profileApiStyle(profile, declaredFamily),
      imageOptions: mergeImageOptions(profile),
      source: 'profile',
    };
  });

  // 用户点名了模型族或接口协议，就只留匹配的候选，避免把 Gemini 模型发给 OpenAI 网关
  const matchesRequest = (candidate) => (
    (!cliFamily || candidate.family === cliFamily)
    && (!cliApiStyle || candidate.apiStyle === cliApiStyle)
  );

  let candidates = manualCandidate.length > 0
    ? (cli.autoFallback ? manualCandidate.concat(configCandidates) : manualCandidate)
    : (cli.autoFallback ? configCandidates : configCandidates.slice(0, 1));

  if (cliFamily || cliApiStyle) {
    const filtered = candidates.filter(matchesRequest);
    if (filtered.length === 0) {
      throw new Error(
        `没有匹配 family=${cliFamily || '*'} / api=${cliApiStyle || '*'} 的 profile。`
        + '请先用 setup.js 添加对应配置，或去掉 --family / --api 让本次跟随 profile。',
      );
    }
    candidates = filtered;
  }

  if (!candidates.length) {
    printSetupInstructions();
    process.exit(1);
  }

  // --model 是本次全局指定的，先解析一次：写错了就直接报错，不在每个候选上重复失败
  // 传完整 config，否则 --sync-models 拉回来的 discovered_models 在这里查不到，
  // 用户照着文档用 --model <拉到的ID> 会被判成「未知模型」。
  const cliModelEntry = cli.model ? resolveModel(cli.model, config, cliFamily) : null;

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
        family: candidate.family,
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

  const attempt = {
    profile: candidate.name,
    base_url: candidate.baseUrl,
    family: candidate.family,
    api_style: candidate.apiStyle,
    model: candidate.model.model,
    model_key: candidate.model.key,
    model_source: candidate.model.source,
    // 图生图适配信息按候选记入 attempt，日后排查 400 能看出当时用的字段名/传输方式
    image_options: imageOptionsLabel,
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
  const interfaceLabel = candidate.apiStyle === 'official' ? `${candidate.family} 官方接口` : 'OpenAI 兼容接口';
  process.stderr.write(`正在提交${mode}任务: profile=${candidate.name}, 接口=${interfaceLabel}, base_url=${candidate.baseUrl}, model=${candidate.model.model}, prompt=${cli.prompt}, size=${cli.size || '默认'}\n`);
  if (candidate.model.source === 'default') {
    process.stderr.write(`提示：当前使用默认模型 ${candidate.model.model}，可用 setup.js --model 切换。\n`);
  }
  if (cli.imageUrls.length > 0) {
    // 图生图时把适配结果说清楚，否则用户遇到 400 很难判断是字段名还是传输方式不对
    process.stderr.write(`参考图片: ${cli.imageUrls.length} 张；适配: ${imageOptionsLabel}\n`);
  }

  const params = {
    prompt: cli.prompt,
    model: candidate.model.model,
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
    // 让 providers 层能把「4K 已降级到 2k」这类调整回传给用户
    warn: (message) => process.stderr.write(`${message}\n`),
  };

  let lastError = null;
  for (let index = 1; index <= MAX_RETRY_ATTEMPTS; index++) {
    attempt.try_count = index;
    try {
      const submitted = await submitGeneration({
        apiKey: candidateApiKey,
        baseUrl: candidate.baseUrl,
        family: candidate.family,
        apiStyle: candidate.apiStyle,
        imageOptions: candidate.imageOptions,
        params,
      });
      attempt.response_mode = submitted.mode;

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

      const runDir = candidate.outputOverride
        ? null
        : buildRunDir(candidate.rootOutputDir || process.cwd(), attemptStartedAt);
      const savedPaths = [];
      const results = [];
      for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
        const image = images[imageIndex];
        const savedPath = await saveImage(image, candidate.outputOverride, runDir, imageIndex);
        if (savedPath) savedPaths.push(savedPath);
        results.push({
          savedPath: savedPath || null,
          // 远程 URL 原样保留；base64 落盘后靠本地路径展示
          url: image.imageUrl || null,
          mimeType: image.mimeType || null,
          source: image.imageUrl ? 'url' : 'base64',
        });
      }
      const savedPath = savedPaths[0] || null;

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
        family: candidate.family,
        api_style: candidate.apiStyle,
        model: candidate.model.model,
        model_key: candidate.model.key,
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
      return { attempt, savedPath, savedPaths, runDir, images, results };
    } catch (error) {
      lastError = error;
      // 这里是提交（非幂等 POST）。超时/连接重置时服务端可能已经生成并计费，
      // 所以只对「确定没送达」和「服务端明确报错」的情况重试，其余直接换 profile。
      const classification = classifyError(error, { idempotent: false });
      attempt.status = 'failed';
      attempt.last_error = truncateForLog(error.message, MAX_LOG_ERROR_LENGTH);
      attempt.error_kind = classification.kind;
      attempt.status_code = classification.statusCode;
      attempt.completed_at = new Date().toISOString();
      attempt.duration_ms = Date.now() - attemptStartedAt.getTime();

      // retryable 覆盖限流、明确失败的上游故障，以及「连接根本没建起来」的网络错误，
      // 统一在同 profile 上退避重试一次
      if (classification.retryable && index < MAX_RETRY_ATTEMPTS) {
        const delay = retryDelayFor(classification.kind, index);
        const status = classification.statusCode ? ` ${classification.statusCode}` : '';
        process.stderr.write(`遇到 ${classification.kind}${status}，${delay}ms 后重试当前 profile...\n`);
        await sleepFn(delay);
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
  // CLI 上的图生图适配项先验一遍，拼错时立刻报错而不是等每个候选都失败
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
  const runtime = resolveRuntimeConfig(cli);
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
      runRecord.status = 'success';
      runRecord.completed_at = completedAt.toISOString();
      runRecord.duration_ms = completedAt.getTime() - startedAt.getTime();
      runRecord.selected_profile = candidate.name;
      runRecord.family = candidate.family;
      runRecord.api_style = candidate.apiStyle;
      runRecord.model = candidate.model.model;
      runRecord.model_key = candidate.model.key;
      runRecord.model_source = candidate.model.source;
      runRecord.saved_path = result.savedPath || null;
      runRecord.saved_paths = result.savedPaths || [];
      runRecord.run_dir = result.runDir || null;
      writeRunLog(runRecord);

      const results = result.results || [];
      if (result.runDir) {
        process.stderr.write(`图片目录: ${result.runDir}\n`);
      }
      results.forEach((item) => {
        if (item.savedPath) process.stderr.write(`图片已保存到本地: ${item.savedPath}\n`);
      });

      if (cli.json) {
        // 给调用方一份完整结构：URL 和 base64 两种返回都能落到可展示的引用
        console.log(JSON.stringify({
          status: 'success',
          profile: candidate.name,
          family: candidate.family,
          api: candidate.apiStyle,
          model: candidate.model.model,
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
    runCandidate,
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
