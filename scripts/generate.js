#!/usr/bin/env node
/**
 * GPT-Image-2 图片生成脚本
 * 支持首次初始化后的 profile 配置、同步返回和异步任务轮询，并可选保存到本地。
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const {
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  loadActiveConfig,
  readKeychainSecret,
  ensureDir,
} = require('./config-store');

const VALID_4K_SIZES = new Set(['16:9', '9:16', '2:1', '1:2', '21:9', '9:21']);

function printSetupInstructions() {
  console.error('错误：尚未完成 images2-gen 初始化。');
  console.error('请先让 agent 收集以下信息后运行 setup.js：');
  console.error('1. 图片输出目录');
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

function request(url, options, body) {
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
  }, JSON.stringify(body));

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
  const timeout = 5 * 60 * 1000;
  const interval = 5000;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error('任务超时（超过 5 分钟）');
    }

    const result = await request(`${baseUrl}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

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
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function inferExtension(contentType, source) {
  if (contentType?.includes('png') || source?.startsWith('data:image/png')) return '.png';
  if (contentType?.includes('webp') || source?.startsWith('data:image/webp')) return '.webp';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg') || source?.startsWith('data:image/jpeg')) return '.jpg';
  return '.png';
}

function buildOutputPath(output, outDir, extension) {
  if (output) {
    ensureDir(path.dirname(output));
    return output;
  }

  ensureDir(outDir);
  return path.join(outDir, `gpt-image-${Date.now()}${extension}`);
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
    req.on('error', reject);
  });
}

async function saveImage(image, output, outDir) {
  if (!output && !outDir) {
    return null;
  }

  if (image.base64) {
    const dataUri = image.base64.startsWith('data:') ? image.base64 : `data:image/png;base64,${image.base64}`;
    const [, meta, encoded] = dataUri.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!encoded) {
      throw new Error('base64 图片格式不合法');
    }

    const filePath = buildOutputPath(output, outDir, inferExtension(meta, dataUri));
    fs.writeFileSync(filePath, Buffer.from(encoded, 'base64'));
    return filePath;
  }

  if (image.imageUrl) {
    const filePath = buildOutputPath(output, outDir, inferExtension('', image.imageUrl));
    await downloadToFile(image.imageUrl, filePath);
    return filePath;
  }

  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { size: '1:1', resolution: '2k', imageUrls: [] };

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
    }
  }

  if (!parsed.prompt) {
    console.error('用法: node generate.js --prompt "提示词" [--profile NAME] [--size 1:1] [--resolution 2k] [--image-url URL] [--base-url URL] [--api-key KEY] [--output FILE | --out-dir DIR]');
    process.exit(1);
  }

  return parsed;
}

function resolveRuntimeConfig(cli) {
  const { config } = loadActiveConfig();
  const profileName = cli.profile || config?.active_profile;
  const profile = profileName ? config?.profiles?.[profileName] : null;

  if (!cli.apiKey && !process.env.IMAGES2_GEN_API_KEY && !profile) {
    printSetupInstructions();
    process.exit(1);
  }

  const apiKey = cli.apiKey || process.env.IMAGES2_GEN_API_KEY || readKeychainSecret(profile.keychain_account);
  const baseUrl = normalizeBaseUrl(cli.baseUrl || process.env.IMAGES2_GEN_BASE_URL || profile?.base_url || DEFAULT_BASE_URL);
  const defaultOutDir = cli.outDir || profile?.output_dir || process.cwd();

  return {
    apiKey,
    baseUrl,
    outDir: cli.output ? null : path.resolve(defaultOutDir),
    profileName,
  };
}

async function main() {
  const cli = parseArgs();
  const runtime = resolveRuntimeConfig(cli);

  let finalResolution = cli.resolution;
  if (cli.resolution === '4k' && !VALID_4K_SIZES.has(cli.size)) {
    process.stderr.write(`注意：4K 不支持 ${cli.size} 比例，自动降为 2K\n`);
    finalResolution = '2k';
  }

  const mode = cli.imageUrls.length > 0 ? '图生图' : '文生图';
  const profileText = runtime.profileName ? `profile=${runtime.profileName}, ` : '';
  process.stderr.write(`正在提交${mode}任务: ${profileText}base_url=${runtime.baseUrl}, prompt=${cli.prompt}, size=${cli.size}, resolution=${finalResolution}\n`);

  if (cli.imageUrls.length > 0) {
    process.stderr.write(`参考图片: ${cli.imageUrls.length} 张\n`);
  }

  const submitted = await submitGeneration(runtime.apiKey, runtime.baseUrl, cli.prompt, cli.size, finalResolution, cli.imageUrls);
  const image = submitted.mode === 'async'
    ? await (process.stderr.write(`任务已提交: ${submitted.taskId}\n`), pollTask(runtime.apiKey, runtime.baseUrl, submitted.taskId))
    : (process.stderr.write('接口直接返回了图片结果\n'), submitted.image);

  const savedPath = await saveImage(image, cli.output, runtime.outDir);
  if (savedPath) {
    process.stderr.write(`图片已保存到本地: ${savedPath}\n`);
    console.log(savedPath);
    return;
  }

  if (image.imageUrl) {
    console.log(image.imageUrl);
    return;
  }

  console.log(image.base64);
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exit(1);
});
