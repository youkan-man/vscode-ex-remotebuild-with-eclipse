# Eclipse Remote Build

SSHでソースを差分転送し、Docker内のEclipse CDTでビルドするVS Code拡張。

`npm install && npm run package` でVSIXを作成し、VS Codeの「VSIXからのインストール」で導入します。

`Eclipse Remote Build: Configure` で接続先・転送対象・アーカイブ・ビルド構成を指定します。「環境を構築・起動」でEclipseとツールチェーンを展開し、「同期してビルド」で実行します。

ローカルにSSHとrsync、接続先にDockerとrsyncが必要です。SSH鍵とホスト鍵を事前に設定してください。WindowsではVS CodeをWSLで開いて使用します。

設定は `.vscode/eclipse-remote-build.json`。ソース・アーカイブ・構成JSONのパスはワークスペース基準です。構成JSON内のパスも同じ基準です。追加引数・環境変数の `${workspaceFolder}` はコンテナ内の `/workspace` に解決します。

Dockerfileは空欄で内蔵のUbuntu構成を使用します。独自Dockerfileのビルドコンテキストには指定アーカイブだけを転送します。Python 3.12相当の `tarfile.data_filter` と `python3` コマンドが必要です。展開先・先頭階層の除去はTARとZIPの両方で指定できます。

既存コンテナの置換には確認を表示します。削除したソースのリモート削除と生成物の回収は行いません。キャンセルはSSHプロセスを停止しますが、リモートビルドの終了までは保証しません。
