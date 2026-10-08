import * as vscode from 'vscode';
import { Effective, WorkspaceSession } from './session';

export class Sidebar implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private session?: WorkspaceSession;
  private effective: Effective[] = [];
  private busy = false;
  update(session: WorkspaceSession | undefined, effective: Effective[], busy: boolean): void {
    this.session = session; this.effective = effective; this.busy = busy; this.changed.fire();
  }
  dispose(): void { this.changed.dispose(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    if (parent || !this.session) return [];
    const d = this.session.value, s = d.data, p = this.effective[d.selected]?.profile;
    const target = new vscode.TreeItem(s.ssh.host || '接続先未設定');
    target.description = this.busy ? '実行中' : this.session.dirty ? '未保存' : '保存済み';
    target.iconPath = new vscode.ThemeIcon('remote');
    const items = [target];
    for (const [label, command, icon] of [
      ['設定を開く', 'configure', 'settings-gear'], ['Dockerへデプロイ', 'deploy', 'vm'],
      ['同期のみ', 'sync', 'sync'], ['同期してビルド', 'build', 'tools'], ['ログを表示', 'showOutput', 'output']
    ]) {
      const item = new vscode.TreeItem(label); item.id = command; item.iconPath = new vscode.ThemeIcon(icon);
      item.command = { command: 'eclipseRemote.' + command, title: label };
      if (command === 'build' && p) item.description = p.name + ' / ' + p.configuration;
      items.push(item);
    }
    this.effective.forEach((e, i) => {
      const item = new vscode.TreeItem(e.name); item.id = 'profile-' + i;
      item.description = e.error ? '読込エラー' : e.profile?.project + ' / ' + e.profile?.configuration;
      item.iconPath = new vscode.ThemeIcon(i === d.selected ? 'check' : 'circle-outline');
      item.command = { command: 'eclipseRemote.selectProfile', title: e.name, arguments: [i] };
      items.push(item);
    });
    return items;
  }
}
