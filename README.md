# Eclipse Remote Build

SSHで差分転送し、Docker内のEclipse CDTでビルドするVS Code拡張。

**[VSIX 0.3.0](packages/eclipse-remote-build-0.3.0.vsix?raw=true)** を「VSIXからのインストール」で導入し、左の **Eclipse Build** アイコンから開きます。

設定画面と左ペインは同じ編集中の設定・選択プロファイルで実行します。ファイルへの保存は「設定を保存」。外部の構成JSONは適用値と適用元を表示し、実行開始時の内容を固定して転送・ビルドします。選択したプロファイルだけを編集します。

「Dockerへデプロイ」でアーカイブ転送・イメージ構築・コンテナ起動まで実行します。既存コンテナの置換には確認を表示します。

ローカルにSSH・rsync、接続先に起動済みDocker Engine・rsyncが必要です。鍵とホスト鍵は事前設定してください。WindowsではWSL側で開きます。

設定: `.vscode/eclipse-remote-build.json`。ソース・構成JSON・アーカイブはワークスペース相対。追加引数・環境変数の `${workspaceFolder}` は `/workspace` に解決します。TAR/ZIPの展開先・除去階層数を指定できます。独自DockerfileにはPython 3.12相当の `tarfile.data_filter` が必要です。

生成物回収・削除ソースのリモート削除は行いません。キャンセルはSSHを停止し、リモート処理の終了までは保証しません。

ソースから作成: `npm install && npm run package`。
