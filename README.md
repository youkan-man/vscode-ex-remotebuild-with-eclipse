# Eclipse Remote Build

SSH経由でソースを差分転送し、Docker内のEclipse CDTでビルドするVS Code拡張。

## 開発

```sh
npm install
npm run compile
```

## 使用

コマンドパレットの `Eclipse Remote Build: Configure` で接続先・転送対象・ビルド構成を設定し、`Sync and Build` を実行します。

ローカルにSSH・rsync、接続先にDockerとEclipse CDT・クロスツールチェーン入りの起動済みコンテナが必要です。転送先ディレクトリをコンテナの `/workspace` にマウントしてください。

設定は `.vscode/eclipse-remote-build.json` に保存します。転送元のパスはワークスペース基準です。

アーカイブの自動展開とコンテナの自動起動は未実装です。
