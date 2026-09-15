# v0.7.1 の実機確認手順（/model /effort /restart）

2026-09-05 に PR #50・#51 をマージした分の動作確認。上から順にやる。
結果はこのファイルの各項目の末尾に「OK / NG（現象）」を書き足していく。

## 0. 前提

- `~/.local/bin/discord-start` は今回変更していないので、コピーし直しは不要
- `/model` の引数指定は **デフォルト設定として保存される**。テスト後は必ず fable に戻す（手順 3-4）
- 検証中は `--channels` 付き claude を 2 つ立てない

## 1. プラグインを更新する（ターミナル）

```sh
cd ~/Desktop/work/discord-workspace
claude plugin update discord-bot@ryuki-plugins --scope project
claude plugin list | grep -A2 discord-bot   # Version: 0.7.1 になっていること
```

- [ ] 0.7.1 になった

## 2. 常駐セッションを起動し直す（ターミナル）

channel サーバーのコードを変えたので `/reload-plugins` では入れ替わらない。

```sh
tmux attach -t discord      # 常駐セッションで /exit
cd ~/Desktop/work/discord-workspace
DISCORD_BOT_CHANNEL_MODE=fork discord-start
```

起動ログで確認すること:

- [ ] `Channel notifications registered` が出る
- [ ] `commands: registered 5 command(s)` に `/model /effort /restart` が含まれる（`~/.claude/discord-bot/commands.json` の分も足される）
- [ ] Discord で `/` を打つと model / effort / restart が候補に出る

## 3. /model（Discord）

1. `/model alias:sonnet` を送る
   - [ ] 「/model sonnet を送ったよ（今は Fable 5.1 / effort high）。次のメッセージから切り替わるよ。ターミナルで新しく開くセッションのデフォルトも変わるよ」が通常メッセージで返る
   - [ ] 90 秒以内に「モデルを Sonnet 5 に切り替えたよ（effort ...）」が届く
     - 届かなくても切り替え自体は効く（statusline のダンプが /model 直後に更新されない場合）。届かなかったら **その旨をメモ**（フォローアップで検知方法を変える）
2. 何かメッセージを送る
   - [ ] Sonnet で応答する（`/ctx` の出力のモデル名、または Bot ステータス 2 行目が `Sonnet 5 · effort ...`）
3. 無効な値 `/model alias:gpt-5` を送る
   - [ ] 本人にだけ見える形で「使えないモデル指定だよ」が返り、ペインには何も送られない（tmux の画面に `/model gpt-5` が打たれていない）
4. **`/model alias:fable` で戻す**
   - [ ] 戻った（次のメッセージが Fable 5.1）
   - [ ] `grep model ~/.claude/settings.json` がテスト前と同じ値

## 4. /effort（Discord）

1. `/effort level:low` を送る
   - [ ] 受付メッセージが返る
   - [ ] 「effort を low に切り替えたよ（Fable 5.1）」が届く（effort は即時反映が公式に明記されているので、こちらは届くはず）
   - [ ] Bot ステータス 2 行目が `Fable 5.1 · effort low` になる
2. `/effort level:max` を送る
   - [ ] 受付メッセージに「max はこのセッション限りだよ」が付く
3. 無効な値 `/effort level:ultra` を送る
   - [ ] 本人にだけ NG が返る
4. **`/effort level:high` で戻す**（low〜xhigh はモデルごとに保存されるため）
   - [ ] 戻った

## 5. /restart（Discord）

事前に別ターミナルでログを流しておくと分かりやすい:

```sh
tail -f ~/.claude/discord-bot/restart.log
```

1. `/restart` を送る
   - [ ] 「再起動するね（会話は引き継がない）。終わったらこのチャンネルに通知するよ」が返る
   - [ ] 1 秒後に tmux ペインへ `/exit` が打たれ、claude が終了する（ログに「claude (pid ...) が終了した」）
   - [ ] ログに `claude update` の結果と更新前後のバージョンが出る
   - [ ] tmux セッション `discord` に新しいウィンドウ（または新しいセッション）で claude が起動する
   - [ ] 起動画面に `Channel notifications registered` が出る
   - [ ] Discord に「再起動したよ（2.1.261 → 2.1.xxx）」または「再起動したよ（2.1.261、更新なし）」が届く
   - [ ] 何かメッセージを送ると新しいセッションとして応答する
2. `/restart resume:yes` を送る
   - [ ] 「再起動するね（会話を引き継ぐ）」が返る
   - [ ] 起動後に「直前の会話を引き継いでいるよ」が届く
   - [ ] 直前の話題を覚えている
3. ターミナルで `/exit`
   - [ ] 起動し直さず、tmux のウィンドウが閉じるだけ（今までどおり）
   - [ ] `ls ~/.claude/discord-bot/` に `restart-done.json` が残っていない

## 6. 既存機能が壊れていないこと

- [ ] `/ctx` が今までどおり返る
- [ ] `/clear` が今までどおり動き、「コンテキストをクリアしたよ」が届く
- [ ] `/task`（ワークスペース側の追加コマンド）が今までどおり Claude に届く

## NG だったときに集めるもの

- `~/.claude/discord-bot/restart.log`（/restart）
- 常駐セッションの起動画面と、tmux ペインに何が打たれたか（`tmux capture-pane -p -t discord`）
- channel サーバーの stderr は claude の起動画面には出ない。`/restart` や `/model` の受付メッセージが返らないときは、Discord 側の「アプリケーションが応答しませんでした」の有無をメモ
- `~/.claude/tmp/statusline/<session_id>.json` の `model` と `effort` と `_dumped_at`（切り替え検知が来ないとき）

## 終わったら

- このファイルを消すか、結果を書き込んで commit する
- CLAUDE.md の「現在の状況」の「実機での動作確認は未実施」を更新する
- 通知が来なかった項目があれば issue を立てる（例: /model の切り替え検知方法の見直し）
