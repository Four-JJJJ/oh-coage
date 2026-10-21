/**
 * 模型族 × 接口协议。
 *
 * 两个维度分开：
 *   family  = openai / gemini / grok —— 决定模型 ID、内置模型和默认站点
 *   apiStyle= openai / official      —— 决定走哪种协议
 *
 * 默认 apiStyle=openai：Gemini、Grok 的模型也走 OpenAI 兼容的 /images/generations，
 * 这样中转站和聚合网关可以直接用。只有用户显式切到 official 才发原生协议。
 */

const FAMILIES = ['openai', 'gemini', 'grok'];
const API_STYLES = ['openai', 'official'];

const FAMILY_ALIASES = new Map([
  ['openai', 'openai'],
  ['image', 'openai'],
  ['gpt', 'openai'],
  ['gemini', 'gemini'],
  ['banana', 'gemini'],
  ['nano-banana', 'gemini'],
  ['nanobanana', 'gemini'],
  ['grok', 'grok'],
  ['xai', 'grok'],
  ['x-ai', 'grok'],
]);

const API_STYLE_ALIASES = new Map([
  ['openai', 'openai'],
  ['compatible', 'openai'],
  ['relay', 'openai'],
  ['official', 'official'],
  ['native', 'official'],
  ['gemini', 'official'],
  ['grok', 'official'],
]);

const DEFAULT_URLS = {
  'openai:openai': 'https://api.openai.com/v1',
  'openai:official': 'https://api.openai.com/v1',
  'gemini:openai': 'https://generativelanguage.googleapis.com/v1beta/openai',
  'gemini:official': 'https://generativelanguage.googleapis.com/v1beta',
  'grok:openai': 'https://api.x.ai/v1',
  'grok:official': 'https://api.x.ai/v1',
};

const BUILTIN_MODELS = {
  openai: [
    { key: 'image-2', model: 'gpt-image-2' },
    { key: 'image-2.5-sunburst', model: 'gpt-image-2.5-sunburst' },
    { key: 'image-2.5-flare', model: 'gpt-image-2.5-flare' },
  ],
  gemini: [
    { key: 'banana-2.1', model: 'gemini-nano-banana-2.1' },
    { key: 'banana-2-lite', model: 'gemini-3.1-flash-lite-image' },
    { key: 'banana-2', model: 'gemini-3.1-flash-image' },
    { key: 'banana-pro', model: 'gemini-3-pro-image' },
    { key: 'banana', model: 'gemini-2.5-flash-image' },
  ],
  grok: [
    { key: 'grok-imagine-2', model: 'grok-imagine-image-2.0' },
  ],
};

// OpenAI 官方接口的取值
const OPENAI_QUALITY = new Set(['low', 'medium', 'high', 'auto']);
const OPENAI_BACKGROUND = new Set(['transparent', 'opaque', 'auto']);
const OPENAI_OUTPUT_FORMAT = new Set(['png', 'jpeg', 'webp']);
const OPENAI_MODERATION = new Set(['auto', 'low']);
const OPENAI_SIZE_ALIASES = new Map([
  ['auto', 'auto'],
  ['1:1', '1024x1024'],
  ['1024x1024', '1024x1024'],
  ['2:3', '1024x1536'],
  ['1024x1536', '1024x1536'],
  ['3:2', '1536x1024'],
  ['1536x1024', '1536x1024'],
]);

const GEMINI_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const GEMINI_IMAGE_SIZES = new Set(['512', '1K', '2K', '4K']);
const GROK_ASPECT_RATIOS = new Set([
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2',
]);
const GROK_RESOLUTIONS = new Set(['1k', '2k']);
const GROK_QUALITY = new Set(['low', 'medium', 'auto']);
const GROK_RESPONSE_FORMATS = new Set(['url', 'b64_json']);

function normalizeFamily(value) {
  const raw = String(value || 'openai').trim().toLowerCase();
  const family = FAMILY_ALIASES.get(raw);
  if (!family) {
    throw new Error(`未知模型族：${value}。可用值：openai（image）/ gemini（banana）/ grok`);
  }
  return family;
}

