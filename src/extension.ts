import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Action, defaults, localPath, normalize, prepare, preview, Preview, Settings, Snapshot } from './configuration';
import { ConfigurationSession } from './session';
import { RemoteRuntime } from './runtime';
import { registerSidebar, SidebarState } from './sidebar';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Eclipse Remote Build');
  const runtime = new RemoteRuntime(output);
  let session: ConfigurationSession | undefined, folder: vscode.WorkspaceFolder | undefined;
  let panel: vscode.WebviewPanel | undefined, panelReady = false, running = false, saving = false;
  let effective: Preview[] = [], previewKey = '', previewTicket = 0, epoch = 0;
  let activePlan: Snapshot | undefined;
  let flush: { id: string; done: () => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const getFolder = () => {
    const all = vscode.workspace.workspaceFolders;
    if (all?.length !== 1 || all[0].uri.scheme !== 'file') throw new Error('ワークスペースのフォルダーを1つ開いてください');
    return all[0];
  };
  const configPath = (f: vscode.WorkspaceFolder) => localPath(f.uri.fsPath, vscode.workspace.getConfiguration('eclipseRemote', f.uri).get('configFile', '.vscode/eclipse-remote-build.json'));
  const readSettings = async (f: vscode.WorkspaceFolder): Promise<Settings> => {
    try { return normalize(JSON.parse(await fs.readFile(configPath(f), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaults); throw e; }
  };
  const readAt = async (workspaceRoot: string, relative: string): Promise<Buffer> => {
    const root = await fs.realpath(workspaceRoot), file = await fs.realpath(localPath(root, relative));
    const inside = path.relative(root, file);
    if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('ワークスペース外のファイルです: ' + relative);
    return fs.readFile(file);
  };
  const read = (relative: string) => readAt(getFolder().uri.fsPath, relative);
  const sidebarState = (): SidebarState | undefined => {
    if (!session) return;
    const s = activePlan?.settings || session.data, i = session.selected;
    const p: Preview | undefined = activePlan?.profile ? { profile: activePlan.profile, origin: activePlan.profile.profileFile || '画面設定' } : effective[i];
    return { host: s.ssh.host ? `${s.ssh.user ? s.ssh.user + '@' : ''}${s.ssh.host}:${s.ssh.port}` : '', container: s.remote.container, profile: s.profiles[i]?.name || '', configuration: p?.error ? '構成JSONエラー' : p?.profile ? p.profile.project + ' / ' + p.profile.configuration : '解決中', status: session.status, busy: session.busy, dirty: session.dirty, conflict: session.conflict };
  };
  const refreshSidebar = registerSidebar(context, sidebarState);
  const post = (message: unknown) => { if (panelReady) void panel?.webview.postMessage(message); };
  const publish = (full = false) => {
    refreshSidebar();
    if (!session) return;
    post({ type: 'state', summary: sidebarState(), selected: session.selected, effective, ...(full ? { settings: session.data, raw: session.rawEnvironment } : {}) });
  };
  const changed = () => {
    if (!session) return;
    const key = JSON.stringify(session.data.profiles) + ':' + epoch;
    if (key !== previewKey) {
      previewKey = key; effective = []; const ticket = ++previewTicket;
      void Promise.all(session.data.profiles.map(p => preview(p, read))).then(values => {
        if (ticket !== previewTicket) return;
        effective = values; publish();
      });
    }
    publish();
  };
  let initializing: Promise<ConfigurationSession> | undefined;
  const ensure = async (): Promise<ConfigurationSession> => {
    const current = getFolder();
    if (session && folder?.uri.toString() === current.uri.toString()) return session;
    if (!initializing) initializing = (async () => {
      folder = current; const value = await readSettings(current);
      session = new ConfigurationSession(value, changed); changed(); return session;
    })().finally(() => { initializing = undefined; });
    return initializing;
  };
  const flushDraft = async () => {
    if (!panel) return;
    if (!panelReady) throw new Error('設定画面の読み込みが完了していません');
    await new Promise<void>((done, fail) => {
      const id = randomBytes(8).toString('hex');
      const timer = setTimeout(() => { flush = undefined; fail(new Error('設定画面から編集内容を取得できませんでした')); }, 5000);
      flush = { id, done, fail, timer }; post({ type: 'requestDraft', id });
    });
  };
  const error = (e: unknown) => {
    const text = e instanceof Error ? e.message : String(e);
    output.appendLine(text); session?.signal('エラー: ' + text); post({ type: 'error', text });
    void vscode.window.showErrorMessage(text);
  };
  const run = async (action: Action): Promise<string | false | undefined> => {
    if (running || saving) return false;
    running = true; let state: ConfigurationSession | undefined;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('このワークスペースを信頼してから実行してください');
      state = await ensure(); state.signal('入力確認', true); await flushDraft();
      const root = getFolder().uri.fsPath;
      if (action === 'build' && state.errors[state.selected]) throw new Error(state.errors[state.selected]);
      const plan = await prepare(action, state.data, state.selected, p => readAt(root, p));
      activePlan = plan; publish();
      const target = `${plan.settings.ssh.host}:${plan.settings.ssh.port}`;
      output.show(true); output.appendLine('実行先: ' + target + (plan.profile ? ' / ' + plan.profile.project + '/' + plan.profile.configuration : ''));
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Eclipse Remote Build', cancellable: true }, async (progress, token) => {
        const report = (v: string) => { state!.signal(v, true); progress.report({ message: v }); };
        if (action === 'deploy') return runtime.deploy(plan, root, token, report, async () => (await vscode.window.showWarningMessage('コンテナを再作成します。コンテナ内だけの変更は失われます。ワークスペースは保持します。', { modal: true }, '再作成')) === '再作成');
        report('差分転送: ' + target); await runtime.synchronize(plan, root, token);
        if (action === 'build') { report('ビルド: ' + plan.profile!.project + ' / ' + plan.profile!.configuration); await runtime.build(plan, root, token); }
        return action === 'build' ? 'ビルド完了' : '同期完了';
      });
      state.signal(result); output.appendLine(result); return result;
    } catch (e) { if (e instanceof vscode.CancellationError) state?.signal('キャンセルしました（リモート処理は終了未確認）'); else error(e); return false; }
    finally { activePlan = undefined; running = false; if (state) state.signal(state.status, false); }
  };
  const save = async () => {
    if (saving || running) return;
    saving = true;
    try {
      const state = await ensure(); await flushDraft();
      if (Object.keys(state.errors).length) throw new Error('環境変数のJSONを修正してから保存してください');
      state.external(await readSettings(getFolder()));
      if (state.conflict && (await vscode.window.showWarningMessage('設定ファイルが外部で変更されています。画面の内容で上書きしますか？', { modal: true }, '上書き')) !== '上書き') return;
      const value = state.data, dest = configPath(getFolder());
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const root = await fs.realpath(getFolder().uri.fsPath), parent = await fs.realpath(path.dirname(dest)), rel = path.relative(root, parent);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('設定保存先がワークスペース外です');
      const temp = dest + '.' + randomBytes(8).toString('hex') + '.tmp';
      try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n'); await fs.rename(temp, dest); }
      finally { await fs.rm(temp, { force: true }); }
      state.markSaved(value); state.signal('設定を保存しました');
    } catch (e) { error(e); } finally { saving = false; }
  };
  const configure = async () => {
    try {
      const state = await ensure();
      if (panel) { panel.reveal(); return; }
      const nonce = randomBytes(18).toString('hex');
      const html = (await fs.readFile(path.join(context.extensionPath, 'media/panel.html'), 'utf8')).replace(/__NONCE__/g, nonce).replace('__DATA__', () => JSON.stringify({ settings: state.data, raw: state.rawEnvironment, selected: state.selected }).replace(/</g, '\\u003c'));
      if (panel) { (panel as vscode.WebviewPanel).reveal(); return; }
      panel = vscode.window.createWebviewPanel('eclipseRemote', 'Eclipse Remote Build', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
      const current = panel;
      const listener = current.webview.onDidReceiveMessage(async m => {
        try {
          if (m.type === 'ready') { panelReady = true; publish(true); return; }
          if (m.type === 'draft') {
            state.update(m.settings, m.errors || {}, m.raw || {}, m.selected);
            if (flush?.id === m.id) { const pending = flush; flush = undefined; clearTimeout(pending.timer); pending.done(); }
            return;
          }
          if (m.type === 'select') { state.select(m.index); return; }
          if (m.type === 'run' && ['build', 'sync', 'deploy'].includes(m.action)) { await run(m.action); return; }
          if (m.type === 'save') { await save(); return; }
          if (m.type === 'reload') {
            if (state.dirty && (await vscode.window.showWarningMessage('未保存の変更を破棄しますか？', { modal: true }, '読み直す')) !== '読み直す') return;
            state.reload(await readSettings(getFolder())); publish(true); return;
          }
          if (m.type === 'openProfile') {
            const p = state.data.profiles[state.selected]?.profileFile;
            if (p) await vscode.window.showTextDocument(vscode.Uri.file(localPath(getFolder().uri.fsPath, p)));
            return;
          }
          if (m.type === 'pick' && typeof m.field === 'string' && /^(?:ssh\.identityFile|provision\.dockerfile|provision\.archives\.\d+\.source|profiles\.\d+\.profileFile)$/.test(m.field)) {
            const chosen = await vscode.window.showOpenDialog({ defaultUri: getFolder().uri, canSelectMany: false, canSelectFiles: true, canSelectFolders: false });
            if (chosen?.[0]) {
              const value = m.field === 'ssh.identityFile' ? chosen[0].fsPath : path.relative(getFolder().uri.fsPath, chosen[0].fsPath);
              if (m.field !== 'ssh.identityFile') localPath(getFolder().uri.fsPath, value);
              post({ type: 'picked', field: m.field, value });
            }
          }
        } catch (e) { error(e); if (flush?.id === m.id) { clearTimeout(flush.timer); flush.fail(e as Error); flush = undefined; } }
      });
      current.onDidDispose(() => { listener.dispose(); if (panel === current) { panel = undefined; panelReady = false; } if (flush) { clearTimeout(flush.timer); flush.fail(new Error('設定画面が閉じられました')); flush = undefined; } });
      current.webview.html = html;
    } catch (e) { error(e); }
  };
  const selectProfile = async () => {
    const state = await ensure(); if (running || saving) return;
    await flushDraft();
    const selected = await vscode.window.showQuickPick(state.data.profiles.map((p, index) => ({ label: p.name || '(未設定)', description: effective[index]?.profile?.configuration, index })), { placeHolder: '使用するプロファイル' });
    if (selected) state.select(selected.index);
  };
  const commands: Record<string, (...args: any[]) => unknown> = { configure, showOutput: () => output.show(true), selectProfile, save,
    build: () => run('build'), sync: () => run('sync'), deploy: () => run('deploy'), provision: () => run('deploy') };
  for (const [name, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.' + name, async (...args) => { try { return await fn(...args); } catch (e) { error(e); return false; } }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.json');
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const externalChange = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => {
    if (!session || !folder) return;
    epoch++; changed();
    if (!saving) void readSettings(folder).then(value => { if (session?.external(value)) publish(true); }).catch(error);
  }, 100); };
  context.subscriptions.push(output, watcher, watcher.onDidChange(externalChange), watcher.onDidCreate(externalChange), watcher.onDidDelete(externalChange), vscode.workspace.onDidChangeWorkspaceFolders(() => {
    panel?.dispose(); session = undefined; folder = undefined; effective = []; previewKey = ''; epoch++; if (vscode.workspace.workspaceFolders?.length === 1) void ensure().catch(error); else refreshSidebar();
  }), { dispose: () => { clearTimeout(refreshTimer); panel?.dispose(); } });
  if (vscode.workspace.workspaceFolders?.length === 1) void ensure().catch(error);
}
export function deactivate(): void {}
