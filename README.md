# kiokuflow-gdrive

kiokuflow Desktopのactive Workspace全体を、kiokuflowが利用するGoogle Driveルートと同期するPluginです。kiokuflowと同じ`_sync-meta.json`、Migration Tool token、暗号化済みrefresh tokenを使用します。

![kiokuflow Google Drive Syncの同期前画面](before_sync.png)

![Pull対象ファイルのプレビュー](pull.png)

## 旧 gemihub-gdrive からの移行

旧 GemiHub のサービス名変更に伴い、このプラグインも `kiokuflow-gdrive` に改名しました。接続先サービスは [kiokuflow](https://kiokuflow.net)、GitHub リポジトリは `takeshy/kiokuflow-gdrive` です。

プラグイン ID が変わるため、Desktop では別のプラグインとして扱われます。

1. 旧プラグインを無効にし、Desktop を終了する。新旧プラグインは同時に有効にしない。
2. 対象 Workspace の `.llm-hub/plugin-data/gemihub-gdrive.json` をバックアップする。
3. 同じ Drive ルート・認証先へ引き続き接続する場合は、そのファイルを `.llm-hub/plugin-data/kiokuflow-gdrive.json` へコピーする。接続情報、同期状態、除外設定を引き継げます。既存の移行先ファイルがある場合は上書きしないでください。
4. Desktop で `takeshy/kiokuflow-gdrive` の新しいリリースをインストールして有効にし、`Check` で接続先と同期内容を確認する。

サービス URL・OAuth・Drive の移行で認証先、ルート、ファイル ID が変わった場合は、旧接続・同期状態をコピーせず、移行完了後の kiokuflow で新しい同期トークンを生成して接続し直してください。除外設定は別途設定し、初回の Pull/Push 前に差分を確認してください。

同期形式と共有依存ライブラリ `gemihub-sync-core` は維持しています。競合バックアップは `KiokuFlow/conflict-backups/` に保存します。同期チェック時に旧 `GemiHub/` の内容を `KiokuFlow/` へ自動移行し、同名ファイルは旧側の内容で上書きします。両フォルダは同期対象外です。差分表示設定の保存キーは維持しています。

## 動作

- 1つのDesktop Workspaceを1つのkiokuflow Driveルートへ固定して接続
- Workspaceのファイルツリーに表示される通常ファイルを同期
- `.git/`、`.llm-hub/`、`node_modules/`、kiokuflow system files/foldersは除外
- Pluginの設定画面から任意の除外パターンを追加設定可能（folder名末尾に`/`、`*`/`?`によるワイルドカードに対応。ローカル/Driveどちら側の対象ファイルも同期対象から外れる）
- Google Docs、Sheets、Slidesなど`application/vnd.google-apps.*`のネイティブファイルは除外（PDF、DOCX、XLSXなど実体を持つexport済みファイルは同期）
- text/binary、pathを含むflat Drive filename、renameに対応
- Pullはlocalに未Pushの変更があっても実行可能（該当ファイルはスキップして保持）
- 両側で変更されたファイルはconflictとしてファイルごとに`Keep local` / `Keep remote`で解消（既定では選ばれなかった側をローカルの`KiokuFlow/conflict-backups/`へタイムスタンプ付きでバックアップ。このフォルダは同期対象外）
- Driveに同じパスのファイルが複数ある場合は、`Check` → `View all copies`で内容・更新日時・IDを確認し、`Keep this copy`で残すコピーを選択（他のコピーはkiokuflowの`trash`へ退避。ローカルは変更せず、通常のPull/競合解決で反映）
- Pushによるremote削除はkiokuflowの`trash/`へ移動
- Pullによるlocal削除は実行前に確認
- Pull/Pushは実行前にnew、modified、deleted、conflictの対象ファイル一覧を表示
- CheckでStatus表示後、`Local changes`/`Remote changes`/`Push deletes`/`Pull deletes`のラベルをクリックすると対象ファイル一覧を表示
- Pullは最大5ファイルを並列処理し、処理件数と現在のpathを表示
- `Full pull` は確認後に Drive を正としてローカルを揃え、同期履歴を現在の Drive ID で作り直す。同じパス・MD5 のファイルは取得・再書き込みを省略し、内容が異なるファイルを上書きする。Drive にないローカルファイルは削除する。通常 Pull の競合や旧 ID の履歴をリセットしたい場合に使用

## kiokuflow側の準備

1. kiokuflowの暗号化を有効にする
2. `設定 → 同期 → 外部同期`から同期トークンを生成する
3. Desktopで同期したいWorkspaceを選択する
4. PluginのDrive Sync viewへtokenを貼り付ける
5. kiokuflowの暗号化passwordでunlockする

token生成時に`_encrypted-auth.json`がDriveへ出力されます。token自体は短時間で失効しますが、Pluginは暗号化されたrefresh tokenをPlugin storageへ保存し、以後kiokuflowのtoken refresh endpointを利用します。

## Build

```bash
npm install
npm run check
npm test
npm run build
```

GitHub Releaseにはrepository rootの`manifest.json`、build後の`main.js`、`styles.css`をassetとして添付します。tagはmanifest versionと一致する`v0.1.2`形式にしてください。
