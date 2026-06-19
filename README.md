# Monsters

バトルえんぴつ風の2人対戦サイコロバトル。詳細仕様は [DESIGN.md](./DESIGN.md)。

フェーズ1（ローカル）＋ フェーズ2（オンライン対戦）実装。ビルド不要の Vanilla JS（ES モジュール）＋ Node/ws の結合サーバー。

## 遊ぶ（ローカルのみ）

ES モジュールは `file://` では動かないため、簡易サーバ経由で開く:

```bash
npx serve .          # など任意の静的サーバ
# → http://localhost:3000 を開く
```

## 遊ぶ（オンライン対応・推奨）

結合サーバーを1つ起動すれば、静的配信・WebSocket・/health がすべて同じプロセスで動く:

```bash
npm install          # 初回のみ（ws を取得）
npm start            # node server/server.js
# → http://localhost:8080 を2つのタブ/端末で開く
```

`index.html` を開くと タイトル → 対戦形態 → ルールモード → モンスター作成 → 先攻決定 → バトル → 結果 と進む。

**オンライン2人**を選ぶと:
- **ルームを作成**: ルール（モード/予算）を決めてモンスターを作ると4桁コードが発行される。相手に伝える
- **ルームに参加**: コードを入力 → ホストと同じルールで自分のモンスターを作成 → 参加
- 2人揃うと自動で先攻決定 → 対戦。**ダイスとバランス検証はサーバー権威**（チート防止）。手番側だけ「サイコロを振る」が押せる
- 終了後「もう一度（再戦）」で両者合意により同じ編成で再戦

## 構成

| ファイル | 役割 |
|----------|------|
| `src/models.js` | 型・デフォルト値・定数（FORM_DISCOUNT 等） |
| `src/rules.js` | コスト計算・`validateMonster`・ランダム生成（純粋関数） |
| `src/game.js` | 戦闘コア。`createGame`/`rollInitiative`/`applyAction`/`checkWinner`（純粋関数） |
| `src/image.js` | `processImage`（canvas で長辺1024px縮小・非同期）/ `defaultAvatar`（頭文字アバター） |
| `src/export.js` | `.monst`(zip) 書出/読込（JSZip 使用） |
| `src/storage.js` | localStorage 保存（画像は data URL 化して永続化） |
| `src/ui.js` | DOM 描画・作成エディタ・予算バー |
| `src/main.js` | 画面遷移の制御（ローカル＋オンライン） |
| `src/presets.js` | CPU 用同梱モンスター |
| `src/net.js` | WebSocket クライアント（コールドスタート対応の接続/送受信） |
| `server/server.js` | 結合サーバー: 静的配信 + WS(/ws) + /health。`game.js`/`rules.js` を流用 |

ゲームロジック（`game.js`/`rules.js`）は UI/通信から完全分離。サーバーは同じコードで権威ある判定・コスト検証を行う。

### オンライン通信プロトコル（WS /ws、JSON）

| 方向 | メッセージ |
|------|-----------|
| C→S | `create{ruleConfig,monster}` / `peek{code}` / `join{code,monster}` / `resume{code,token}` / `roll` / `rematch` |
| S→C | `created{code,token,you}` / `roomInfo{code,ruleConfig}` / `start{you,code,token,state}` / `rolled{roll,state}` / `resumed{you,code,token,ruleConfig,state}` / `rematchRequested` / `opponentDisconnected{graceMs}` / `opponentReturned` / `opponentLeft` / `error{message}` |

- ダイスはサーバー生成、`applyAction` もサーバーで実行し全クライアントへ配信
- バランスビルドはサーバーで必ず `validateMonster` を再検証（予算超過・マイナス面悪用を拒否）
- 手番外の `roll` は拒否

### 再接続（同一ルーム復帰）

