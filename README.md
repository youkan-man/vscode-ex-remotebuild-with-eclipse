# Eclipse Remote Build

SSHで差分転送し、Docker内のEclipse CDTでビルドするVS Code拡張。

[VSIX 0.3.0](packages/eclipse-remote-build-0.3.0.vsix?raw=true) を「VSIXからのインストール」で導入します。左の **Eclipse Build** アイコンから操作できます。

左ペインと設定画面は同じ編集中の設定を使います。実行では自動保存せず、保存は「設定を保存」で行います。構成JSONは適用値を画面に表示し、転送内容とビルド構成を実行単位で固定します。設定途中のアーカイブは保存でき、同期・ビルドには影響しません。

設定は `.vscode/eclipse-remote-build.json`。ソース・アーカイブ・構成JSONはワークスペース基準です。追加引数・環境変数の `${workspaceFolder}` は `/workspace` に解決します。

「Dockerへデプロイ」でイメージ構築・アーカイブ展開・コンテナ起動まで行います。既存コンテナの置換時は確認します。ローカルにSSH・rsync、接続先にDocker Engine・rsyncとSSH鍵設定が必要です。WindowsではWSLで開いて使用します。

Dockerfileは空欄で内蔵Ubuntuを使用。独自Dockerfileは `python3` と `tarfile.data_filter` が必要です。ビルドコンテキストには指定アーカイブだけを転送します。生成物の回収・リモートソース削除は行いません。キャンセル後のリモート処理終了は未保証です。

開発: `npm install && npm test && npm run package`
