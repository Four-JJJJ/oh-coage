#!/usr/bin/env node
/**
 * GPT-Image-2 图片生成脚本
 * 提交生成任务 → 轮询任务状态 → 输出图片链接
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 配置文件路径：~/.dragoncode/config.json
const CONFIG_PATH = path.join(os.homedir(), '.dragoncode', 'config.json');
const BASE_URL = 'https://dragoncode.codes/gpt-image/v1';

/**
 * 读取配置文件中的 api_key
 */
function loadApiKey() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`错误：配置文件不存在 (${CONFIG_PATH})`);
    console.error('请先运行以下命令配置 API Key：');
    console.error('');
    if (process.platform === 'win32') {
      console.error(`  mkdir "%USERPROFILE%\\.dragoncode" && echo {"api_key":"YOUR_KEY"} > "%USERPROFILE%\\.dragoncode\\config.json"`);
    } else {
      console.error(`  mkdir -p ~/.dragoncode && echo '{"api_key":"YOUR_KEY"}' > ~/.dragoncode/config.json`);
    }
    console.error('');
    console.error('API Key 创建地址：https://dragoncode.codes/keys');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  if (!config.api_key || config.api_key === 'YOUR_KEY') {
    console.error('错误：请在配置文件中填入真实的 API Key');
    console.error(`配置文件路径：${CONFIG_PATH}`);
    process.exit(1);
  }
  return config.api_key;
}

/**
 * 发送 HTTP 请求
 */
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 提交图片生成任务
 */
async function submitTask(apiKey, prompt, size, resolution) {
  const payload = JSON.stringify({
    model: 'gpt-image-2',
    prompt,
    n: 1,
    size,
    resolution,
  });

  const result = await request(`${BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  }, payload);

  return result.data[0].task_id;
}

/**
 * 轮询任务状态，返回图片 URL
 */
async function pollTask(apiKey, taskId) {
  const timeout = 5 * 60 * 1000;
  const interval = 5000;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeout) {
      throw new Error('任务超时（超过 5 分钟）');
    }

    const result = await request(`${BASE_URL}/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    const { status, progress, result: taskResult, error } = result.data;

    if (status === 'completed') {
      return taskResult.images[0].url[0];
    }
    if (status === 'failed') {
      throw new Error(error?.message || '任务失败');
    }

    process.stderr.write(`生成中... ${progress || 0}%\n`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { size: '1:1', resolution: '2k' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--prompt': parsed.prompt = args[++i]; break;
      case '--size': parsed.size = args[++i]; break;
      case '--resolution': parsed.resolution = args[++i]; break;
    }
  }

  if (!parsed.prompt) {
    console.error('用法: node generate.js --prompt "提示词" [--size 1:1] [--resolution 2k]');
    process.exit(1);
  }
  return parsed;
}

// 4K 比例限制
const VALID_4K_SIZES = new Set(['16:9', '9:16', '2:1', '1:2', '21:9', '9:21']);

async function main() {
  const { prompt, size, resolution } = parseArgs();
  const apiKey = loadApiKey();

  // 4K 比例限制检查
  let finalResolution = resolution;
  if (resolution === '4k' && !VALID_4K_SIZES.has(size)) {
    process.stderr.write(`注意：4K 不支持 ${size} 比例，自动降为 2K\n`);
    finalResolution = '2k';
  }

  process.stderr.write(`正在提交任务: prompt=${prompt}, size=${size}, resolution=${finalResolution}\n`);

  const taskId = await submitTask(apiKey, prompt, size, finalResolution);
  process.stderr.write(`任务已提交: ${taskId}\n`);

  const imageUrl = await pollTask(apiKey, taskId);
  // 图片链接输出到 stdout
  console.log(imageUrl);
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  process.exit(1);
});
