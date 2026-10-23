const test = require('node:test');
const assert = require('node:assert/strict');
const { getFamilyConfig, inferModelFamily, normalizeFamilySelection } = require('../skills/oh-coage/scripts/family-config');

test('legacy mixed chain migrates read-only to per-manufacturer primary and fallbacks', () => {
  const profile = { model: 'banana-2.1', fallback_models: ['image-2', 'unlisted-art-model', 'gpt-image-2.5-flare', 'grok-imagine'] };
  const before = JSON.stringify(profile);
  const result = getFamilyConfig(profile);
  assert.equal(result.activeFamily, 'gemini');
  assert.deepEqual(result.modelFamilies.openai, { primary: 'image-2', fallbacks: ['gpt-image-2.5-flare'] });
  assert.equal(result.modelFamilies.other.primary, 'unlisted-art-model');
  assert.equal(result.modelFamilies.grok.primary, 'grok-imagine');
  assert.equal(JSON.stringify(profile), before);
});

test('unknown IDs are other regardless of profile protocol identity', () => {
  assert.equal(inferModelFamily('flux-custom', { family: 'openai' }), 'other');
  assert.equal(inferModelFamily('gemini-3.1-flash'), 'gemini');
});

test('generic gateway ownership cannot override recognizable vendor IDs, while explicit family metadata can', () => {
  for (const [id, family] of [['gemini-banana-2.1-lite', 'gemini'], ['grok-image-2-lite', 'grok'], ['gpt-image-2-pro', 'openai']]) {
    assert.equal(inferModelFamily({ id, owned_by: 'openai' }), family);
  }
  assert.equal(inferModelFamily({ id: 'custom-render', owned_by: 'Google' }), 'gemini');
  assert.equal(inferModelFamily({ id: 'gemini-custom-alias', family: 'grok', owned_by: 'openai' }), 'grok');
});

test('selection requires primary and active group and rejects duplicate or wrong-family IDs', () => {
  const openai = { primary: 'gpt-image-2', fallbacks: [] };
  assert.deepEqual(normalizeFamilySelection({ openai }, 'openai').modelFamilies.openai, openai);
  assert.throws(() => normalizeFamilySelection({ openai: { primary: '', fallbacks: [] } }, 'openai'), /主模型/);
  assert.throws(() => normalizeFamilySelection({ openai }, 'gemini'), /默认厂家/);
  assert.throws(() => normalizeFamilySelection({ openai: { ...openai, fallbacks: ['gpt-image-2'] } }, 'openai'), /重复/);
  assert.throws(() => normalizeFamilySelection({ openai: { primary: 'gemini-3' } }, 'openai'), /属于 gemini/);
  assert.throws(() => normalizeFamilySelection({ openai }, 'openai', { models: ['gpt-image-3'] }), /站点列表/);
});

test('official profile rejects incompatible manufacturer groups before save', () => {
  assert.throws(() => normalizeFamilySelection({ openai: { primary: 'gpt-image-2', fallbacks: [] }, gemini: { primary: 'gemini-3', fallbacks: [] } }, 'gemini', { profile: { family: 'openai', api_style: 'official' } }), /官方接口不兼容/);
  assert.doesNotThrow(() => normalizeFamilySelection({ openai: { primary: 'gpt-image-2', fallbacks: [] }, gemini: { primary: 'gemini-3', fallbacks: [] } }, 'openai', { profile: { family: 'openai', api_style: 'official' } }));
});

test('new selections reject multiple backups and legacy reads expose just one without rewriting the source', () => {
  assert.throws(() => normalizeFamilySelection({openai:{primary:'gpt-image-a',fallbacks:['gpt-image-b','gpt-image-c']}},'openai'), /最多选择一个/);
  const profile={model_families:{openai:{primary:'gpt-image-a',fallbacks:['gpt-image-b','gpt-image-c']}},active_model_family:'openai'};
  const before=JSON.stringify(profile);
  assert.deepEqual(getFamilyConfig(profile).modelFamilies.openai.fallbacks,['gpt-image-b']);
  assert.equal(JSON.stringify(profile),before);
});
