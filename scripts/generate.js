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
  loadActiveConfig,
  readKeychainSecret,
  ensureDir,
  appendJsonl,
} = require('./config-store');

const VALID_4K_SIZES = new Set(['16:9', '9:16', '2:1', '1:2', '21:9', '9:21']);
const REQUEST_TIMEOUT_MS = 90 * 1000;
const POLL_TIMEOUT_MS = 20 * 1000;
const TASK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
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

function parseHttpStatus(error) {
  const match = String(error?.message || '').match(/HTTP\s+(\d{3})/);
  return match ? Number(match[1]) : null;
}

function classifyError(error) {
  const message = String(error?.message || '');
  const statusCode = parseHttpStatus(error);
  const lower = message.toLowerCase();

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
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          return;
        }

        if (!raw) {
          resolve(null);
          return;
        }

        const contentType = String(res.headers['content-type'] || '');
        if (contentType.includes('application/json')) {
          resolve(JSON.parse(raw));
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

async function submitGeneration(apiKey, baseUrl, prompt, size, resolution, imageUrls) {
  const body = {
    model: 'gpt-image-2',
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

  throw new Error(`无法识别生成接口返回结构: ${JSON.stringify(result)}`);
}

async function pollTask(apiKey, baseUrl, taskId) {
  const interval = 5000;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > TASK_TIMEOUT_MS) {
      throw new Error(`任务超时（超过 ${TASK_TIMEOUT_MS}ms）`);
    }

    const result = await request(`${baseUrl}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, null, POLL_TIMEOUT_MS);

    const { status, progress, result: taskResult, error } = result.data;

    if (status === 'completed') {
      const image = extractImagePayload({ data: { result: taskResult } });
      if (image.imageUrl || image.base64) {
        return image;
      }
      throw new Error('任务已完成，但未找到图片结果');
    }

    if (status === 'failed') {
      throw new Error(error?.message || '任务失败');
    }

    process.stderr.write(`生成中... ${progress || 0}%\n`);
    await sleep(interval);
  }
}

function inferExtension(contentType, source) {
  if (contentType?.includes('png') || source?.startsWith('data:image/png')) return '.png';
  if (contentType?.includes('webp') || source?.startsWith('data:image/webp')) return '.webp';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg') || source?.startsWith('data:image/jpeg')) return '.jpg';
  return '.png';
}

function looksLikeRemoteImageReference(value) {
  return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
}

function imageFileToDataUri(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`参考图片不存在: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`参考图片不是文件: ${resolvedPath}`);
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

async function downloadToFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 400) {
        reject(new Error(`下载失败，HTTP ${res.statusCode}`));
        return;
      }

      const target = fs.createWriteStream(filePath);
      res.pipe(target);
      target.on('finish', () => target.close(() => resolve(filePath)));
      target.on('error', reject);
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
    const [, meta, encoded] = dataUri.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!encoded) {
      throw new Error('base64 图片格式不合法');
    }

    const filePath = buildOutputPath(output, inferExtension(meta, dataUri), runDir);
    fs.writeFileSync(filePath, Buffer.from(encoded, 'base64'));
    return filePath;
  }

  if (image.imageUrl) {
    const filePath = buildOutputPath(output, inferExtension('', image.imageUrl), runDir);
    await downloadToFile(image.imageUrl, filePath);
    return filePath;
  }

  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { size: '1:1', resolution: '2k', imageUrls: [], autoFallback: true };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--prompt': parsed.prompt = args[++i]; break;
      case '--size': parsed.size = args[++i]; break;
      case '--resolution': parsed.resolution = args[++i]; break;
      case '--image-url': parsed.imageUrls.push(args[++i]); break;
      case '--base-url': parsed.baseUrl = args[++i]; break;
      case '--api-key': parsed.apiKey = args[++i]; break;
      case '--output': parsed.output = path.resolve(args[++i]); break;
      case '--out-dir': parsed.outDir = path.resolve(args[++i]); break;
      case '--profile': parsed.profile = args[++i]; break;
      case '--no-fallback': parsed.autoFallback = false; break;
    }
  }

  if (!parsed.prompt) {
    console.error('用法: node generate.js --prompt "提示词" [--profile NAME] [--size 1:1] [--resolution 2k] [--image-url URL] [--base-url URL] [--api-key KEY] [--output FILE | --out-dir DIR] [--no-fallback]');
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
    source: cli.apiKey ? 'cli' : 'env',
  }] : [];

  const configCandidates = candidateProfiles.map(([name, profile]) => ({
    name,
    keychainAccount: profile.keychain_account,
    baseUrl: normalizeBaseUrl(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL || profile.base_url || DEFAULT_BASE_URL),
    rootOutputDir: cli.outDir ? path.resolve(cli.outDir) : path.resolve(profile.root_output_dir || profile.output_dir || process.cwd()),
    outputOverride: cli.output || null,
    source: 'profile',
  }));

  const candidates = manualCandidate.length > 0
    ? (cli.autoFallback ? manualCandidate.concat(configCandidates) : manualCandidate)
    : (cli.autoFallback ? configCandidates : configCandidates.slice(0, 1));

  if (!candidates.length) {
    printSetupInstructions();
    process.exit(1);
  }

  return {
    candidates,
    activeProfileName,
    autoFallback: cli.autoFallback,
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
    explicit_profile: cli.profile || null,
    auto_fallback: cli.autoFallback,
  };
}

