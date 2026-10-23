const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const assets = path.resolve(__dirname, '../skills/oh-coage/assets');
test('two onboarding templates parse and never persist or request credentials in-browser', () => {
  for (const name of ['oh-coage-init-form.html', 'oh-coage-model-form.html']) {
    const source = fs.readFileSync(path.join(assets, name), 'utf8');
    new vm.Script(source.match(/<script>([\s\S]*?)<\/script>/)[1]);
    assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\s*\(|setWidgetState/);
  }
  const first = fs.readFileSync(path.join(assets, 'oh-coage-init-form.html'), 'utf8');
  assert.doesNotMatch(first, /name="model"|name="fallbackModels"/);
  assert.doesNotMatch(first, /name="family"|模型族/);
  assert.match(first, /type="password"/);
  assert.match(first, /OH_COAGE_CONNECTION_SUBMISSION/);
});

function connectionForm(data) {
  const elements = Object.fromEntries(['profile', 'baseUrl', 'apiKey', 'outputDir', 'api', 'officialFamily', 'manualModelIds'].map(name => [name, {
    value: name === 'api' ? 'openai' : '', handlers: {}, required: ['profile', 'baseUrl', 'apiKey'].includes(name),
    addEventListener(event, handler) { this.handlers[event] = handler; },
  }]));
  const status = {}, button = {}, handlers = {}, messages = [];
  const form = { elements, reportValidity: () => Object.values(elements).every(field => !field.required || field.value), querySelector: selector => selector === 'button' ? button : status, addEventListener(event, handler) { handlers[event] = handler; } };
  const familyLabel = {}, cancel = { addEventListener() {} };
  const source = fs.readFileSync(path.join(assets, 'oh-coage-init-form.html'), 'utf8').replace('/*CONNECTION_DATA*/null', JSON.stringify(data));
  vm.runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: id => id === 'oh-coage-init-form' ? { querySelector: () => form } : id === 'oh-coage-official-family' ? familyLabel : cancel },
    window: { openai: { sendFollowUpMessage: async message => messages.push(message) } },
    FormData: function (target) { return Object.entries(target.elements).map(([name, field]) => [name, field.value]); },
  });
  return { elements, familyLabel, messages, submit: () => handlers.submit({ preventDefault() {} }) };
}

test('connection form defaults to OpenAI format and sends native identity only after an explicit protocol choice', async () => {
  const form = connectionForm({ profile: 'test', baseUrl: 'https://example.com/v1', api: 'openai' });
  assert.equal(form.elements.api.value, 'openai');
  assert.equal(form.familyLabel.hidden, true);
  assert.equal(form.elements.officialFamily.required, false);
  form.elements.apiKey.value = 'fake-test-key';
  form.elements.officialFamily.value = 'gemini';
  await form.submit();
  const compatible = JSON.parse(form.messages[0].prompt.split('\n')[1]);
  assert.equal(compatible.api, 'openai');
  assert.equal(compatible.family, undefined);
  assert.equal(compatible.officialFamily, undefined);

  form.elements.api.value = 'official';
  form.elements.api.handlers.change();
  assert.equal(form.familyLabel.hidden, false);
  assert.equal(form.elements.officialFamily.required, true);
  form.elements.apiKey.value = 'fake-test-key';
  form.elements.officialFamily.value = '';
  await form.submit();
  assert.equal(form.messages.length, 1, 'native protocol requires a connection identity');
  form.elements.officialFamily.value = 'gemini';
  await form.submit();
  const native = JSON.parse(form.messages[1].prompt.split('\n')[1]);
  assert.equal(native.api, 'official');
  assert.equal(native.family, 'gemini');

  form.elements.api.value = 'openai';
  form.elements.api.handlers.change();
  form.elements.apiKey.value = 'fake-test-key';
  await form.submit();
  const reverted = JSON.parse(form.messages[2].prompt.split('\n')[1]);
  assert.equal(reverted.api, 'openai');
  assert.equal(reverted.family, undefined, 'switching back must not leak a dormant native identity');
});

test('editing a native connection preloads its protocol and identity without prefilling a key', () => {
  const form = connectionForm({ profile: 'test', editProfile: 'test', baseUrl: 'https://example.com/v1', api: 'official', profileFamily: 'grok' });
  assert.equal(form.elements.api.value, 'official');
  assert.equal(form.elements.officialFamily.value, 'grok');
  assert.equal(form.familyLabel.hidden, false);
  assert.equal(form.elements.apiKey.value, '');
  assert.equal(form.elements.apiKey.required, false);
});

