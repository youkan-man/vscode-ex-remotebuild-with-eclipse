import * as vscode from 'vscode';
export type SidebarState = { host: string; container: string; profile: string; configuration: string; status: string; dirty: boolean; conflict: boolean; busy: boolean };
export function registerSidebar(context: vscode.ExtensionContext, state: () => SidebarState | undefined): () => void {
  const changed = new vscode.EventEmitter<void>();
  const item = (label: string, icon: string, command?: string, description?: string) => {
    const row = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    row.id = label; row.iconPath = new vscode.ThemeIcon(icon); row.description = description;
    row.tooltip = description ? label + ': ' + description : label;
    if (command) row.command = { command: 'eclipseRemote.' + command, title: label };
    return row;
  };
  const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
    onDidChangeTreeData: changed.event, getTreeItem: row => row,
    getChildren: parent => {
      if (parent || !vscode.workspace.workspaceFolders?.length) return [];
      const s = state();
      return [
        item('接続先', 'remote', 'configure', s?.host || '未設定'),
        item('プロファイル', 'list-selection', 'selectProfile', s?.profile || '未選択'),
        item('適用構成', 'symbol-property', undefined, s?.configuration || '—'),
        item(s?.conflict ? '設定ファイルが更新されています' : s?.dirty ? '未保存の設定' : '保存済みの設定', s?.dirty ? 'circle-filled' : 'check'),
        item(s?.status || '待機', s?.busy ? 'loading~spin' : 'info'),
        item('同期してビルド', 'tools', 'build'), item('同期のみ', 'sync', 'sync'),
        item('Dockerへデプロイ', 'vm', 'deploy', s?.container),
        item('設定を開く', 'settings-gear', 'configure'), item('ログを表示', 'output', 'showOutput')
      ];
    }
  };
  const view = vscode.window.createTreeView('eclipseRemote.actions', { treeDataProvider: provider, showCollapseAll: false });
  context.subscriptions.push(changed, view);
  return () => changed.fire();
}
