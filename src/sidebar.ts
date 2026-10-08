import * as vscode from 'vscode';

class BuildActions implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void { this.changed.fire(); }
  dispose(): void { this.changed.dispose(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element || !vscode.workspace.workspaceFolders?.length) return [];
    return [
      this.action('設定を開く', 'configure', 'settings-gear', 'SSH接続・転送対象・Eclipse・ビルドプロファイルを設定'),
      this.action('Dockerへデプロイ', 'deploy', 'vm', '設定したアーカイブからイメージを構築し、コンテナを起動'),
      this.action('同期のみ', 'sync', 'sync', 'ソースとプロファイルを差分転送'),
      this.action('同期してビルド', 'build', 'tools', 'プロファイルを選んで差分転送とEclipseビルドを実行'),
      this.action('ログを表示', 'showOutput', 'output', 'Eclipse Remote Buildの出力を表示')
    ];
  }

  private action(label: string, name: string, icon: string, tooltip: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = 'eclipseRemote.' + name;
    item.command = { command: item.id, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    item.tooltip = tooltip;
    return item;
  }
}

export function registerSidebar(context: vscode.ExtensionContext): void {
  const provider = new BuildActions();
  const view = vscode.window.createTreeView('eclipseRemote.actions', {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false
  });
  const update = () => {
    view.description = vscode.workspace.workspaceFolders?.map(folder => folder.name).join(', ');
    provider.refresh();
  };
  context.subscriptions.push(provider, view, vscode.workspace.onDidChangeWorkspaceFolders(update));
  update();
}
