#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./config-store');
const { resolveModel } = require('./models');
const { buildModelListRequest } = require('./providers');
const { FAMILIES, modelFamilyHint, inferModelFamily, getFamilyConfig, normalizeFamilySelection } = require('./family-config');

function revision(config) {
  const clean = JSON.parse(JSON.stringify(config));
  for (const profile of Object.values(clean.profiles || {})) delete profile.resolved_root_output_dir;
  return crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex');
}
function context(name) {
  const loaded = store.loadActiveConfig();
  if (!loaded.config) throw new Error('尚未完成初始化，请先连接生图服务。');
  const profileName = name || loaded.config.active_profile;
  const profile = loaded.config.profiles?.[profileName];
  if (!profile) throw new Error('配置不存在，请重新选择配置。');
  return { ...loaded, profileName, profile };
}
function modelId(value, config) {
  try { return resolveModel(value, config, null, true).model; } catch { return value; }
}
function snapshot(name) {
  const { config, profileName, profile } = context(name);
  const order = [...new Set([profile.model || config.current_model || 'image-2', ...(profile.fallback_models || [])].map(value => modelId(value, config)))];
  const catalogRows = [...(profile.synced_models || []), ...(profile.manual_models || [])]
    .map(row => typeof row === 'string' ? { id: row } : row)
    .filter(row => row?.id || row?.model);
  const catalogById = new Map(catalogRows.map(row => [row.id || row.model, row]));
  const available = [...new Set(catalogById.keys())];
  const { modelFamilies, activeFamily } = getFamilyConfig(profile, config);
  const selected = Object.values(modelFamilies).flatMap(group => [group.primary, ...group.fallbacks]);
  const fullCatalog = [...new Set([...available, ...selected])];
  const models = fullCatalog.map(id => ({ ...(catalogById.get(id) || {}), id, stale: !available.includes(id), capability: 'unverified' }));
  const familyFor = id => inferModelFamily(catalogById.get(id) || id, profile, config);
  return {
    schema: 'model-families-v1',
    profile: profileName,
    revision: revision(config),
    currentModel: modelFamilies[activeFamily]?.primary || order[0],
    modelFamilies,
    activeFamily,
    order,
    models,
    modelGroups: Object.fromEntries(FAMILIES.map(family => [family, fullCatalog.filter(id => familyFor(id) === family)])),
    modelFamilyTags: Object.fromEntries(models.flatMap(row => {
      const family = familyFor(row.id);
      return family === 'other' ? [] : [[row.id, family]];
    })),
    unknownModels: fullCatalog.filter(id => familyFor(id) === 'other' && !catalogById.get(id)?.family && !catalogById.get(id)?.provider && !catalogById.get(id)?.owned_by && !modelFamilyHint(id, {}, config)),
    missingModels: selected.filter(id => !available.includes(id)),
    apiStyle: profile.api_style || 'openai',
    profileFamily: profile.family || 'openai',
    syncedAt: profile.models_synced_at || null,
    message: '列表来自当前配置；未验证实际出图能力。未返回的已保存模型仍保留，请刷新列表或修改主备模型。',
  };
}
function resolveSelection(input, data) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) throw new Error('请选择一个模型。');
  const available = data.models.filter(row => !row.stale);
  const exact = available.filter(row => row.id.toLowerCase() === raw);
  if (exact.length === 1) return exact[0].id;
  const matches = available.filter(row => row.id.toLowerCase().includes(raw));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`名称对应多个模型，请选择完整 ID：${matches.map(row => row.id).join('、')}`);
  throw new Error('当前站点列表中没有这个模型，请刷新列表、管理模型或切换配置。');
}
function apply(input) {
  const data = snapshot(input.profile);
  if (input.revision !== data.revision) throw new Error('配置已更新，请重新打开模型选择页面，避免覆盖新的设置。');
  const { config: currentConfig, profile: currentProfile } = context(data.profile);
  const userTags = input.modelFamilyTags || {};
  const allowedFamilies = new Set(FAMILIES);
  for (const [id, family] of Object.entries(userTags)) {
    const row = data.models.find(entry => entry.id === id && !entry.stale);
    const known = data.modelFamilyTags[id];
    if (!row || !allowedFamilies.has(family) || (known && known !== family)) throw new Error(`模型 ${id} 的厂家标记无效，请重新选择。`);
  }
  const modelRows = data.models.map(row => ({
    ...row,
    ...(userTags[row.id] ? { family: userTags[row.id] } : {}),
  }));
  const configuredModelFamilies = Object.fromEntries(Object.entries(data.modelFamilies).map(([family, group]) => [family, group]));
  const priorFamilyById = new Map(Object.entries(configuredModelFamilies).flatMap(([family, group]) => [group.primary, ...(group.fallbacks || [])].map(id => [id, family])));
  let modelFamilies;
  let activeFamily;
  if (input.modelFamilies && !input.model) {
    for (const [family, group] of Object.entries(input.modelFamilies)) {
      for (const id of [group.primary, ...(group.fallbacks || [])]) {
        if (priorFamilyById.has(id) && priorFamilyById.get(id) !== family && userTags[id] !== family) {
          throw new Error(`模型 ${id} 已归属 ${priorFamilyById.get(id)}；请先更新厂家归属再移动。`);
        }
      }
    }
    const selection = normalizeFamilySelection(input.modelFamilies, input.activeFamily, {
      models: modelRows,
      profile: { ...currentProfile, synced_models: modelRows.filter(row => !row.stale), model_families: data.modelFamilies },
      config: currentConfig,
      apiStyle: currentProfile.api_style,
      allowMissingForInactive: input.action === 'default',
    });
    ({ modelFamilies, activeFamily } = selection);
  } else {
    const selectedModel = resolveSelection(input.model, data);
    const family = userTags[selectedModel] || inferModelFamily(selectedModel, { ...currentProfile, synced_models: modelRows }, currentConfig);
    const previous = data.modelFamilies[family];
    const selection = normalizeFamilySelection({ ...data.modelFamilies, [family]: { primary: selectedModel, fallbacks: (previous?.fallbacks || []).filter(id => id !== selectedModel).slice(0, 1) } }, family, { models: modelRows, profile: { ...currentProfile, synced_models: modelRows }, config: currentConfig });
    ({ modelFamilies, activeFamily } = selection);
  }
  const model = modelFamilies[activeFamily].primary;
  if (input.action === 'temporary') {
    return { status: 'selected', scope: 'temporary', profile: data.profile, model, modelFamilies: { [activeFamily]: { primary: model, fallbacks: [] } }, activeFamily, changed: false, instruction: '仅本次指定所选厂家的主模型；生成时使用 --profile 和 --model。本次不保存其他厂家编辑，也不自动尝试备选。' };
  }
  if (input.action !== 'default') throw new Error('请选择“仅本次”或“设为默认”。');
  const { configPath } = context(data.profile);
  const release = store.acquireConfigLock(configPath);
  try {
    const config = store.loadConfigFromPath(configPath);
    if (revision(config) !== input.revision) throw new Error('配置已更新，请重新加载后再保存。');
    const profile = config.profiles[data.profile];
    const order = [model, ...modelFamilies[activeFamily].fallbacks];
    profile.model_families = modelFamilies;
    profile.active_model_family = activeFamily;
    profile.model = model;
    profile.fallback_models = order.slice(1);
    profile.synced_models = modelRows.filter(row => !row.stale).map(({ stale, capability, ...row }) => row);
    config.discovered_models ||= {};
    for (const [id, family] of Object.entries(userTags)) {
      const row = modelRows.find(entry => entry.id === id);
      config.discovered_models[id] = { ...row, model: id, family, family_source: 'user', source_profile: data.profile };
    }
    for (const [family, group] of Object.entries(modelFamilies)) {
      for (const id of [group.primary, ...group.fallbacks]) {
        const row = modelRows.find(entry => entry.id === id);
        if (row && !config.discovered_models[id]) config.discovered_models[id] = { ...row, model: id, family, family_source: row.family ? 'metadata' : 'user', source_profile: data.profile };
      }
    }
    profile.updated_at = config.updated_at = new Date().toISOString();
    for (const value of Object.values(config.profiles)) delete value.resolved_root_output_dir;
    store.writeJson(configPath, config);
    return { status: 'saved', scope: 'default', profile: data.profile, model, order, modelFamilies, activeFamily, changed: true };
  } finally { release(); }
}
async function refresh(input) {
  const { profile, config, configPath, profileName } = context(input.profile);
  const expected = input.revision || revision(config);
  if (expected !== revision(config)) throw new Error('配置已更新，请重新加载。');
  const address = store.assertValidBaseUrl(profile.base_url);
  if (address.username || address.password || address.search || address.hash) throw new Error('服务地址包含凭据、查询参数或片段，请先修正连接信息。');
  const spec = buildModelListRequest({ family: profile.family || 'openai', apiStyle: profile.api_style || 'openai', baseUrl: profile.base_url, apiKey: store.readKeychainSecret(profile.keychain_account) });
  const rowsById = new Map();
  const pages = new Set();
  let nextUrl = spec.url;
  while (nextUrl) {
    if (pages.has(nextUrl) || pages.size >= 100) throw new Error('模型列表分页异常，原列表已保留。');
    pages.add(nextUrl);
    let response;
    try { response = await fetch(nextUrl, { headers: spec.headers, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('刷新失败，请检查连接后重试；原模型列表已保留。'); }
    if (!response.ok) throw new Error(`刷新失败（HTTP ${response.status}），原模型列表已保留。`);
    let body;
    try { body = await response.json(); } catch { throw new Error('模型列表不是 JSON，原列表已保留。'); }
    const rows = body.data || body.models;
    if (!Array.isArray(rows)) throw new Error('模型列表格式不正确，原列表已保留。');
    for (const row of rows) {
      const id = typeof row === 'string' ? row : row?.id || row?.name || row?.model;
      if (typeof id === 'string' && id.trim()) {
        const normalizedId = id.replace(/^models\//, '');
        const previous = Object.values(profile.synced_models || []).find(item => (typeof item === 'string' ? item : item?.id || item?.model) === normalizedId);
        const saved = config.discovered_models?.[normalizedId];
        const metadata = typeof row === 'object' ? Object.fromEntries(['family', 'provider', 'owned_by'].filter(key => typeof row[key] === 'string').map(key => [key, row[key]])) : {};
        rowsById.set(normalizedId, { ...(typeof previous === 'object' ? previous : {}), ...metadata, ...(metadata.family || metadata.provider || metadata.owned_by ? {} : saved?.family ? { family: saved.family } : {}), id: normalizedId });
      }
    }
    nextUrl = null;
    if (body.nextPageToken || body.has_more) {
      const url = new URL(spec.url);
      if (body.nextPageToken) url.searchParams.set('pageToken', body.nextPageToken);
      else if (rows.at(-1)?.id) url.searchParams.set('after', rows.at(-1).id);
      else throw new Error('模型分页缺少游标，原列表已保留。');
      nextUrl = url.href;
    }
  }
  if (!rowsById.size) throw new Error('站点返回空列表，原列表已保留；可修改连接或手动配置准确模型 ID。');
  const release = store.acquireConfigLock(configPath);
  try {
    const latest = store.loadConfigFromPath(configPath);
    if (revision(latest) !== expected) throw new Error('刷新期间配置已更新，请重试。');
    latest.profiles[profileName].synced_models = [...rowsById.values()];
    latest.profiles[profileName].models_synced_at = new Date().toISOString();
    latest.profiles[profileName].models_verification = 'list-authenticated';
    for (const value of Object.values(latest.profiles)) delete value.resolved_root_output_dir;
    store.writeJson(configPath, latest);
  } finally { release(); }
  return snapshot(profileName);
}
function render(name) {
  const data = snapshot(name);
  return require('./onboarding').renderModelForm({ ...data, mode: 'management', models: data.models.map(row => row.id) });
}
async function main() {
  const args = process.argv.slice(2);
  const profileIndex = args.indexOf('--profile');
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
  if (args[0] === '--render') return process.stdout.write(render(profile));
  if (args[0] === '--snapshot') return console.log(JSON.stringify(snapshot(profile)));
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const result = args[0] === '--apply' ? apply(input) : args[0] === '--refresh' ? await refresh(input) : null;
  if (!result) throw new Error('使用 --snapshot、--render、--apply 或 --refresh。');
  console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { snapshot, apply, refresh, render, resolveSelection, revision };
