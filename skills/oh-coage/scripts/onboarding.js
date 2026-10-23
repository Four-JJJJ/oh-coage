#!/usr/bin/env node
// Two-step onboarding. Credentials stay in Keychain between host-rendered forms.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./config-store');
const { resolveModel } = require('./models');
const { getFamilyConfig, normalizeFamilySelection, inferModelFamily } = require('./family-config');
const { resolveDefaultOutputDir } = require('./resolve-output-dir');
const { buildModelListRequest, normalizeFamily, normalizeApiStyle } = require('./providers');

const draftsDir = path.join(store.APP_DIR, 'onboarding');
function draftPath(id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('初始化会话无效，请重新验证站点。');
  return path.join(draftsDir, `${id}.json`);
}
function revision(configPath) {
  return configPath && fs.existsSync(configPath) ? crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex') : null;
}
function writeDraft(draft) { store.writeJson(draftPath(draft.id), draft); fs.chmodSync(draftPath(draft.id), 0o600); }
function readDraft(id) {
  const draft = JSON.parse(fs.readFileSync(draftPath(id), 'utf8'));
  if (draft.status === 'cancelled') throw new Error('这次设置已取消，请重新打开设置。');
  if (draft.status !== 'complete' && Date.now() - draft.verifiedAt > 24 * 60 * 60 * 1000) throw new Error('验证已超过 24 小时，请重新验证站点。');
  return draft;
}
function inferFamily(id) {
  if (/gemini|banana|imagen/i.test(id)) return 'gemini';
  if (/grok/i.test(id)) return 'grok';
  if (/gpt-image|dall-e|chatgpt-image/i.test(id)) return 'openai';
  return null;
}
function familyFromMetadata(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (/^(openai|chatgpt|azure[-_ ]?openai)$/.test(raw) || /(^|[._ -])openai($|[._ -])/.test(raw)) return 'openai';
  if (/^(gemini|google|vertex|google[-_ ]?ai)$/.test(raw) || /(^|[._ -])(gemini|google|vertex)($|[._ -])/.test(raw)) return 'gemini';
  if (/^(grok|xai|x[.]ai)$/.test(raw) || /(^|[._ -])(grok|xai|x[.]ai)($|[._ -])/.test(raw)) return 'grok';
  if (raw === 'other') return 'other';
  return null;
}
function catalogEntry(row) {
  const id = typeof row === 'string' ? row : row?.id || row?.name || row?.model;
  if (typeof id !== 'string' || !id.trim()) return null;
  const entry = { id: id.replace(/^models\//, '') };
  if (row && typeof row === 'object') {
    for (const key of ['family', 'provider', 'owned_by']) {
      if (typeof row[key] === 'string' && row[key].trim()) entry[key] = row[key].trim();
    }
  }
  const declared = familyFromMetadata(entry.family) || familyFromMetadata(entry.provider);
  const inferred = inferFamily(entry.id);
  const owner = familyFromMetadata(entry.owned_by);
  if (declared) { entry.family = declared; entry.familySource = 'metadata'; }
  else if (inferred) { entry.family = inferred; entry.familySource = 'id'; }
  else if (owner) { entry.family = owner; entry.familySource = 'metadata'; }
  else { delete entry.family; entry.familySource = 'unknown'; }
  return entry;
}
function draftFamilyMetadata(draft, familyTags = {}) {
  const metadata = { ...(draft.modelMetadata || {}) };
  const permitted = new Set([...draft.models, ...Object.values(draft.modelFamilies || {}).flatMap(group => [group.primary, ...group.fallbacks])]);
  for (const [id, family] of Object.entries(familyTags || {})) {
    if (!permitted.has(id) || !['openai', 'gemini', 'grok', 'other'].includes(family)) throw new Error(`模型 ${id} 的厂家标记无效，请重新选择。`);
    metadata[id] = { ...(metadata[id] || {}), id, family, familySource: 'user' };
  }
  return metadata;
}
async function verify(input, editing = false) {
  const editProfile = input.editProfile;
  const profile = String(editProfile || input.profile || '').trim();
  if (!profile || profile.length > 64 || /[\x00-\x1f\x7f/\\]/.test(profile) || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(profile)) throw new Error('配置名称长度需为 1-64，不能包含路径分隔符、控制字符或保留名称。');
  const { config, configPath: activePath } = store.loadActiveConfig();
  const initialRevision = activePath ? revision(activePath) : null;
  const existingProfile = config?.profiles?.[profile];
  if ((editing || editProfile) && !existingProfile) throw new Error('配置不存在，请先选择已有配置。');
  if (!editing && !editProfile && existingProfile) throw new Error('配置名称已存在，请换一个名称，避免覆盖已有配置。');
  const baseUrl = store.normalizeBaseUrl(String(input.baseUrl || (editProfile && existingProfile.base_url) || '').trim());
  store.assertValidBaseUrl(baseUrl);
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('站点 URL 不得包含凭据、查询参数或片段。');
  const explicitKey = String(input.apiKey || '').trim();
  if (editProfile && baseUrl !== store.normalizeBaseUrl(existingProfile.base_url) && !explicitKey) throw new Error('服务地址已更改，请重新填写该服务的 API Key；不会将原密钥发送到新地址。');
  const apiKey = explicitKey || String((editProfile && store.readKeychainSecret(existingProfile.keychain_account)) || '').trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('请填写有效的 API Key。');
  if (input.api === 'official' && !input.family && !editProfile) throw new Error('请在更多设置中选择官方接口对应厂家。');
  const family = normalizeFamily(input.family || (editProfile && existingProfile.family) || 'openai');
  const api = normalizeApiStyle(input.api || (editProfile && existingProfile.api_style) || 'openai', family);
  const spec = buildModelListRequest({ family, apiStyle: api, baseUrl, apiKey });
  const manualModels = input.manualModels;
  if (manualModels !== undefined && (!Array.isArray(manualModels) || !manualModels.length || manualModels.some(id => typeof id !== 'string' || !id.trim() || /[\x00-\x1f]/.test(id)) || new Set(manualModels).size !== manualModels.length)) throw new Error('请提供不重复的准确模型 ID。');
  let unverified = false;
  const models = new Map();
  const modelMetadata = {};
  const seenPages = new Set();
  let nextUrl = spec.url;
  for (let page = 0; nextUrl; page++) {
    if (page >= 100 || seenPages.has(nextUrl)) throw new Error('模型列表分页异常，请检查站点接口。');
    seenPages.add(nextUrl);
    let response;
    try {
      response = await fetch(nextUrl, { headers: spec.headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch {
      throw new Error('无法连接站点或请求超时，请检查 URL 和网络后重试。');
    }
    if ([404, 405, 501].includes(response.status) && page === 0 && manualModels) {
      manualModels.forEach(id => { models.set(id, id); modelMetadata[id] = catalogEntry(id); }); unverified = true; break;
    }
    if (!response.ok) throw new Error(`站点验证失败（HTTP ${response.status}），请检查 URL、Key 和模型列表权限。`);
    let payload;
    try { payload = await response.json(); } catch {
      if (page === 0 && manualModels) { manualModels.forEach(id => { models.set(id, id); modelMetadata[id] = catalogEntry(id); }); unverified = true; break; }
      throw new Error('模型列表返回的不是 JSON，请检查地址，或使用服务商提供的准确模型 ID 手动配置。');
    }
    const rows = payload.data || payload.models;
    if (!Array.isArray(rows)) {
      if (page === 0 && manualModels) { manualModels.forEach(id => { models.set(id, id); modelMetadata[id] = catalogEntry(id); }); unverified = true; break; }
      throw new Error('站点没有返回有效的模型列表。');
    }
    for (const row of rows) {
      const entry = catalogEntry(row);
      if (entry) { models.set(entry.id, entry.id); modelMetadata[entry.id] = entry; }
    }
    nextUrl = null;
    if (payload.nextPageToken) {
      const next = new URL(spec.url);
      next.searchParams.set('pageToken', payload.nextPageToken);
      nextUrl = next.href;
    } else if (payload.has_more === true) {
      const last = rows.at(-1);
      if (!last?.id) throw new Error('模型列表分页缺少游标。');
      const next = new URL(spec.url);
      next.searchParams.set('after', last.id);
      nextUrl = next.href;
    }
  }
  if (!models.size && manualModels) { manualModels.forEach(id => { models.set(id, id); modelMetadata[id] = catalogEntry(id); }); unverified = true; }
  if (!models.size) throw new Error('站点返回的模型列表为空，请检查 Key 权限或站点配置。');
  const id = crypto.randomBytes(16).toString('hex');
  const account = `onboarding:${id}`;
  const outputDir = input.outputDir ? path.resolve(input.outputDir) : editProfile ? existingProfile.resolved_root_output_dir || existingProfile.root_output_dir : resolveDefaultOutputDir();
  const configPath = activePath || store.getDefaultConfigPath(outputDir);
  const familySelection = (editing || editProfile) ? getFamilyConfig(existingProfile, config) : { modelFamilies: {}, activeFamily: null };
  for (const group of Object.values(familySelection.modelFamilies)) {
    const exact = key => { try { return resolveModel(key, config, null, true).model; } catch { return key; } };
    group.primary = exact(group.primary); group.fallbacks = group.fallbacks.map(exact);
  }
  const selectedModels = (editing || editProfile) ? [existingProfile.model, ...(existingProfile.fallback_models || [])].filter(Boolean).map(key => { try { return resolveModel(key, config, null, true).model; } catch { return key; } }) : [];
  const allSelected = Object.values(familySelection.modelFamilies).flatMap(group => [group.primary, ...group.fallbacks]);
  if (editing || editProfile) {
    for (const id of models.keys()) {
      const saved = config.discovered_models?.[id];
      if (!modelMetadata[id]?.family && saved?.family) modelMetadata[id] = { ...modelMetadata[id], family: saved.family, familySource: saved.family_source || 'metadata' };
    }
    for (const [savedFamily, group] of Object.entries(familySelection.modelFamilies)) {
      for (const model of [group.primary, ...group.fallbacks]) {
        if (!modelMetadata[model]?.family) modelMetadata[model] = { id: model, family: savedFamily, familySource: 'saved-selection' };
      }
    }
  }
  const modelFamilyTags = Object.fromEntries(Object.entries(modelMetadata).filter(([, row]) => row.family).map(([id, row]) => [id, row.family]));
  const draft = { ...familySelection, id, profile, baseUrl, family, api, account, outputDir, models: [...models.keys()], modelMetadata, modelFamilyTags, selectedModels, missingModels: allSelected.filter(id => !models.has(id)), unverified, editing: Boolean(editing || editProfile), editConnection: Boolean(editProfile), configPath, configRevision: activePath ? initialRevision : revision(configPath), verifiedAt: Date.now() };
  fs.mkdirSync(draftsDir, { recursive: true, mode: 0o700 });
  try { store.saveKeychainSecret(account, apiKey); writeDraft(draft); }
  catch (error) { try { store.deleteKeychainSecret(account); } catch {} throw error; }
  return { draftId: id, profile, models: draft.models, modelMetadata, modelFamilyTags, unknownModels: draft.models.filter(model => !modelFamilyTags[model]), missingModels: draft.missingModels, ...familySelection, selectedModels, status: unverified ? 'unverified' : 'verified', verification: unverified ? '手动模型配置；连接鉴权和出图能力均未验证' : '模型列表接口鉴权通过；未验证模型出图能力' };
}
function complete(input) {
  const release = store.acquireConfigLock(draftPath(input.draftId));
  try { return completeLocked(input); } finally { release(); }
}
function completeLocked(input) {
  const draft = readDraft(input.draftId);
  let modelFamilies = input.modelFamilies;
  let activeFamily = input.activeFamily;
  if (modelFamilies === undefined) {
    if (!Array.isArray(input.fallbackModels) || typeof input.model !== 'string' || !input.model) throw new Error('请至少为一个厂家选择主要模型。');
    if (new Set([input.model, ...input.fallbackModels]).size !== input.fallbackModels.length + 1) throw new Error('模型不能重复。');
    const catalog = draftFamilyMetadata(draft);
    const counts = {};
    for (const id of [input.model, ...input.fallbackModels]) {
      const family = catalog[id]?.family || inferFamily(id) || 'other';
      counts[family] = (counts[family] || 0) + 1;
      if (counts[family] > 2) throw new Error(`${family} 最多选择一个备选模型。`);
    }
    const migrated = getFamilyConfig({ model: input.model, fallback_models: input.fallbackModels, synced_models: draft.models.map(id => ({ id, family: catalog[id]?.family })) }, {});
    modelFamilies = migrated.modelFamilies; activeFamily = migrated.activeFamily;
  }
  const modelMetadata = draftFamilyMetadata(draft, input.modelFamilyTags);
  const catalogProfile = { family: draft.family, synced_models: Object.entries(modelMetadata).map(([id, row]) => ({ ...row, id })) };
  const existingConfig = draft.editing ? store.loadConfigFromPath(draft.configPath) : {};
  const savedProfile = existingConfig?.profiles?.[draft.profile];
  const normalized = normalizeFamilySelection(modelFamilies, activeFamily, { models: draft.models, profile: catalogProfile, config: existingConfig, apiStyle: draft.api, allowMissingForInactive: Boolean(savedProfile) });
  modelFamilies = normalized.modelFamilies; activeFamily = normalized.activeFamily;
  const selected = Object.values(modelFamilies).flatMap(group => [group.primary, ...group.fallbacks]);
  const signature = JSON.stringify({ modelFamilies, activeFamily });
  if (draft.status === 'complete') {
    if (signature !== draft.selectionSignature) throw new Error('这次设置已经保存，请重新打开模型管理后修改。');
    return { ...draft.result, repeated: true };
  }
  const primary = modelFamilies[activeFamily].primary;
  const fallbacks = modelFamilies[activeFamily].fallbacks;
  const { config: existing, configPath: existingPath } = store.loadActiveConfig();
  const configPath = draft.configPath;
  if ((existingPath && existingPath !== configPath) || revision(configPath) !== draft.configRevision) throw new Error('配置已在其他会话更新，请重新打开设置后再保存。');
  const config = existing || { version: 1, profiles: {} };
  if (!draft.editing && config.profiles[draft.profile]) throw new Error('配置名称已存在，请重新验证并使用其他名称。');
  if (draft.editing && !config.profiles[draft.profile]) throw new Error('此配置已删除，请重新选择配置。');
  if (!existing && fs.existsSync(configPath)) throw new Error('保存目录已有配置文件，请先确认已有配置或改用其他目录。');
  const oldAccount = draft.editing ? config.profiles[draft.profile].keychain_account : null;
  const account = draft.editConnection ? `${store.buildKeychainAccount(draft.profile, configPath)}:connection:${draft.id}` : oldAccount || store.buildKeychainAccount(draft.profile, configPath);
  const now = new Date().toISOString();
  config.discovered_models ||= {};
  for (const model of selected) {
    const metadata = modelMetadata[model] || {};
    config.discovered_models[model] = { ...metadata, model, ...(metadata.family ? { family: metadata.family } : {}), family_source: metadata.familySource || (inferFamily(model) ? 'id' : 'unknown'), source_profile: draft.profile };
  }
  if (draft.editing) {
    Object.assign(config.profiles[draft.profile], draft.editConnection ? { keychain_account: account, base_url: draft.baseUrl, root_output_dir: draft.outputDir, family: draft.family, api_style: draft.api } : {}, { model: primary, fallback_models: fallbacks, synced_models: draft.models.map(id => ({ ...(modelMetadata[id] || { id }), id })), models_synced_at: new Date(draft.verifiedAt).toISOString(), updated_at: now });
  } else {
    config.profiles[draft.profile] = { base_url: draft.baseUrl, root_output_dir: draft.outputDir, keychain_account: account, family: draft.family, api_style: draft.api, model: primary, fallback_models: fallbacks, synced_models: draft.models.map(id => ({ ...(modelMetadata[id] || { id }), id })), models_synced_at: new Date(draft.verifiedAt).toISOString(), updated_at: now };
    config.active_profile = draft.profile;
  }
  config.profiles[draft.profile].model_families = modelFamilies;
  config.profiles[draft.profile].active_model_family = activeFamily;
  config.profiles[draft.profile].models_verification = draft.unverified ? 'manual-unverified' : 'list-authenticated';
  config.updated_at = now;
  const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const previousState = fs.existsSync(store.STATE_PATH) ? fs.readFileSync(store.STATE_PATH) : null;
  let secretSaved = false, configSaved = false, savedRevision;
  const result = { status: 'complete', profile: draft.profile, model: primary, fallbackModels: fallbacks, modelFamilies, activeFamily, outputDir: draft.outputDir, configPath, verification: config.profiles[draft.profile].models_verification };
  try {
    if (!draft.editing || draft.editConnection) { store.saveKeychainSecret(account, store.readKeychainSecret(draft.account)); secretSaved = true; }
    store.saveConfig(configPath, config, { sha256: draft.configRevision });
    configSaved = true; savedRevision = config._loadedRevision;
    if (!existingPath) store.saveState({ ...store.loadState(), config_path: configPath });
    writeDraft({ ...draft, status: 'complete', selectionSignature: signature, result });
  } catch (error) {
    // Only roll back our own persisted version; never overwrite a concurrent edit.
    if (configSaved) {
      const unlock = store.acquireConfigLock(configPath);
      try {
        if (revision(configPath) === savedRevision) {
          if (previousConfig) fs.writeFileSync(configPath, previousConfig); else fs.unlinkSync(configPath);
          if (!existingPath) {
            if (previousState) fs.writeFileSync(store.STATE_PATH, previousState); else fs.rmSync(store.STATE_PATH, { force: true });
          }
        }
      } catch {} finally { unlock(); }
    }
    if (secretSaved) {
      try {
        const persisted = store.loadConfigFromPath(configPath);
        if (!Object.values(persisted?.profiles || {}).some(profile => profile.keychain_account === account)) store.deleteKeychainSecret(account);
      } catch {}
    }
    throw error;
  }

  try {
    store.deleteKeychainSecret(draft.account);
    if (draft.editConnection && oldAccount && !Object.values(config.profiles).some(profile => profile.keychain_account === oldAccount)) store.deleteKeychainSecret(oldAccount);
  }
  catch { result.cleanupWarning = '设置已保存，临时凭据清理失败；可使用取消命令重试清理。'; }
  return result;
}
async function editModels(input) {
  const { config } = store.loadActiveConfig();
  const profile = input.profile || config?.active_profile;
  const saved = config?.profiles?.[profile];
  if (!saved) throw new Error('请先选择已有配置。');
  return verify({ ...input, profile, baseUrl: saved.base_url, apiKey: store.readKeychainSecret(saved.keychain_account), family: saved.family, api: saved.api_style, outputDir: saved.resolved_root_output_dir || saved.root_output_dir }, true);
}
function cancel(id) {
  const release = store.acquireConfigLock(draftPath(id));
  try {
    const draft = JSON.parse(fs.readFileSync(draftPath(id), 'utf8'));
    store.deleteKeychainSecret(draft.account);
    if (draft.status !== 'complete') { draft.status = 'cancelled'; writeDraft(draft); }
    return { status: draft.status === 'complete' ? 'complete' : 'cancelled', profile: draft.profile };
  } finally { release(); }
}
function renderModels(id) {
  const draft = readDraft(id);
  if (draft.status === 'complete') throw new Error('这次设置已保存，请重新打开模型管理。');
  return renderModelForm({ draftId: id, profile: draft.profile, models: [...draft.models, ...(draft.missingModels || [])], modelMetadata: draft.modelMetadata || {}, modelFamilyTags: draft.modelFamilyTags || {}, unknownModels: draft.models.filter(model => !(draft.modelFamilyTags || {})[model]), selectedModels: draft.selectedModels || [], missingModels: draft.missingModels || [], unverified: draft.unverified, editing: draft.editing, apiStyle: draft.api, profileFamily: draft.family, modelFamilies: draft.modelFamilies || {}, activeFamily: draft.activeFamily });
}
function renderModelForm(input) {
  const source = fs.readFileSync(path.join(__dirname, '../assets/oh-coage-model-form.html'), 'utf8');
  const modelFamilyTags = { ...(input.modelFamilyTags || (input.modelGroups
    ? Object.fromEntries(Object.entries(input.modelGroups).flatMap(([family, ids]) => ids.map(id => [id, family])))
    : Object.fromEntries(input.models.map(id => [id, inferModelFamily(id, input.profileMetadata, input.config)]).filter(([, family]) => family)))) };
  for (const [family, group] of Object.entries(input.modelFamilies || {})) {
    for (const id of [group.primary, ...(group.fallbacks || [])]) if (id && !modelFamilyTags[id]) modelFamilyTags[id] = family;
  }
  const data = JSON.stringify({ ...input, modelFamilyTags, unknownModels: input.unknownModels || input.models.filter(id => !modelFamilyTags[id]), modelGroups: input.modelGroups || Object.fromEntries(['openai', 'gemini', 'grok', 'other'].map(family => [family, input.models.filter(id => modelFamilyTags[id] === family)])) }).replace(/</g, '\\u003c');
  return source.replace('/*ONBOARDING_DATA*/null', data);
}
function renderConnection(input = {}) {
  const { config } = store.loadActiveConfig();
  const editProfile = input.editProfile;
  const saved = editProfile ? config?.profiles?.[editProfile] : null;
  if (editProfile && !saved) throw new Error('请先选择已有配置。');
  const data = { profile: editProfile || input.profile || '', baseUrl: input.baseUrl || saved?.base_url || '', outputDir: input.outputDir || saved?.resolved_root_output_dir || saved?.root_output_dir || resolveDefaultOutputDir(), api: input.api || saved?.api_style || 'openai', profileFamily: input.family ? normalizeFamily(input.family) : saved?.family || null, editProfile: editProfile || null };
  const source = fs.readFileSync(path.join(__dirname, '../assets/oh-coage-init-form.html'), 'utf8');
  return source.replace('/*CONNECTION_DATA*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
}
async function main() {
  const command = process.argv[2];
  if (command === '--cancel') return console.log(JSON.stringify(cancel(process.argv[3])));
  if (command === '--render-models') return process.stdout.write(renderModels(process.argv[3]));
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (command === '--render-connection') return process.stdout.write(renderConnection(input));
  const result = command === '--verify' ? await verify(input) : command === '--complete' ? complete(input) : command === '--edit-models' ? await editModels(input) : null;
  if (!result) throw new Error('使用 --verify、--complete、--edit-models、--cancel 或 --render-models。');
  console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verify, complete, renderModels, inferFamily, editModels, cancel, renderConnection, renderModelForm };