function normalizeApiStyle(value, family) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'openai';
  const style = API_STYLE_ALIASES.get(raw);
  if (!style) {
    throw new Error(`未知接口协议：${value}。可用值：openai（默认，OpenAI 兼容接口）/ official（官方接口）`);
  }
  return style;
}

function defaultBaseUrl(family, apiStyle = 'openai') {
  return DEFAULT_URLS[`${normalizeFamily(family)}:${normalizeApiStyle(apiStyle)}`];
}

function builtinModels(family) {
  return BUILTIN_MODELS[normalizeFamily(family)].map((entry) => ({ ...entry }));
}

function allBuiltinModels() {
  return FAMILIES.flatMap((family) => builtinModels(family).map((entry) => ({ ...entry, family })));
}

function defaultModel(family) {
  return builtinModels(family)[0];
}

function rejectUnsupported(label, params, names) {
  const present = names.filter((name) => params[name] !== undefined && params[name] !== null && params[name] !== '');
  if (present.length > 0) {
    throw new Error(`${label} 不接受参数：${present.join(', ')}。请去掉这些参数，或切换接口协议（--api）。`);
  }
}

function requireOneOf(label, name, value, allowed) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim();
  if (!allowed.has(normalized)) {
    throw new Error(`${label} 的 ${name} 不支持「${value}」。可用值：${[...allowed].join(' / ')}`);
  }
  return normalized;
}