function modelForm(data, fail = false) {
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.value = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(event, handler) { this.handlers[event] = handler; }
  }
  const status = new Element(), submit = new Element(), scope = { value: 'default' };
  const form = new Element(); form.reportValidity = () => true;
  form.querySelector = selector => selector.includes('status') ? status : selector.includes('selectionScope') ? scope : submit;
  const ids = ['oh-coage-model-summary','oh-coage-model-heading','oh-coage-model-intro','oh-coage-family-groups','oh-coage-active-family','oh-coage-active-label','oh-coage-selection-scope','oh-coage-more','oh-coage-back','oh-coage-refresh','oh-coage-profiles','oh-coage-cancel'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements['oh-coage-model-form'] = { querySelector: () => form };
  const messages = [];
  const source = fs.readFileSync(path.join(assets, 'oh-coage-model-form.html'), 'utf8').replace('/*ONBOARDING_DATA*/null', JSON.stringify(data));
  vm.runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: id => elements[id], createElement: () => new Element() },
    window: { confirm: () => true, openai: { sendFollowUpMessage: async message => { if (fail) throw new Error('bridge'); messages.push(message); } } },
  });
  const selectors = family => {
    const group = elements['oh-coage-family-groups'].children.find(section => section.children[0].textContent === family);
    return group?.children[1].children.map(label => label.children[0]);
  };
  const choose = (control, value) => { control.value = value; control.handlers.change(); };
  return { elements, status, submit, scope, messages, selectors, choose, send: () => form.handlers.submit({ preventDefault() {} }) };
}
const simpleData = { draftId:'draft',profile:'test',models:['gpt-image-a','gpt-image-b','gpt-image-c','gemini-a','custom-a'],modelFamilyTags:{'gpt-image-a':'openai','gpt-image-b':'openai','gpt-image-c':'openai','gemini-a':'gemini'},modelFamilies:{},apiStyle:'openai' };

test('dropdown form uses one primary and optional backup, clearing collisions without extra controls', async () => {
  const view = modelForm(simpleData);
  const [primary, backup] = view.selectors('OpenAI');
  assert.equal(backup.disabled, true);
  assert.equal(view.selectors('Grok'), undefined);
  assert.equal(view.elements['oh-coage-active-label'].hidden, true);
  await view.send(); assert.equal(view.messages.length, 0);
  view.choose(primary, 'gpt-image-a');
  view.choose(backup, 'gpt-image-b');
  view.choose(backup, 'gpt-image-c');
  await view.send();
  assert.deepEqual(JSON.parse(view.messages[0].prompt.split('\n')[1]), { draftId:'draft',modelFamilies:{openai:{primary:'gpt-image-a',fallbacks:['gpt-image-c']}},activeFamily:'openai' });
  assert.equal(backup.children.find(option => option.value === 'gpt-image-a').disabled, true);
  view.choose(primary, 'gpt-image-c'); assert.equal(backup.value, '');
  view.choose(backup, 'gpt-image-b');
  view.choose(primary, ''); assert.equal(backup.value, ''); assert.equal(backup.disabled, true);
  view.choose(primary, 'gpt-image-a');
  view.choose(view.selectors('Gemini')[0], 'gemini-a');
  assert.equal(view.elements['oh-coage-active-label'].hidden, false);
  view.choose(view.elements['oh-coage-active-family'], 'gemini');
  await view.send(); assert.equal(JSON.parse(view.messages[1].prompt.split('\n')[1]).activeFamily, 'gemini');
  const source=fs.readFileSync(path.join(assets, 'oh-coage-model-form.html'), 'utf8');
  assert.doesNotMatch(source, /type="checkbox"|type="search"|置顶|上移|下移|清空/);
});

test('native management keeps other manufacturers dormant and temporary scope uses only the main model', async () => {
  const view = modelForm({ ...simpleData,mode:'management',revision:'rev',apiStyle:'official',profileFamily:'openai',activeFamily:'openai',modelFamilies:{openai:{primary:'gpt-image-a',fallbacks:['gpt-image-b']},gemini:{primary:'gemini-old',fallbacks:['gemini-old-backup']}},missingModels:['gemini-old','gemini-old-backup'] });
  assert.equal(view.selectors('Gemini'), undefined);
  await view.send();
  assert.deepEqual(JSON.parse(view.messages[0].prompt.split('\n')[1]).modelFamilies.gemini, {primary:'gemini-old',fallbacks:['gemini-old-backup']});
  view.scope.value='temporary'; await view.send();
  assert.deepEqual(JSON.parse(view.messages[1].prompt.split('\n')[1]).modelFamilies, {openai:{primary:'gpt-image-a',fallbacks:[]}});
});

test('missing selections cannot save, legacy backup lists display only the first, and bridge failures remain retryable', async () => {
  const data={ ...simpleData,activeFamily:'openai',modelFamilies:{openai:{primary:'gone',fallbacks:['gpt-image-b','gpt-image-c']}},missingModels:['gone'] };
  const view=modelForm(data); const [primary,backup]=view.selectors('OpenAI');
  assert.equal(backup.value,'gpt-image-b');
  await view.send(); assert.match(view.status.textContent,/不在列表/); assert.equal(view.messages.length,0);
  view.choose(primary,'gpt-image-a'); await view.send();
  assert.deepEqual(JSON.parse(view.messages[0].prompt.split('\n')[1]).modelFamilies.openai.fallbacks,['gpt-image-b']);
  const failed=modelForm({...simpleData,activeFamily:'openai',modelFamilies:{openai:{primary:'gpt-image-a',fallbacks:[]}}},true);
  await failed.send(); assert.equal(failed.submit.disabled,false); assert.match(failed.status.textContent,/重试/);
});
