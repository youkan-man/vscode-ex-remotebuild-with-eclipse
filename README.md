# Eclipse Remote Build

SSHでソースを差分転送し、Docker内のEclipse CDTでビルドするVS Code拡張。

**[VSIXをダウンロード](packages/eclipse-remote-build-0.2.1.vsix?raw=true)** → VS Codeの「拡張機能 → … → VSIXからのインストール」。

`Eclipse Remote Build: Configure` でSSH接続先・転送先・Eclipseとツールチェーンのアーカイブを設定します。**「Dockerへデプロイ」** がアーカイブ転送、イメージ構築、コンテナ作成・起動、起動確認まで実行します。既存環境の置換時だけ確認します。その後「同期してビルド」で実行します。

ローカルにSSHとrsync、接続先に起動済みDocker Engineとrsyncが必要です。SSH鍵とホスト鍵を事前に設定してください。WindowsではVS CodeをWSLで開いて使用します。Docker Engine自体のインストールは行いません。

設定は `.vscode/eclipse-remote-build.json`。ソース・アーカイブ・構成JSONのパスはワークスペース基準です。追加引数・環境変数の `${workspaceFolder}` は `/workspace` に解決します。

Dockerfileは空欄で内蔵のUbuntu構成を使用。独自DockerfileにはPython 3.12相当の `tarfile.data_filter` と `python3` が必要で、ビルドコンテキストには指定アーカイブだけを転送します。TARとZIPの展開先・除去する先頭階層数を指定できます。

生成物の回収と削除したソースのリモート削除は行いません。キャンセルはSSHを停止しますが、リモートビルドの終了までは保証しません。

ソースからの作成: `npm install && npm run package`。ルートに `eclipse-remote-build-0.2.1.vsix` を出力します。
