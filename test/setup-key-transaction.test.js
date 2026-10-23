const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('./helpers');
const setupPath = path.resolve(__dirname, '../skills/oh-coage/scripts/setup.js');

function scaffold(t, concurrent = false, shared = false) {
  const home = tempDir(t), outputDir = tempDir(t), bin = tempDir(t);
  const configPath = path.join(outputDir, 'oh-coage-config.json');
  const profile = { base_url: 'https://old.example/v1', root_output_dir: outputDir, keychain_account: 'old-account' };
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, active_profile: 'main', current_model: 'image-2', profiles: { main: profile, ...(shared ? { other: { ...profile } } : {}) } }));
  fs.mkdirSync(path.join(home, '.oh-coage'));
  fs.writeFileSync(path.join(home, '.oh-coage/state.json'), JSON.stringify({ config_path: configPath }));
  const keys = path.join(home, 'fake-keys.json'), calls = path.join(home, 'calls.jsonl');
  fs.writeFileSync(keys, JSON.stringify({ 'old-account': 'old-secret' }));
  const security = path.join(bin, 'security');
  fs.writeFileSync(security, `#!${process.execPath}\nconst fs = require('fs'); const args = process.argv.slice(2); const file = process.env.FAKE_KEYS; const keys = JSON.parse(fs.readFileSync(file)); const account = args[args.indexOf('-a')+1]; const op = args[0]; fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({op,account})+'\\n'); if(op==='add-generic-password') { keys[account] = fs.readFileSync(0,'utf8').split('\\n')[0]; if(process.env.FAKE_CONCURRENT==='1') { const p = process.env.FAKE_CONFIG; const c=JSON.parse(fs.readFileSync(p)); c.concurrent_edit='preserve-me'; fs.writeFileSync(p,JSON.stringify(c)); } } else if(op==='delete-generic-password') delete keys[account]; else if(op==='find-generic-password') console.log(keys[account]||''); fs.writeFileSync(file,JSON.stringify(keys));\n`);
  fs.chmodSync(security, 0o755);
  return { home, outputDir, configPath, keys, calls, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_KEYS: keys, FAKE_CALLS: calls, FAKE_CONFIG: configPath, FAKE_CONCURRENT: concurrent ? '1' : '0' } };
}
function run(data, extra = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [setupPath, '--profile', 'main', '--base-url', 'https://new.example/v1', '--api-key', 'new-secret', '--output-dir', data.outputDir, ...extra], { env: { ...process.env, HOME: data.home, ...data.env } });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume(); child.on('close', code => resolve({ code, stderr })); child.stdin.end();
  });
}

test('invalid image/model updates never touch existing credentials', async t => {
  const data = scaffold(t);
  for (const args of [['--image-transport', 'invalid'], ['--primary-model', 'invalid-model'], ['--fallback-model', 'invalid-model'], ['--model', 'invalid-model']]) {
    const result = await run(data, args);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(fs.existsSync(data.calls), false, `no secret operations for ${args}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(data.keys)), { 'old-account': 'old-secret' });
    assert.equal(JSON.parse(fs.readFileSync(data.configPath)).profiles.main.keychain_account, 'old-account');
  }
});

test('stale config save cleans new credential and preserves old key and concurrent edit', async t => {
  const data = scaffold(t, true);
  const result = await run(data);
  assert.equal(result.code, 1); assert.match(result.stderr, /其他操作更新/);
  assert.deepEqual(JSON.parse(fs.readFileSync(data.keys)), { 'old-account': 'old-secret' });
  const persisted = JSON.parse(fs.readFileSync(data.configPath));
  assert.equal(persisted.concurrent_edit, 'preserve-me');
  assert.equal(persisted.profiles.main.keychain_account, 'old-account');
  const calls = fs.readFileSync(data.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call.op === 'add-generic-password' && call.account !== 'old-account'));
  assert.ok(!calls.some(call => call.account === 'old-account'));
});

test('successful update uses new account and never deletes old account still referenced', async t => {
  const data = scaffold(t, false, true);
  const result = await run(data);
  assert.equal(result.code, 0, result.stderr);
  const persisted = JSON.parse(fs.readFileSync(data.configPath));
  assert.notEqual(persisted.profiles.main.keychain_account, 'old-account');
  const keys = JSON.parse(fs.readFileSync(data.keys));
  assert.equal(keys['old-account'], 'old-secret');
  assert.equal(keys[persisted.profiles.main.keychain_account], 'new-secret');
});
