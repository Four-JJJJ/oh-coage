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

// 图生图适配维度：各站点的参考图字段名、传输方式、端点都不一样，做成可配置的
const IMAGE_TRANSPORTS = ['json', 'multipart'];
const IMAGE_FIELD_SHAPES = ['array', 'array-object', 'single'];

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

// 参考图字段的常见写法。不同中转站/官方接口各认一套，所以做成 profile 可配置。
const IMAGE_FIELD_ALIASES = new Map([
  ['image_urls', 'image_urls'],
  ['imageurls', 'image_urls'],
  ['images', 'images'],
  ['image', 'image'],
  ['image_url', 'image_url'],
  ['imageurl', 'image_url'],
  ['input_image', 'input_image'],
  ['input_images', 'input_images'],
  ['init_image', 'init_image'],
  ['init_images', 'init_images'],
  ['reference_images', 'reference_images'],
  ['reference_image', 'reference_image'],
  ['ref_images', 'reference_images'],
]);

const IMAGE_TRANSPORT_ALIASES = new Map([
  ['json', 'json'],
  ['body', 'json'],
  ['multipart', 'multipart'],
  ['form', 'multipart'],
  ['form-data', 'multipart'],
  ['formdata', 'multipart'],
]);

const IMAGE_FIELD_SHAPE_ALIASES = new Map([
  ['array', 'array'],
  ['list', 'array'],
  ['array-object', 'array-object'],
  ['array-of-objects', 'array-object'],
  ['object-array', 'array-object'],
  ['single', 'single'],
  ['string', 'single'],
]);

// 参考图落在这些字段里时，天然就是「对象数组」形状
const OBJECT_SHAPED_FIELDS = new Set(['images', 'input_images', 'reference_images']);

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
 * 参考图字段名。允许自定义任意名字（站点各写各的），
 * 但必须是安全的标识符，否则拼进 multipart 头会出问题。
 */
function normalizeImageField(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const normalized = IMAGE_FIELD_ALIASES.get(raw.toLowerCase()) || raw;
  if (!/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(normalized)) {
    throw new Error(`参考图字段名不合法：${value}。只能包含字母、数字、_ - . 和 []。`);
  }
  return normalized;
}

function normalizeImageTransport(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const transport = IMAGE_TRANSPORT_ALIASES.get(raw);
  if (!transport) {
    throw new Error(`未知参考图传输方式：${value}。可用值：${IMAGE_TRANSPORTS.join(' / ')}`);
  }
  return transport;
}

function normalizeImageShape(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const shape = IMAGE_FIELD_SHAPE_ALIASES.get(raw);
  if (!shape) {
    throw new Error(`未知参考图取值形状：${value}。可用值：${IMAGE_FIELD_SHAPES.join(' / ')}`);
  }
  return shape;
}

/**
 * 参考图端点。
 *   - 没配：按传输方式推导（JSON → /images/generations，multipart → /images/edits）
 *   - 相对路径：补上开头的 /，拼在 base_url 后面
 *   - 完整 URL：直接使用，方便少数网关把生图和改图放在不同域名
 */