function writeRunLog(record) {
  appendJsonl(RUNS_PATH, record);
}

async function runCandidate(candidate, cli, finalResolution, runRecord) {
  const attemptStartedAt = new Date();
  const attempt = {
    profile: candidate.name,
    base_url: candidate.baseUrl,
    started_at: attemptStartedAt.toISOString(),
  };
  const candidateApiKey = candidate.apiKey || readKeychainSecret(candidate.keychainAccount);

  const mode = cli.imageUrls.length > 0 ? '图生图' : '文生图';
  process.stderr.write(`正在提交${mode}任务: profile=${candidate.name}, base_url=${candidate.baseUrl}, prompt=${cli.prompt}, size=${cli.size}, resolution=${finalResolution}\n`);
  if (cli.imageUrls.length > 0) {
    process.stderr.write(`参考图片: ${cli.imageUrls.length} 张\n`);
  }

  let lastError = null;
  for (let index = 1; index <= MAX_RETRY_ATTEMPTS; index++) {
    attempt.try_count = index;
    try {
      const submitted = await submitGeneration(candidateApiKey, candidate.baseUrl, cli.prompt, cli.size, finalResolution, cli.imageUrls);
      attempt.response_mode = submitted.mode;

      const image = submitted.mode === 'async'
        ? await (attempt.task_id = submitted.taskId, process.stderr.write(`任务已提交: ${submitted.taskId}\n`), pollTask(candidateApiKey, candidate.baseUrl, submitted.taskId))
        : (process.stderr.write('接口直接返回了图片结果\n'), submitted.image);

      const runDir = candidate.outputOverride ? null : buildRunDir(candidate.rootOutputDir, attemptStartedAt);
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
      attempt.last_error = error.message;
      attempt.error_kind = classification.kind;
      attempt.status_code = classification.statusCode;
      attempt.completed_at = new Date().toISOString();
      attempt.duration_ms = Date.now() - attemptStartedAt.getTime();

      if (classification.kind === 'rate_limit' && index < MAX_RETRY_ATTEMPTS) {
        const delay = 1500 * index;
        process.stderr.write(`遇到限流，${delay}ms 后重试当前 profile...\n`);
        await sleep(delay);
        continue;
      }

      if (classification.retryable && index < MAX_RETRY_ATTEMPTS && classification.kind === 'network') {
        const delay = 1000 * index;
        process.stderr.write(`遇到网络错误，${delay}ms 后重试当前 profile...\n`);
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
      runRecord.final_error = error.message;
      runRecord.final_error_kind = classification.kind;
      runRecord.final_status_code = classification.statusCode;
      writeRunLog(runRecord);
      throw error;
    }
  }

  throw new Error('没有可用的 profile 可继续尝试');
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exit(1);
});
