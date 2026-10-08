const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, normalize, prepare, preview, relative, containerPath } = require('../dist/configuration');
const { ConfigurationSession } = require('../dist/session');
const settings = () => { const s = structuredClone(defaults); s.ssh.host = 'builder'; return s; };
const noRead = async p => { throw new Error('Unexpected read: ' + p); };
test('incomplete deployment archive is a savable draft', () => {
  const s = settings(); s.provision.archives.push({ source: '', destination: '', stripComponents: 0 });
  assert.deepEqual(normalize(s), s);
});
test('sync ignores incomplete deployment and unused build fields', async () => {
  const s = settings(); s.provision.archives.push({ source: '', destination: '' }); s.provision.image = ''; s.remote.container = ''; s.profiles[0].project = '';
  assert.equal((await prepare('sync', s, 0, noRead)).action, 'sync');
});
test('build ignores incomplete deployment archive', async () => {
  const s = settings(); s.provision.archives.push({ source: '', destination: '' });
  assert.equal((await prepare('build', s, 0, noRead)).profile.configuration, 'Debug');
});
test('deploy validates its own incomplete archive', async () => {
  const s = settings(); s.provision.archives.push({ source: '', destination: '' });
  await assert.rejects(prepare('deploy', s, 0, noRead), /相対パス/);
});
test('deploy does not read invalid build JSON or validate source paths', async () => {
  const s = settings(); s.profiles[0].profileFile = 'missing.json'; s.profiles[0].project = ''; s.sync.include = ['../not-used'];
  assert.equal((await prepare('deploy', s, 0, noRead)).action, 'deploy');
});
test('JSON bytes are read once and shared by transfer and effective build', async () => {
  const s = settings(); s.profiles[0].profileFile = 'config/release.json'; s.sync.profileFiles = ['config/release.json'];
  let reads = 0; const first = Buffer.from('{ "configuration": "Release", "imports": [".project-dir"], "environment":{"ROOT":"${workspaceFolder}/profiles"} }');
  const plan = await prepare('build', s, 0, async () => { reads++; return reads === 1 ? first : Buffer.from('{"configuration":"Debug"}'); });
  assert.equal(reads, 1); assert.equal(plan.profile.configuration, 'Release'); assert.deepEqual(Buffer.from(plan.files['config/release.json'], 'base64'), first);
  assert.deepEqual(plan.profile.imports, ['.project-dir']); assert.equal(containerPath(plan.profile.imports[0]), '/workspace/.project-dir');
  s.ssh.host = 'changed'; s.profiles[0].configuration = 'changed';
  assert.equal(plan.settings.ssh.host, 'builder'); assert.equal(plan.profile.configuration, 'Release');
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.settings.ssh)); assert.ok(Object.isFrozen(plan.profile.imports));
});
test('preview and execution use the same override rules', async () => {
  const s = settings(); s.profiles[0].profileFile = 'config/release.json';
  const read = async () => Buffer.from('{"name":"ignored","configuration":"Release","project":"Actual"}');
  const shown = await preview(s.profiles[0], read), plan = await prepare('build', s, 0, read);
  assert.deepEqual(shown.profile, plan.profile); assert.equal(shown.profile.name, 'Debug'); assert.equal(shown.origin, 'config/release.json');
});
test('malformed JSON is visible in preview and stops build', async () => {
  const s = settings(); s.profiles[0].profileFile = 'bad.json'; const read = async () => Buffer.from('{');
  assert.ok((await preview(s.profiles[0], read)).error); await assert.rejects(prepare('build', s, 0, read));
});
test('sync can copy malformed profile bytes without interpreting them', async () => {
  const s = settings(); s.profiles[0].profileFile = 'bad.json';
  const plan = await prepare('sync', s, 0, async () => Buffer.from('{'));
  assert.equal(Buffer.from(plan.files['bad.json'], 'base64').toString(), '{');
});
test('unselected broken profile does not block a selected build', async () => {
  const s = settings(); s.profiles.push({ ...s.profiles[0], name: '', profileFile: 'missing.json' });
  assert.equal((await prepare('build', s, 0, noRead)).profile.configuration, 'Debug');
});
test('relative paths preserve dot directory and reject escapes', () => {
  assert.equal(relative('src\\main.cpp'), 'src/main.cpp'); assert.equal(containerPath('.project-dir'), '/workspace/.project-dir');
  assert.equal(containerPath('.'), '/workspace');
  for (const p of ['../outside', '/etc/passwd', 'C:\\temp\\file', '//server/share']) assert.throws(() => relative(p));
});
test('session owns the draft for both sidebar and form execution', async () => {
  let notices = 0; const initial = settings(), session = new ConfigurationSession(initial, () => notices++);
  const form = session.data; form.ssh.host = 'edited-host'; session.update(form);
  assert.equal(session.dirty, true); const fromSidebar = await prepare('sync', session.data, session.selected, noRead);
  assert.equal(fromSidebar.settings.ssh.host, 'edited-host'); assert.equal(initial.ssh.host, 'builder');
  form.ssh.host = 'mutated-after-update'; assert.equal(session.data.ssh.host, 'edited-host'); assert.ok(notices > 0);
});
test('saving an earlier snapshot does not mark later draft edits saved', () => {
  const session = new ConfigurationSession(settings(), () => {}); const snapshot = session.data;
  const next = session.data; next.ssh.host = 'later'; session.update(next); session.markSaved(snapshot);
  assert.equal(session.dirty, true);
});
test('external update reloads clean state but never overwrites dirty state', () => {
  const session = new ConfigurationSession(settings(), () => {}); const external = settings(); external.ssh.host = 'external';
  assert.equal(session.external(external), true); assert.equal(session.data.ssh.host, 'external');
  const edited = session.data; edited.ssh.host = 'draft'; session.update(edited);
  external.ssh.host = 'new-external'; assert.equal(session.external(external), false);
  assert.equal(session.conflict, true); assert.equal(session.data.ssh.host, 'draft');
  session.reload(external); assert.equal(session.conflict, false); assert.equal(session.dirty, false);
});
test('pending malformed environment is retained and marks draft dirty', () => {
  const session = new ConfigurationSession(settings(), () => {}); session.update(session.data, { 0: 'JSON error' }, { 0: '{' });
  assert.equal(session.dirty, true); assert.equal(session.rawEnvironment[0], '{');
});
