const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const formPath = path.resolve(__dirname, '../skills/oh-coage/assets/oh-coage-init-form.html');

test('initialization form contains the required fields and follow-up bridge', () => {
  const source = fs.readFileSync(formPath, 'utf8');

  for (const field of ['outputDir', 'profile', 'baseUrl', 'apiKey', 'model', 'family', 'api']) {
    assert.match(source, new RegExp(`name="${field}"`));
  }

  assert.match(source, /type="password"/);
  assert.match(source, /name="outputDir"/);
  assert.match(source, /<select[^>]*name="model"/);
  assert.match(source, /<select[^>]*name="family"/);
  assert.match(source, /<select[^>]*name="api"/);
  assert.match(source, /value="openai" selected/, '接口协议默认必须是 OpenAI 兼容');
  assert.match(source, /image-2\.5-sunburst/);
  assert.match(source, /image-2\.5-flare/);
  assert.match(source, /banana-2\.1/);
  assert.match(source, /grok-imagine-2/);
  assert.match(source, /初始化 oh-coage/);
  assert.match(source, /gap: 8px/);
  assert.match(source, /gap: 20px/);
  assert.match(source, /oh-coage-project-option/);
  assert.match(source, /data-has-project="false"/);
  assert.doesNotMatch(source, /OH_COAGE_PICK_OUTPUT_DIR|choose-output-dir/);
  assert.match(source, /window\.openai\?\.sendFollowUpMessage/);
  assert.match(source, /OH_COAGE_INIT_FORM_SUBMISSION/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\s*\(/);
});
