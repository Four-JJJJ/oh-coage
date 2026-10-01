const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const skillDir = path.join(repoRoot, 'skills', 'oh-coage');
const skillDocPath = path.join(skillDir, 'SKILL.md');
const entryDocPath = path.join(repoRoot, 'SKILL.md');

test('the skill is self-contained: SKILL.md, scripts and assets share one directory', () => {
  assert.ok(fs.existsSync(skillDocPath), 'skills/oh-coage/SKILL.md 应存在');

  for (const name of ['config-store.js', 'generate.js', 'resolve-output-dir.js', 'setup.js']) {
    assert.ok(fs.existsSync(path.join(skillDir, 'scripts', name)), `scripts/${name} 应存在`);
  }

  assert.ok(fs.existsSync(path.join(skillDir, 'assets', 'oh-coage-init-form.html')));

  assert.equal(
    fs.existsSync(path.join(repoRoot, 'scripts')),
    false,
    '仓库根不应再有 scripts/，否则等于存在两份脚本副本',
  );
});

test('every $SKILL_DIR path in the authoritative doc points at a real file', () => {
  const source = fs.readFileSync(skillDocPath, 'utf8');
  const referenced = new Set();

  for (const match of source.matchAll(/\$SKILL_DIR\/([A-Za-z0-9_./-]+)/g)) {
    referenced.add(match[1]);
  }

  assert.ok(referenced.size > 0, '权威文档里应至少引用一个 $SKILL_DIR 路径');

  for (const relative of referenced) {
    assert.ok(
      fs.existsSync(path.join(skillDir, relative)),
      `$SKILL_DIR/${relative} 在 skill 目录中不存在`,
    );
  }
});

test('the authoritative doc keeps the text path as baseline and gates the form behind capability checks', () => {
  const source = fs.readFileSync(skillDocPath, 'utf8');

  assert.doesNotMatch(source, /\$SKILL_DIR\/\.\.\//, '不应再使用 $SKILL_DIR/../ 这种越出 skill 目录的路径');
  assert.doesNotMatch(source, /必须直接展示初始化表单/, '表单不应被写成强制路径，否则无表单能力的环境会被卡住');
  assert.match(source, /默认路径/);
  assert.match(source, /window\.openai\.sendFollowUpMessage/);
  assert.match(source, /OH_COAGE_INIT_FORM_SUBMISSION/);
});

test('the repository-root SKILL.md stays a thin pointer to avoid a second drifting copy', () => {
  const source = fs.readFileSync(entryDocPath, 'utf8');
  const lineCount = source.trimEnd().split('\n').length;

  assert.ok(lineCount <= 60, `根 SKILL.md 应保持精简，当前 ${lineCount} 行`);
  assert.match(source, /skills\/oh-coage\/SKILL\.md/);

  for (const heading of ['## 后续生成流程', '## 图生图', '## 参数选择', '## 强制流程']) {
    assert.ok(!source.includes(heading), `根 SKILL.md 不应重复流程正文：${heading}`);
  }
});

test('both SKILL.md entry points advertise the same trigger description', () => {
  const readDescription = (filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, `${filePath} 缺少 frontmatter`);

    const line = frontmatter[1].split('\n').find((item) => item.startsWith('description:'));
    assert.ok(line, `${filePath} 的 frontmatter 缺少 description`);

    return line.slice('description:'.length).trim();
  };

  assert.equal(
    readDescription(entryDocPath),
    readDescription(skillDocPath),
    '两份 SKILL.md 的触发描述必须一致，否则整仓安装与单目录安装的触发行为会不同',
  );
});