function resolveImageEndpoint(value, transport) {
  const raw = String(value || '').trim();
  if (!raw) return transport === 'multipart' ? '/images/edits' : '/images/generations';
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** 只保留用户真实给出的项，null / undefined / 空串不参与合并，避免把默认值盖成空。 */
function definedOnly(input) {
  const result = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

/**
 * 把 profile / CLI 上的图生图适配项收敛成一份确定的配置。
 * 一个都不配时，行为和旧版完全一致（JSON + image_urls + /images/generations）。
 *
 * OpenAI 官方接口例外：它没有 image_urls 这回事，改图一律 /images/edits + multipart image[]，
 * 所以带 family / apiStyle 进来时会先把这套默认垫底。
 */
function resolveImageOptions(input = {}, context = {}) {
  const family = context.family ? normalizeFamily(context.family) : null;
  const apiStyle = family && context.apiStyle ? normalizeApiStyle(context.apiStyle, family) : null;
  const explicit = definedOnly(input);

  // 用户自己指定了传输方式时，整套形状就跟着那个传输方式走，不再垫官方默认；
  // 否则（未指定或只指定了字段名/端点）官方接口默认垫上 multipart + image。
  const officialDefault = family === 'openai'
    && apiStyle === 'official'
    && !explicit.imageTransport
    ? { imageTransport: 'multipart', imageField: 'image' }
    : {};

  const merged = { ...officialDefault, ...explicit };
  const transport = normalizeImageTransport(merged.imageTransport) || 'json';
  const explicitField = normalizeImageField(merged.imageField);
  // multipart 下 OpenAI 的 /images/edits 认的是 image/image[]，不是 image_urls
  const field = explicitField || (transport === 'multipart' ? 'image' : 'image_urls');
  // 形状取值统一用 IMAGE_FIELD_SHAPES 里的拼写（array-object），
  // 不要再冒出 object-array 这种第二套写法，否则 shapeImageValues 会认不出来、
  // 把用户明确要求的对象数组静默降级成字符串数组。
  const shape = normalizeImageShape(merged.imageShape)
    || (OBJECT_SHAPED_FIELDS.has(field) ? 'array-object' : 'array');

  return {
    field,
    transport,
    shape,
    endpoint: resolveImageEndpoint(merged.imageEndpoint, transport),
  };
}

function shapeImageValues(images, shape) {
  if (shape === 'single') {
    // 单值形状装不下多张参考图，静默丢掉会让用户以为多图生效了
    if (images.length > 1) {
      throw new Error(
        `参考图形状是 single（单值字段），但本次给了 ${images.length} 张参考图。`
        + '请改用 --image-shape array（字符串数组）或 array-object（对象数组），或只传一张参考图。',
      );
    }
    return images[0];
  }
  if (shape === 'array-object') return images.map((value) => ({ url: value }));
  return images.slice();
}

// 兼容接口的 size 用比例。这里只拦「明显写错」的输入，
// 不做严格白名单——不同中转站支持的比例并不一致，收得太死会误伤。
const ASPECT_RATIO_PATTERN = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;
// 4K 只在这些比例下可用，其余比例传 4k 会被上游拒或产出异常图
const VALID_4K_SIZES = new Set(['16:9', '9:16', '2:1', '1:2', '21:9', '9:21']);
const RESOLUTIONS = new Set(['1k', '2k', '4k']);

function normalizeResolution(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '2k';
  if (!RESOLUTIONS.has(raw)) {
    throw new Error(`resolution 不支持「${value}」。可用值：${[...RESOLUTIONS].join(' / ')}`);
  }
  return raw;
}

/**
 * 校验 size，并兑现文档承诺的 4K 降级：
 * 4K 遇到不支持的比例时自动降到 2k，而不是把非法组合原样发给站点。
 */
function resolveSizeAndResolution(sizeInput, resolutionInput, warn = () => {}) {
  const size = String(sizeInput || '').trim();
  if (size && size !== 'auto' && !ASPECT_RATIO_PATTERN.test(size)) {
    throw new Error(
      `size 不支持「${sizeInput}」。OpenAI 兼容接口用比例，例如 1:1 / 16:9 / 9:16 / 2:3；`
      + '传像素值请改用 --api official。',
    );
  }

  let resolution = normalizeResolution(resolutionInput);
  const effectiveSize = size || '1:1';

  if (resolution === '4k' && !VALID_4K_SIZES.has(effectiveSize)) {
    warn(`4K 不支持比例 ${effectiveSize}，已自动降级到 2k（4K 支持：${[...VALID_4K_SIZES].join(' / ')}）。`);
    resolution = '2k';
  }

  return { size: effectiveSize, resolution };
}

/**
 * OpenAI 兼容接口：默认协议，Gemini / Grok 的模型也走这里。
 * 请求体保持旧中转站的形状（size 用比例、resolution 用 1k/2k/4k），
 * 这样已有配置不需要改。quality / style / response_format 继续透传，
 * 因为不同中转站对这些字段的支持并不统一。
 */
function buildOpenAiCompatibleRequest(params) {
  const images = params.imageUrls || [];
  const imageOptions = resolveImageOptions(params.imageOptions);
  const { size, resolution } = resolveSizeAndResolution(params.size, params.resolution, params.warn);
  const body = {
    model: params.model,
    prompt: params.prompt,
    n: params.n === undefined ? 1 : Number(params.n),
    size,
    resolution,
  };

  if (!Number.isInteger(body.n) || body.n < 1) {
    throw new Error('n 必须是大于 0 的整数。');
  }

  if (params.quality) body.quality = params.quality;
  if (params.style) body.style = params.style;
  if (params.responseFormat) body.response_format = params.responseFormat;
  if (params.user) body.user = params.user;

  const headers = { Authorization: `Bearer ${params.apiKey}` };

  if (images.length === 0) {
    return { path: '/images/generations', headers, body };
  }

  // multipart：参考图不进 JSON，改成文件字段，由调用方拼 body
  if (imageOptions.transport === 'multipart') {
    return {
      path: imageOptions.endpoint,
      headers,
      body,
      transport: 'multipart',
      imageField: imageOptions.field,
      imageUrls: images,
    };
  }

  body[imageOptions.field] = shapeImageValues(images, imageOptions.shape);

  return { path: imageOptions.endpoint, headers, body };
}

/** OpenAI 官方接口：只发官方字段，size 要换成像素值。 */
function buildOpenAiOfficialRequest(params) {
  rejectUnsupported('OpenAI 官方接口', params, ['resolution', 'imageSize', 'style']);

  const images = params.imageUrls || [];
  // 官方接口没有 image_urls 这回事：改图默认走 /images/edits + multipart image[]。
  // 用户在 imageOptions 里显式写的值仍然优先。
  const imageOptions = resolveImageOptions(params.imageOptions, {
    family: 'openai',
    apiStyle: 'official',
  });

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

  const headers = { Authorization: `Bearer ${params.apiKey}` };

  if (images.length === 0) {
    return { path: '/images/generations', headers, body };
  }

  if (imageOptions.transport === 'multipart') {
    return {
      path: imageOptions.endpoint,
      headers,
      body,
      transport: 'multipart',
      imageField: imageOptions.field,
      imageUrls: images,
    };
  }

  body[imageOptions.field] = shapeImageValues(images, imageOptions.shape);

  return { path: imageOptions.endpoint, headers, body };
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

/**
 * 从异步任务的轮询响应里取出**全部**图片。
 * 早期版本只取第一张，导致 `--n 3` 的异步任务虽然付了 3 张的钱，却只落盘 1 张。
 * 这里把站点可能用的几种形状都收一遍：result.images / result.data / 顶层 images / 递归 image block。
 */
function extractTaskImages(payload) {
  const found = [];

  const push = (item) => {
    if (!item || typeof item !== 'object') return;
    const imageUrl = item.url || item.image_url;
    const base64 = item.b64_json || item.base64;
    if (imageUrl || base64) {
      found.push({ imageUrl, base64, mimeType: item.mime_type || item.mimeType });
    }
  };

  const containers = [
    payload?.result?.images,
    payload?.images,
    payload?.result?.data,
    payload?.data,
  ];

  for (const container of containers) {
    if (Array.isArray(container)) container.forEach(push);
  }

  // 少数站点不返回数组，直接把单张图片平铺在顶层或 result 里
  push(payload?.result);
  push(payload);

  // 兜底：Gemini 官方那种 steps[].content[] 结构，或站点自定义的嵌套
  for (const block of collectImageBlocks(payload?.result || payload)) {
    found.push({
      imageUrl: block.url,
      base64: block.data || block.b64_json,
      mimeType: block.mime_type,
    });
  }

  return dedupeImages(found.filter((image) => image.imageUrl || image.base64));
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
  IMAGE_TRANSPORTS,
  IMAGE_FIELD_SHAPES,
  normalizeFamily,
  normalizeApiStyle,
  normalizeImageField,
  normalizeImageTransport,
  normalizeImageShape,
  resolveImageOptions,
  resolveImageEndpoint,
  shapeImageValues,
  defaultBaseUrl,
  builtinModels,
  allBuiltinModels,
  defaultModel,
  buildRequest,
  extractImages,
  extractTaskImages,
  resolveSizeAndResolution,
  normalizeResolution,
  VALID_4K_SIZES,
  OPENAI_QUALITY_VALUES: [...OPENAI_QUALITY],
  modelLooksLike,
  modelEntriesFromList,
  buildModelListRequest,
  resolveEndpointBaseUrl,
};
