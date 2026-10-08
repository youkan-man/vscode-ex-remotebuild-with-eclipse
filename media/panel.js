'use strict';
const api = acquireVsCodeApi();
let { draft, effective, dirty } = window.initialState;
let busy = false;
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const get = key => key.split('.').reduce((value, part) => value?.[part], draft.data);
function set(key, value) { const parts = key.split('.'); let target = draft.data; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = value; }
function changed() { api.postMessage({ type: 'edit', draft }); $('dirty').textContent = '未保存'; renderTarget(); }
function field(label, key, options = {}) {
  const { kind = 'text', pick = false, effectiveKey = '' } = options;
  const id = 'f-' + key.replaceAll('.', '-');
  const attributes = `id="${id}" data-path="${key}"${effectiveKey ? ` data-effective="${effectiveKey}"` : ''}`;
  const input = kind === 'list' ? `<textarea ${attributes} data-list>${esc((get(key) || []).join('\n'))}</textarea>` : `<input ${attributes} type="${kind}" value="${esc(get(key))}">`;
  return `<div class="field"><label for="${id}">${esc(label)}${effectiveKey ? `<span class="source-mark" data-source="${effectiveKey}"></span>` : ''}</label>${pick ? `<div class="pick">${input}<button type="button" class="secondary" data-pick="${key}">選択</button></div>` : input}</div>`;
}
function renderTarget() {
  const s = draft.data, p = effective[draft.selected]?.profile;
  $('target').innerHTML = `<span>接続先 <strong>${esc((s.ssh.user ? s.ssh.user + '@' : '') + (s.ssh.host || '未設定') + ':' + s.ssh.port)}</strong></span><span>コンテナ <strong>${esc(s.remote.container)}</strong></span><span>適用構成 <strong>${esc(p ? p.project + ' / ' + p.configuration : '未確定')}</strong></span>`;
}
function renderProfiles() {
  $('profiles').innerHTML = draft.data.profiles.map((p, i) => {
    const e = effective[i], resolved = e?.profile;
    return `<tr aria-selected="${i === draft.selected}" data-select="${i}"><td><input type="radio" name="selectedProfile" aria-label="${esc(p.name)}を選択" value="${i}" ${busy ? 'disabled' : ''} ${i === draft.selected ? 'checked' : ''}></td><td>${esc(p.name)}</td><td>${esc(e?.error || (resolved ? resolved.project + ' / ' + resolved.configuration : '読込中'))}</td><td>${esc(p.profileFile || '画面の設定')}</td></tr>`;
  }).join('');
  $('emptyProfiles').hidden = draft.data.profiles.length > 0;
}
function renderEditor() {
  const i = draft.selected, p = draft.data.profiles[i];
  if (!p) { $('editor').innerHTML = ''; return; }
  const base = 'profiles.' + i + '.';
  $('editor').innerHTML = `<div class="fields">${field('名前', base + 'name')}${field('構成JSON（ワークスペース相対）', base + 'profileFile', { pick: true })}${field('プロジェクト', base + 'project', { effectiveKey: 'project' })}${field('構成', base + 'configuration', { effectiveKey: 'configuration' })}${field('Eclipse実行ファイル（コンテナ）', base + 'eclipseExecutable', { effectiveKey: 'eclipseExecutable' })}${field('Eclipseワークスペース（コンテナ）', base + 'eclipseWorkspace', { effectiveKey: 'eclipseWorkspace' })}${field('インポート元（相対・1行1パス）', base + 'imports', { kind: 'list', effectiveKey: 'imports' })}${field('追加引数（1行1引数）', base + 'extraArgs', { kind: 'list', effectiveKey: 'extraArgs' })}<div class="field"><label for="environment">環境変数（JSON）<span class="source-mark" data-source="environment"></span></label><textarea id="environment" data-environment data-effective="environment">${esc(draft.environments[i] || '{}')}</textarea></div></div><div id="profileError" class="profile-error" role="status"></div><div class="editor-actions"><button id="openProfile" class="secondary" ${p.profileFile ? '' : 'disabled'}>構成JSONを編集</button><button id="removeProfile" class="secondary">このプロファイルを削除</button></div>`;
  applyEffective();
}
function applyEffective() {
  const i = draft.selected, e = effective[i], p = draft.data.profiles[i]; if (!p) return;
  const error = $('profileError'); if (error) error.textContent = e?.error || '';
  for (const el of $('editor').querySelectorAll('[data-effective]')) {
    const key = el.dataset.effective, overridden = !!e?.overrides.includes(key), value = overridden ? e.profile?.[key] : p[key];
    el.readOnly = overridden;
    const source = $('editor').querySelector(`[data-source="${key}"]`); source.textContent = overridden ? '適用元: ' + p.profileFile : '';
    if (overridden) el.value = key === 'environment' ? JSON.stringify(value, null, 2) : Array.isArray(value) ? value.join('\n') : value ?? '';
    else if (document.activeElement !== el) el.value = key === 'environment' ? draft.environments[i] || '{}' : Array.isArray(value) ? value.join('\n') : value ?? '';
  }
  if ($('openProfile')) $('openProfile').disabled = busy || !p.profileFile;
}
function renderArchives() {
  $('archives').innerHTML = draft.data.provision.archives.map((a, i) => {
    const base = 'provision.archives.' + i + '.';
    return `<tr><td><div class="pick"><input aria-label="アーカイブ ${i + 1}" data-path="${base}source" value="${esc(a.source)}"><button class="secondary" data-pick="${base}source">選択</button></div></td><td><input aria-label="展開先 ${i + 1}" data-path="${base}destination" value="${esc(a.destination)}"></td><td><input aria-label="除去階層数 ${i + 1}" type="number" min="0" data-path="${base}stripComponents" value="${a.stripComponents ?? 0}"></td><td><button class="secondary" data-remove-archive="${i}">削除</button></td></tr>`;
  }).join('');
}
function render() {
  $('connection').innerHTML = field('SSHホスト / 別名', 'ssh.host') + field('ユーザー', 'ssh.user') + field('ポート', 'ssh.port', { kind: 'number' }) + field('秘密鍵（空欄: SSHの既定値）', 'ssh.identityFile') + field('ホスト側の転送先', 'remote.root') + field('コンテナ名', 'remote.container') + field('Dockerコマンド', 'remote.dockerCommand');
  $('transfer').innerHTML = field('ソース（相対・1行1パス）', 'sync.include', { kind: 'list' }) + field('除外パターン（1行1件）', 'sync.exclude', { kind: 'list' }) + field('追加プロファイル（相対・1行1パス）', 'sync.profileFiles', { kind: 'list' });
  $('image').innerHTML = field('ベースイメージ', 'provision.baseImage') + field('作成するイメージ', 'provision.image') + field('Dockerfile（相対・空欄: 内蔵）', 'provision.dockerfile', { pick: true });
  renderProfiles(); renderEditor(); renderArchives(); renderTarget(); $('dirty').textContent = dirty ? '未保存' : '保存済み';
}
function select(index) { if (busy || index === draft.selected) return; draft.selected = index; renderProfiles(); renderEditor(); changed(); }
document.addEventListener('input', event => {
  const el = event.target; if (el.readOnly) return;
  if (el.hasAttribute('data-environment')) draft.environments[draft.selected] = el.value;
  else if (el.dataset.path) set(el.dataset.path, el.hasAttribute('data-list') ? el.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
  else return;
  if (el.dataset.path?.endsWith('.name')) renderProfiles();
  // Until the controller resolves the new file, do not label an old preview as current.
  if (el.dataset.path?.endsWith('.profileFile')) { effective[draft.selected] = undefined; renderProfiles(); applyEffective(); }
  changed();
});
document.addEventListener('change', event => { if (event.target.name === 'selectedProfile') select(Number(event.target.value)); });
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) { const row = event.target.closest('[data-select]'); if (row) select(Number(row.dataset.select)); return; }
  if (busy) return;
  if (button.dataset.pick) { api.postMessage({ type: 'pick', field: button.dataset.pick }); return; }
  if (button.dataset.removeArchive !== undefined) { draft.data.provision.archives.splice(Number(button.dataset.removeArchive), 1); renderArchives(); changed(); return; }
  if (['save', 'sync', 'build', 'deploy'].includes(button.id)) {
    api.postMessage({ type: 'edit', draft }); lock(true); api.postMessage({ type: 'action', action: button.id }); return;
  }
  if (button.id === 'addProfile') {
    let n = draft.data.profiles.length + 1; while (draft.data.profiles.some(p => p.name === 'Profile ' + n)) n++;
    draft.data.profiles.push({ name: 'Profile ' + n, profileFile: '', project: 'MyProject', configuration: 'Release', eclipseWorkspace: '/tmp/eclipse-workspace', eclipseExecutable: '/opt/eclipse/eclipse', imports: ['.'], extraArgs: [], environment: {} });
    draft.environments.push('{}'); draft.selected = draft.data.profiles.length - 1; renderProfiles(); renderEditor(); changed(); return;
  }
  if (button.id === 'removeProfile') { draft.data.profiles.splice(draft.selected, 1); draft.environments.splice(draft.selected, 1); effective.splice(draft.selected, 1); draft.selected = Math.max(0, Math.min(draft.selected, draft.data.profiles.length - 1)); renderProfiles(); renderEditor(); changed(); return; }
  if (button.id === 'addArchive') { draft.data.provision.archives.push({ source: '', destination: '/opt/eclipse', stripComponents: 1 }); renderArchives(); changed(); return; }
  if (button.id === 'openProfile') api.postMessage({ type: 'openProfile' });
  if (button.id === 'reload') api.postMessage({ type: 'reload' });
});
function lock(value) { busy = value; document.querySelectorAll('button,input,textarea').forEach(el => el.disabled = value); applyEffective(); }
window.addEventListener('message', event => {
  const m = event.data;
  if (m.requestDraft) { api.postMessage({ type: 'snapshot', id: m.requestDraft, draft }); return; }
  if (m.replaceDraft) { draft = m.replaceDraft; render(); }
  if (m.effective) { effective = m.effective; if (Number.isInteger(m.selected)) draft.selected = m.selected; renderProfiles(); applyEffective(); renderTarget(); }
  if (m.dirty !== undefined) { dirty = m.dirty; $('dirty').textContent = dirty ? '未保存' : '保存済み'; }
  if (m.busy !== undefined) lock(m.busy);
  if ('run' in m) { $('run').hidden = !m.run; $('run').textContent = m.run ? '実行中: ' + m.run : ''; }
  if (m.status !== undefined) { $('status').className = m.error ? 'error' : ''; $('status').textContent = m.status; }
  if (m.picked) { set(m.picked.field, m.picked.value); const el = document.querySelector(`[data-path="${m.picked.field}"]`); if (el) el.value = m.picked.value; changed(); }
});
render();