function parseDataUri(value) {
  const match = String(value || '').match(/^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * OpenAI 兼容接口：默认协议，Gemini / Grok 的模型也走这里。
 * 请求体保持旧中转站的形状（size 用比例、resolution 用 1k/2k/4k），
 * 这样已有配置不需要改。quality / style / response_format 继续透传，
 * 因为不同中转站对这些字段的支持并不统一。
 */
function buildOpenAiCompatibleRequest(params) {
  const body = {
    model: params.model,
    prompt: params.prompt,
    n: params.n === undefined ? 1 : Number(params.n),
    size: params.size || '1:1',
    resolution: params.resolution || '2k',
  };

  if (!Number.isInteger(body.n) || body.n < 1) {
    throw new Error('n 必须是大于 0 的整数。');
  }

  if (params.imageUrls?.length) body.image_urls = params.imageUrls;
  if (params.quality) body.quality = params.quality;
  if (params.style) body.style = params.style;
  if (params.responseFormat) body.response_format = params.responseFormat;
  if (params.user) body.user = params.user;

  return {
    path: '/images/generations',
    headers: { Authorization: `Bearer ${params.apiKey}` },
    body,
  };
}

/** OpenAI 官方接口：只发官方字段，size 要换成像素值。 */
function buildOpenAiOfficialRequest(params) {
  rejectUnsupported('OpenAI 官方接口', params, ['resolution', 'imageSize', 'style']);

  const size = params.size === undefined
    ? undefined
    : requireOneOf('OpenAI 官方接口', 'size', params.size, new Set(OPENAI_SIZE_ALIASES.keys()));
  const body = {
    model: params.model,
    prompt: params.prompt,
    n: params.n === undefined ? 1 : Number(params.n),
  };

  if (size) body.size = OPENAI_SIZE_ALIASES.get(size);

  const quality = requireOneOf('OpenAI 官方接口', 'quality', params.quality, OPENAI_QUALITY);
  const background = requireOneOf('OpenAI 官方接口', 'background', params.background, OPENAI_BACKGROUND);
  const outputFormat = requireOneOf('OpenAI 官方接口', 'output_format', params.outputFormat, OPENAI_OUTPUT_FORMAT);
  const moderation = requireOneOf('OpenAI 官方接口', 'moderation', params.moderation, OPENAI_MODERATION);

  if (quality) body.quality = quality;
  if (background) body.background = background;
  if (outputFormat) body.output_format = outputFormat;
  if (moderation) body.moderation = moderation;
  if (params.user) body.user = params.user;

  if (params.outputCompression !== undefined) {
    const compression = Number(params.outputCompression);
    if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
      throw new Error('output_compression 必须是 0 到 100 的整数。');
    }
    body.output_compression = compression;
  }

  if (params.imageUrls?.length) body.image_urls = params.imageUrls;

  return {
    path: '/images/generations',
    headers: { Authorization: `Bearer ${params.apiKey}` },
    body,
  };
}

/** Gemini 官方接口：Interactions API。 */
function buildGeminiOfficialRequest(params) {
  rejectUnsupported('Gemini 官方接口', params, [
    'quality', 'background', 'outputFormat', 'outputCompression',
    'moderation', 'user', 'style', 'responseFormat',
  ]);

  if (params.n !== undefined && Number(params.n) !== 1) {
    throw new Error('Gemini 官方接口每次只生成一张图，n 只能是 1。');
  }

  const input = [{ type: 'text', text: params.prompt }];
  for (const reference of params.imageUrls || []) {
    const parsed = parseDataUri(reference);
    if (!parsed) {
      throw new Error('Gemini 官方接口只接受本地图片或 data URI 参考图，不接受远程图片 URL。');
    }
    input.push({ type: 'image', mime_type: parsed.mimeType, data: parsed.data });
  }

  const body = {
    model: params.model,
    input,
    // 生图不需要把对话留在 Google 侧
    store: false,
  };

  const aspectRatio = requireOneOf('Gemini 官方接口', 'size', params.size, GEMINI_ASPECT_RATIOS);
  const rawImageSize = params.imageSize || params.resolution;
  const imageSize = rawImageSize === undefined
    ? undefined
    : requireOneOf('Gemini 官方接口', 'image-size', String(rawImageSize).toUpperCase(), GEMINI_IMAGE_SIZES);

  if (aspectRatio || imageSize) {
    body.response_format = {
      type: 'image',
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(imageSize ? { image_size: imageSize } : {}),
    };
  }

  return {
    path: '/interactions',
    headers: { 'x-goog-api-key': params.apiKey },
    body,
  };
}

/** Grok 官方接口：xAI Imagine。 */
function buildGrokOfficialRequest(params) {
  rejectUnsupported('Grok 官方接口', params, [
    'background', 'outputFormat', 'outputCompression', 'moderation', 'user', 'style', 'imageSize',
  ]);

  const count = params.n === undefined ? 1 : Number(params.n);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error('Grok 官方接口的 n 必须是 1 到 10 的整数。');
  }

  const body = {
    model: params.model,
    prompt: params.prompt,
    n: count,
  };

  const aspectRatio = requireOneOf('Grok 官方接口', 'size', params.size, GROK_ASPECT_RATIOS);
  const resolution = requireOneOf('Grok 官方接口', 'resolution', params.resolution, GROK_RESOLUTIONS);
  const quality = requireOneOf('Grok 官方接口', 'quality', params.quality, GROK_QUALITY);
  const responseFormat = requireOneOf('Grok 官方接口', 'response-format', params.responseFormat, GROK_RESPONSE_FORMATS);

  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (quality) body.quality = quality;
  if (responseFormat) body.response_format = responseFormat;
  if (params.imageUrls?.length) body.images = params.imageUrls.map((url) => ({ url }));

  return {
    path: params.imageUrls?.length ? '/images/edits' : '/images/generations',
    headers: { Authorization: `Bearer ${params.apiKey}` },
    body,
  };
}

function buildRequest({ family, apiStyle, ...params }) {
  const resolvedFamily = normalizeFamily(family);
  const resolvedStyle = normalizeApiStyle(apiStyle, resolvedFamily);

  if (resolvedStyle === 'openai') {
    return buildOpenAiCompatibleRequest(params);
  }

  if (resolvedFamily === 'gemini') return buildGeminiOfficialRequest(params);
  if (resolvedFamily === 'grok') return buildGrokOfficialRequest(params);
  return buildOpenAiOfficialRequest(params);
}

function collectImageBlocks(value, found = []) {
  if (!value || typeof value !== 'object') return found;

  if (Array.isArray(value)) {
    value.forEach((item) => collectImageBlocks(item, found));
    return found;
  }

  if (value.type === 'image' && (value.data || value.url || value.b64_json)) {
    found.push(value);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectImageBlocks(child, found);
  }
  return found;
}

function dedupeImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    const key = `${image.imageUrl || ''}|${image.base64 || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 把各协议的响应收敛成同一形状：
 * { mode: 'sync', images: [{imageUrl, base64, mimeType}] } 或 { mode: 'async', taskId }。
 */
function extractImages({ family, apiStyle }, result) {
  const images = [];
  const data = Array.isArray(result?.data) ? result.data : [];

  for (const item of data) {
    if (item?.url || item?.b64_json) {
      images.push({ imageUrl: item.url, base64: item.b64_json, mimeType: item.mime_type });
    }
  }

  const style = normalizeApiStyle(apiStyle, family);
  const familyName = normalizeFamily(family);

  // Gemini 官方把图片放在 steps[].content[] 里，形状和 OpenAI 完全不同
  if (style === 'official' && familyName === 'gemini') {
    for (const block of collectImageBlocks(result?.steps || result?.output || result)) {
      images.push({
        imageUrl: block.url,
        base64: block.data || block.b64_json,
        mimeType: block.mime_type,
      });
    }
  }

  const taskId = result?.request_id || result?.data?.[0]?.task_id || result?.data?.task_id || result?.task_id;
  const usable = dedupeImages(images.filter((image) => image.imageUrl || image.base64));

  if (usable.length === 0 && taskId) {
    return { mode: 'async', taskId };
  }

  return { mode: 'sync', images: usable };
}

function modelLooksLike(family, modelId) {
  const id = String(modelId || '').toLowerCase();
  if (family === 'gemini') {
    return id.includes('image') || id.includes('banana') || id.includes('imagen');
  }
  if (family === 'grok') {
    return id.includes('grok') && id.includes('image');
  }
  return id.startsWith('gpt-image') || id.startsWith('dall-e') || id.startsWith('chatgpt-image');
}

/** 从 /models 的返回里挑出该模型族能生图的模型。 */
function modelEntriesFromList(family, payload) {
  const rows = payload?.data || payload?.models || [];
  return rows
    .map((row) => String(row?.id || row?.name || row?.model || '').replace(/^models\//, ''))
    .filter((model) => model && modelLooksLike(family, model))
    .map((model) => ({ key: model, model, builtin: false, discovered: true }));
}

/**
 * 同一个站点在两种协议下的路径不同：
 * Gemini 的 OpenAI 兼容端点是 /v1beta/openai，官方接口是 /v1beta。
 * 用户切换协议时不该要求他手动改 base_url。
 */
function resolveEndpointBaseUrl({ family, apiStyle, baseUrl }) {
  const style = normalizeApiStyle(apiStyle, family);
  let base = String(baseUrl || '').replace(/\/+$/, '');

  if (normalizeFamily(family) === 'gemini') {
    if (style === 'official' && /\/openai$/i.test(base)) {
      base = base.replace(/\/openai$/i, '');
    } else if (style === 'openai' && /\/v1beta$/i.test(base)) {
      base = `${base}/openai`;
    }
  }

  return base;
}

/** 拉取模型列表用的请求：OpenAI 兼容和官方接口的鉴权方式不同。 */
function buildModelListRequest({ family, apiStyle, baseUrl, apiKey }) {
  const style = normalizeApiStyle(apiStyle, family);
  const base = resolveEndpointBaseUrl({ family, apiStyle, baseUrl });

  if (style === 'official' && normalizeFamily(family) === 'gemini') {
    // Gemini 官方兼容 x-goog-api-key，避免把 key 拼进 URL 后被日志记下来
    return { url: `${base}/models`, headers: { 'x-goog-api-key': apiKey } };
  }

  return { url: `${base}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
}

module.exports = {
  FAMILIES,
  API_STYLES,
  normalizeFamily,
  normalizeApiStyle,
  defaultBaseUrl,
  builtinModels,
  allBuiltinModels,
  defaultModel,
  buildRequest,
  extractImages,
  modelLooksLike,
  modelEntriesFromList,
  buildModelListRequest,
  resolveEndpointBaseUrl,
};