- create/join 時にプレイヤーごとの `token` を発行。クライアントは `{code, token, you}` を sessionStorage に保存
- 切断しても即破棄せず**猶予期間**（既定60秒）保持。相手には `opponentDisconnected` を通知（復帰待ち表示）
- WS が落ちると自動で `resume{code,token}` を送って同一スロットに復帰し、現局面から再開（相手には `opponentReturned`）。ページをリロードした場合は起動時に「対戦に復帰しますか？」を表示
- 猶予を過ぎても戻らなければスイーパーがルームを破棄し、残った側に `opponentLeft` を通知

### 負荷時のクリーンアップ（メモリ解放）

定期スイーパー（既定15秒間隔）が次のルームを破棄する。`startServer({...})` で各値を上書き可能（テストは短く設定）。

| 設定 | 既定 | 内容 |
|------|------|------|
| `graceMs` | 60s | 切断後の復帰猶予。超過で破棄 |
| `waitingTtlMs` | 10分 | 相手が来ないまま放置されたルーム |
| `finishedTtlMs` | 5分 | 終了後の保持（再戦待ち） |
| `roomTtlMs` | 30分 | 無操作の最大保持 |
| `maxRooms` | 1000 | 同時ルーム上限（超過は `create` を拒否） |
| `sweepMs` | 15s | スイープ間隔 |

全員切断したルームは即時解放。これにより無料枠の小さいRAMでも多数のルームをさばける。

## テスト

```bash
npm test              # 純粋ロジック（rules + game）をコンソール検証（依存なし）
npm run sim           # ランダム生成同士の1試合をログ表示
npm run test:online   # WS 2クライアントでフル対戦・検証拒否・手番外拒否・切断通知
npm run test:browser  # puppeteer でローカル全画面遷移スモーク
node tests/online-e2e.mjs   # 実サーバー＋ブラウザ2タブでオンライン対戦を完走
```

`npm test`/`test:online` は依存なし〜ws のみ。`test:browser`/`online-e2e` は devDependencies（jszip, puppeteer）が必要。

## デプロイ（一度きり・以降コマンド不要）

一度デプロイすれば、**サーバー起動コマンドを毎回打つ必要はなく、ページURLを開くだけ**でローカル/CPU/オンライン対戦まで遊べる。2通りの構成がある。

### 構成A: GitHub Pages（ページ）＋ Render（WS サーバー）— 推奨

ページは GitHub Pages で常に即表示され、オンライン時だけ Render の WS サーバーに繋ぐ（ローカル/CPU 対戦やモンスター作成はサーバー不要なので常に即起動）。

1. **Render に WS サーバーをデプロイ**: ダッシュボードの「New +」→「Blueprint」で本リポジトリを選ぶ（`render.yaml` で自動構成）。払い出された URL の WS エンドポイント `wss://<name>.onrender.com/ws` を控える。
2. **接続先を設定**: `config.js` の `window.WS_URL` に上記 `wss://.../ws` を設定して `main` に push。
3. **GitHub Pages を有効化**: リポジトリ設定 → Pages → Source を「**GitHub Actions**」にする（`.github/workflows/pages.yml` が push ごとに自動公開）。
4. 以降 `https://<user>.github.io/<repo>/` を開くだけで対戦可能。Render とフロントは別オリジンだが WS は問題なく繋がる。

### 構成B: Render 単体（最小構成）

結合サーバーが静的配信も兼ねるので、Render の **Web サービス1つ**だけで完結する。`config.js` は空（`window.WS_URL = ""`）のままでよい（同一オリジン `/ws` に繋ぐ）。`https://<name>.onrender.com` を開くだけ。GitHub Pages は不要。

### 共通の注意

- Render: Build `npm install` / Start `npm start`（`PORT` を自動使用）。`render.yaml` 同梱で Blueprint なら設定不要。
- keep-alive は入れない（スリープ許容）。15分無アクセスでスリープし、次接続時はコールドスタートで30〜50秒かかり得るため、クライアントは「サーバーを起こしています…」を表示しつつ最大75秒リトライする。
- 死活確認用に `GET /health` を用意（常時 ping はしない）。
- WS 接続先は `config.js` の `window.WS_URL` のほか、`?ws=wss://...` クエリでも上書き可能（テスト用）。
