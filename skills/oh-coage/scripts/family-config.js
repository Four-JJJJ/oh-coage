const { allBuiltinModels } = require('./providers');

const FAMILIES = ['openai', 'gemini', 'grok', 'other'];
const idOf = value => typeof value === 'string' ? value.trim() : String(value?.id || value?.model || '').trim();

function modelFamilyHint(id, profile, config) {
  const raw = idOf(id).toLowerCase();
  const catalogRows = [...(profile?.synced_models || []), ...(profile?.manual_models || []), ...Object.entries(config?.custom_models || {}).map(([key, value]) => typeof value === 'object' ? { key, ...value } : { key, model: value }), ...Object.values(config?.discovered_models || {})];
  const metadata = (typeof id === 'object' && id ? id : null) || catalogRows.find(entry => typeof entry === 'object' && idOf(entry).toLowerCase() === raw);
  // Compatible gateways may label every model's owner as OpenAI.
  const declared = String(metadata?.family || metadata?.provider || '').toLowerCase();
  if (/^(openai|chatgpt|azure[-_ ]?openai)$/.test(declared) || /(^|[._ -])openai($|[._ -])/.test(declared)) return 'openai';
  if (/^(gemini|google|vertex|google[-_ ]?ai)$/.test(declared) || /(^|[._ -])(gemini|google|vertex)($|[._ -])/.test(declared)) return 'gemini';
  if (/^(grok|xai|x[.]ai)$/.test(declared) || /(^|[._ -])(grok|xai|x[.]ai)($|[._ -])/.test(declared)) return 'grok';
  if (declared === 'other') return 'other';
  const builtin = allBuiltinModels().find(entry => [entry.key, entry.model].some(value => String(value).toLowerCase() === raw));
  if (builtin) return builtin.family;
  if (/gemini|banana|imagen/.test(raw)) return 'gemini';
  if (/grok/.test(raw)) return 'grok';
  if (/gpt|dall[-_]?e|chatgpt|openai/.test(raw)) return 'openai';
  if (metadata?.owned_by) return modelFamilyHint({ id: idOf(id), family: metadata.owned_by });
  return null;
}

function inferModelFamily(id, profile, config) {
  const raw = idOf(id).toLowerCase();
  for (const [family, group] of Object.entries(profile?.model_families || {})) {
    if (FAMILIES.includes(family) && [group?.primary, ...(group?.fallbacks || [])].some(value => idOf(value).toLowerCase() === raw)) return family;
  }
  return modelFamilyHint(id, profile, config) || 'other';
}

function normalizeFamilySelection(modelFamilies, activeFamily, { models, profile, config, apiStyle, allowMissingForInactive = false } = {}) {
  if (!modelFamilies || typeof modelFamilies !== 'object' || Array.isArray(modelFamilies)) throw new Error('请先按厂家选择模型。');
  const modelRows = Array.isArray(models) ? models : [];
  const available = modelRows.length ? new Set(modelRows.map(idOf)) : null;
  const rowsById = new Map(modelRows.map(row => [idOf(row), row]));
  const normalized = {};
  const seen = new Set();
  for (const [family, group] of Object.entries(modelFamilies)) {
    if (!FAMILIES.includes(family)) throw new Error(`不支持的厂家分组：${family}`);
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error(`${family} 的模型配置无效。`);
    const primary = idOf(group.primary);
    if (!primary) throw new Error(`请为 ${family} 选择主模型。`);
    if (group.fallbacks !== undefined && !Array.isArray(group.fallbacks)) throw new Error(`${family} 的备选模型必须是列表。`);
    const fallbacks = (group.fallbacks || []).map(idOf);
    if (fallbacks.length > 1) throw new Error(`${family} 最多选择一个备选模型。`);
    for (const [index, model] of [primary, ...fallbacks].entries()) {
      if (!model) throw new Error(`${family} 的备选模型不能为空。`);
      if (seen.has(model)) throw new Error(`模型 ${model} 重复，请只选择一次。`);
      seen.add(model);
      if (available && !available.has(model) && !(allowMissingForInactive && (family !== activeFamily || index > 0))) throw new Error(`模型 ${model} 不在当前站点列表，请刷新后重新选择。`);
      const declared = modelFamilyHint(rowsById.get(model) || model, profile, config);
      if (declared && declared !== family) throw new Error(`模型 ${model} 属于 ${declared}，请放入对应厂家分组。`);
    }
    normalized[family] = { primary, fallbacks };
  }
  const active = activeFamily || Object.keys(normalized)[0] || null;
  if (!active || !normalized[active]) throw new Error('请选择已配置主模型的默认厂家。');
  if ((apiStyle || profile?.api_style) === 'official' && active !== (profile?.family || 'openai')) throw new Error(`${active} 与当前官方接口不兼容，请为兼容厂家设置默认组或改用 OpenAI 兼容接口。`);
  return { modelFamilies: normalized, activeFamily: active };
}

function getFamilyConfig(profile = {}, config = {}) {
  if (profile.model_families && typeof profile.model_families === 'object') {
    const modelFamilies = {};
    for (const family of FAMILIES) {
      const group = profile.model_families[family];
      if (group) modelFamilies[family] = { primary: idOf(group.primary), fallbacks: (Array.isArray(group.fallbacks) ? group.fallbacks : []).map(idOf).filter(id => id && id !== idOf(group.primary)).slice(0, 1) };
    }
    return { modelFamilies, activeFamily: profile.active_model_family || Object.keys(modelFamilies)[0] || null };
  }
  const modelFamilies = {};
  const entries = [profile.model || config.current_model, ...(profile.fallback_models || [])].map(idOf).filter(Boolean);
  for (const model of entries) {
    const family = inferModelFamily(model, profile, config);
    const group = modelFamilies[family];
    if (!group) modelFamilies[family] = { primary: model, fallbacks: [] };
    else if (model !== group.primary && !group.fallbacks.length) group.fallbacks.push(model);
  }
  return { modelFamilies, activeFamily: entries.length ? inferModelFamily(entries[0], profile, config) : null };
}

module.exports = { FAMILIES, modelFamilyHint, inferModelFamily, getFamilyConfig, normalizeFamilySelection };
