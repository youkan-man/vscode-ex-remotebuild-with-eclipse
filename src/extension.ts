import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Settings, localPath, relative, validate } from './model';
import { WorkspaceSession, Draft, Effective, RunPlan } from './session';
import { createRemote } from './runtime';
import { Sidebar } from './sidebar';

type Action = 'build' | 'sync' | 'deploy' | 'provision' | 'save';
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Eclipse Remote Build');
  const remote = createRemote(output), sidebar = new Sidebar();
  const tree = vscode.window.createTreeView('eclipseRemote.actions', { treeDataProvider: sidebar });
  let session: WorkspaceSession | undefined, opening: Promise<WorkspaceSession> | undefined;
  let panel: vscode.WebviewPanel | undefined, busy = false, previewTimer: NodeJS.Timeout | undefined, previewGeneration = 0;
  let effective: Effective[] = [];
  const pending = new Map<string, { resolve(d: Draft): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  context.subscriptions.push(output, sidebar, tree);
  const folder = (): vscode.WorkspaceFolder => {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1 || folders[0].uri.scheme !== 'file') throw Error('ビルドするフォルダーを1つ開いてください');
    return folders[0];
  };
  const send = (message: unknown): void => { if (panel) void panel.webview.postMessage(message); };
  const notice = (value: string, error = false): void => { send({ status: value, error }); output.appendLine(value); };
  const changed = (): void => {
    if (previewTimer) clearTimeout(previewTimer);
    // Invalidate in-flight reads immediately, not when the next debounce fires.
    const generation = ++previewGeneration;
    sidebar.update(session, effective, busy);
    send({ dirty: session?.dirty, busy });
    previewTimer = setTimeout(async () => {
      if (!session) return;
      const rows = await session.preview();
      if (generation !== previewGeneration) return;
      effective = rows; sidebar.update(session, rows, busy);
      send({ effective: rows, selected: session.value.selected, dirty: session.dirty });
    }, 120);
  };
  async function getSession(): Promise<WorkspaceSession> {
    const currentFolder = folder();
    if (session && session.root !== currentFolder.uri.fsPath) { panel?.dispose(); session = undefined; effective = []; }
    if (session) return session;
    if (opening) return opening;
    const f = folder();
    const config = localPath(f.uri.fsPath, vscode.workspace.getConfiguration('eclipseRemote', f.uri).get('configFile', '.vscode/eclipse-remote-build.json'));
    opening = (async () => {
      const store = new WorkspaceSession(f.uri.fsPath, config, async absolute => {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === absolute && d.isDirty);
        return doc ? Buffer.from(doc.getText(), 'utf8') : fs.readFile(absolute);
      });
      await store.reload(); session = store;
      const selected = context.workspaceState.get<string>('eclipseRemote.selected');
      const index = store.value.data.profiles.findIndex(p => p.name === selected); if (index >= 0) store.select(index);
      context.subscriptions.push(store.onChange(changed));
      changed(); return store;
    })();
    try { return await opening; } finally { opening = undefined; }
  }
  async function flush(): Promise<void> {
    const store = await getSession(), current = panel;
    if (!current) return;
    const id = randomBytes(8).toString('hex');
    const draft = await new Promise<Draft>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('設定画面の入力を取得できません。設定画面を開き直してください')); }, 8000);
      pending.set(id, { resolve, reject, timer });
      void current.webview.postMessage({ requestDraft: id }).then(delivered => {
        if (!delivered && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(Error('設定画面が閉じられました')); }
      });
    });
    store.edit(draft);
  }
  async function execute(action: Action): Promise<string | false | undefined> {
    if (!vscode.workspace.isTrusted) throw Error('リモート操作にはワークスペースの信頼が必要です');
    if (busy) return false;
    busy = true; changed();
    let plan: RunPlan | undefined;
    try {
      const store = await getSession();
      await flush(); // Both sidebar and panel acknowledge the same last keystroke before capture.
      const snapshot = store.value;
      const name = snapshot.data.profiles[snapshot.selected]?.name;
      if (name) void context.workspaceState.update('eclipseRemote.selected', name);
      if (action === 'save') { await store.save(); notice('設定を保存しました'); return '設定を保存しました'; }
      const deploying = action === 'deploy' || action === 'provision';
      const settings: Settings = deploying ? store.settings() : (plan = await store.prepare(action === 'build')).settings;
      validate(settings);
      const destination = (settings.ssh.user ? settings.ssh.user + '@' : '') + settings.ssh.host + ':' + settings.ssh.port;
      const selection = plan?.profile ? plan.profile.project + ' / ' + plan.profile.configuration : settings.remote.container;
      const runLabel = destination + ' → ' + selection;
      send({ run: runLabel }); output.show(true); output.appendLine('実行先: ' + runLabel);
      if (plan?.digest) output.appendLine('構成JSON SHA-256: ' + plan.digest);
      let result = '';
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Eclipse Remote Build', cancellable: true }, async (progress, token) => {
        const phase = (message: string): void => { progress.report({ message }); notice(message); };
        if (deploying) {
          phase('アーカイブ転送・イメージ構築'); await remote.provision(settings, store.root, token);
          phase('コンテナ作成・起動');
          if (!await remote.startContainer(settings, store.root, token)) {
            const choice = await vscode.window.showWarningMessage('コンテナを再作成します。コンテナ内だけの変更は失われます。転送済みのワークスペースは保持します。', { modal: true }, '再作成');
            if (choice !== '再作成') throw Error('イメージ構築済み。既存コンテナは置換していません');
            await remote.startContainer(settings, store.root, token, true);
          }
          result = await remote.verifyDeployment(settings, store.root, token);
        } else {
          phase('ソース・プロファイルを差分転送'); await remote.synchronize(plan!, store.root, token);
          if (plan!.profile) { phase('Eclipseでビルド'); await remote.build(settings, plan!.profile, store.root, token); }
          result = plan!.profile ? 'ビルド完了' : '同期完了';
        }
      });
      notice(result + ' · ' + runLabel); return result;
    } catch (e) { const message = String((e as Error).message); notice(message, true); void vscode.window.showErrorMessage(message); return false; }
    finally { try { if (plan) await plan.dispose(); } finally { busy = false; send({ run: null }); changed(); } }
  }
  const reveal = (): boolean => { if (!panel) return false; panel.reveal(); return true; };
  async function configure(): Promise<void> {
    const store = await getSession();
    if (reveal()) return;
    const template = await fs.readFile(path.join(context.extensionPath, 'media/panel.html'), 'utf8');
    const rows = await store.preview();
    if (reveal()) return;
    const created = vscode.window.createWebviewPanel('eclipseRemote', 'Eclipse Remote Build', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')], retainContextWhenHidden: true });
    panel = created;
    const nonce = randomBytes(18).toString('hex');
    created.webview.html = template.replace(/__CSP__/g, created.webview.cspSource).replace(/__NONCE__/g, nonce)
      .replace('__SCRIPT__', created.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media/panel.js')).toString())
      .replace('__STYLE__', created.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media/panel.css')).toString())
      .replace('__VERSION__', context.extension.packageJSON.version)
      .replace('__STATE__', () => JSON.stringify({ draft: store.value, effective: rows, dirty: store.dirty }).replace(/</g, '\\u003c'));
    const subscription = created.webview.onDidReceiveMessage(async (message: { type: string; draft?: Draft; id?: string; action?: string; field?: string }) => {
      try {
        if (message.type === 'snapshot' && message.id) {
          const waiter = pending.get(message.id); if (!waiter) return;
          clearTimeout(waiter.timer); pending.delete(message.id);
          message.draft ? waiter.resolve(message.draft) : waiter.reject(Error('編集データを取得できません')); return;
        }
        if (message.type === 'edit' && message.draft) { store.edit(message.draft); return; }
        if (message.type === 'action' && ['save', 'sync', 'build', 'deploy'].includes(message.action || '')) { await execute(message.action as Action); return; }
        if (busy) return;
        if (message.type === 'reload') {
          if (store.dirty && await vscode.window.showWarningMessage('編集中の設定を破棄してファイルを読み直しますか？', { modal: true }, '再読込') !== '再読込') return;
          await store.reload(); send({ replaceDraft: store.value }); return;
        }
        if (message.type === 'openProfile') {
          await flush(); const d = store.value, rel = d.data.profiles[d.selected]?.profileFile;
          if (rel) { const file = await store.contained(rel); await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside }); } return;
        }
        if (message.type === 'pick' && message.field) {
          const chosen = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(store.root), canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
          if (chosen?.[0]) send({ picked: { field: message.field, value: relative(path.relative(store.root, chosen[0].fsPath)) } });
        }
      } catch (e) { notice(String((e as Error).message), true); }
    });
    created.onDidDispose(() => {
      subscription.dispose(); if (panel === created) panel = undefined;
      for (const [id, waiter] of pending) { clearTimeout(waiter.timer); waiter.reject(Error('設定画面が閉じられました')); pending.delete(id); }
    });
    changed();
  }
  const guarded = (fn: (...args: any[]) => unknown) => async (...args: any[]) => { try { return await fn(...args); } catch (e) { void vscode.window.showErrorMessage(String((e as Error).message)); return false; } };
  context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.configure', guarded(configure)));
  context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.showOutput', () => output.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.selectProfile', guarded(async (index: number) => {
    if (busy) return; await flush(); session!.select(index); send({ replaceDraft: session!.value });
  })));
  for (const action of ['build', 'sync', 'deploy', 'provision'] as const) context.subscriptions.push(vscode.commands.registerCommand('eclipseRemote.' + action, guarded(() => execute(action))));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (vscode.workspace.workspaceFolders?.length === 1) void getSession().catch(e => notice(String(e), true));
    else { panel?.dispose(); session = undefined; effective = []; sidebar.update(undefined, [], busy); }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(() => changed()));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => changed()));
  if (vscode.workspace.workspaceFolders?.length === 1) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder(), '**/*'));
    const fileChanged = async (uri: vscode.Uri): Promise<void> => {
      if (!session) return;
      if (uri.fsPath === session.config && !session.dirty && !busy) { try { await session.reload(); send({ replaceDraft: session.value }); } catch (e) { notice(String((e as Error).message), true); } }
      changed();
    };
    context.subscriptions.push(watcher, watcher.onDidChange(fileChanged), watcher.onDidCreate(fileChanged), watcher.onDidDelete(fileChanged));
    void getSession().catch(e => notice(String(e), true));
  }
  context.subscriptions.push({ dispose: () => { if (previewTimer) clearTimeout(previewTimer); } });
}
export function deactivate(): void {}
