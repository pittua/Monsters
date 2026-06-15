// main.js — 画面遷移の制御。各画面を描画し、戦闘コア(game.js)を駆動する。
import { defaultRuleConfig, defaultMonster } from "./models.js";
import { generateRandomMonster, validateMonster } from "./rules.js";
import {
  createGame, rollInitiative, rollDice, applyAction, isCurrentTurnCpu, currentCharacter,
} from "./game.js";
import { downloadMonster, importMonster } from "./export.js";
import { saveMonster, listMonsters, loadMonster, deleteMonster, saveRuleConfig, loadRuleConfig } from "./storage.js";
import { getPresets } from "./presets.js";
import { displaySrc } from "./image.js";
import { connect } from "./net.js";
import {
  el, mount, clear, toast, hpBar, renderMonsterEditor, renderBudgetBar,
  animateDiceRoll, makeDice, setDiceFace, renderMoveList,
} from "./ui.js";

const screen = document.getElementById("screen");
document.getElementById("logo").addEventListener("click", showTitle);

const app = {
  matchType: null,
  ruleConfig: null,
  monsters: [null, null],
  game: null,
  // --- オンライン用 ---
  conn: null,         // net.js の接続
  isOnline: false,    // 現在オンライン対戦中か
  you: null,          // 自分のプレイヤー index (0/1)
  onlineRole: null,   // "create" | "join"
  joinCode: null,     // 参加時のルームコード
  session: null,      // 再接続用 { code, token, you }
  resuming: false,    // 再接続処理中フラグ（多重防止）
};

// --- 再接続セッションの永続化（タブ単位） ---
const SESSION_KEY = "monsters.session";
function saveSession(s) {
  app.session = s;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}
function loadSession() {
  if (app.session) return app.session;
  try { const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
function clearSession() {
  app.session = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

// ============ 1. タイトル ============
function showTitle() {
  app.game = null;
  leaveOnline();
  mount(screen, el("div", { className: "title-screen" }, [
    el("div", { className: "title-dice", text: "🎲" }),
    el("h1", { className: "title-logo", text: "MONSTERS" }),
    el("p", { className: "tagline", text: "サイコロの出目で戦う、バトルえんぴつ風モンスター対戦" }),
    el("button", { className: "primary big play-btn", text: "▶  あそぶ", onClick: showMatchType }),
  ]));
}

// ============ 2. 対戦形態選択 ============
function showMatchType() {
  const card = (icon, title, desc, type, onClick) => el("button", {
    className: "choice-card panel",
    onClick,
  }, [
    el("div", { className: "choice-icon", text: icon }),
    el("h3", { text: title }),
    el("p", { text: desc }),
  ]);

  const local = (type) => () => { app.matchType = type; app.isOnline = false; showMode(); };

  mount(screen, el("div", { className: "stack" }, [
    el("h2", { className: "screen-title", text: "対戦形態をえらぶ" }),
    el("div", { className: "choice-grid" }, [
      card("👥", "ローカル2人", "友達と同じ画面で交互に対戦", "local", local("local")),
      card("🤖", "CPU対戦", "相手はCPU（保存済み/プリセット/ランダム）", "cpu", local("cpu")),
      card("🎯", "練習対戦", "2体とも自分で操作してバランス検証", "practice", local("practice")),
      card("🌐", "オンライン2人", "離れた相手とルームコードで対戦", "online", () => { app.matchType = "online"; showOnlineLobby(); }),
    ]),
    backRow(showTitle),
  ]));
}

// ============ 3. モード選択 ============
function showMode() {
  const saved = loadRuleConfig();
  const card = (icon, title, desc, mode) => el("button", {
    className: "choice-card panel",
    onClick: () => {
      app.ruleConfig = saved && saved.mode === mode ? saved : defaultRuleConfig(mode);
      app.ruleConfig.mode = mode;
      saveRuleConfig(app.ruleConfig);
      showBuild();
    },
  }, [el("div", { className: "choice-icon", text: icon }), el("h3", { text: title }), el("p", { text: desc })]);

  mount(screen, el("div", { className: "stack" }, [
    el("h2", { className: "screen-title", text: "ルールモードをえらぶ" }),
    el("div", { className: "choice-grid" }, [
      card("🎨", "フリービルド", "制限なし。HPも効果量も自由（ロマン重視）", "free"),
      card("⚖️", "バランスビルド", `予算 ${defaultRuleConfig("balance").budget}pt 内で組むコスト制（対人公平）`, "balance"),
    ]),
    backRow(showMatchType),
  ]));
}

// ============ 4. モンスター作成 ============
function showBuild() {
  const cfg = app.ruleConfig;
  const online = app.matchType === "online";
  app.monsters[0] = app.monsters[0] || defaultMonster("");
  // P2: cpu はチューザ、オンラインは相手がサーバー越し。それ以外は自前エディタ
  const p2IsCpu = app.matchType === "cpu";
  if (!p2IsCpu && !online) app.monsters[1] = app.monsters[1] || defaultMonster("");

  const container = el("div", { className: "stack" });

  // 予算バー（P1基準で表示。両者ともbalanceなら各自チェックは開始時に行う）
  const budgetBar = renderBudgetBar(() => app.monsters[0], cfg);

  // --- P1 エディタ ---
  const p1Title = (app.matchType === "practice") ? "プレイヤー1（自分A）" : "あなたのモンスター";
  const editor1 = renderMonsterEditor(app.monsters[0], cfg, () => budgetBar.update(), p1Title);
  const p1Tools = playerTools(0);

  // --- P2（オンラインは自分の1体のみ作成） ---
  let p2Section = null;
  if (!online) {
    if (p2IsCpu) {
      p2Section = renderCpuChooser(cfg);
    } else {
      const p2Title = (app.matchType === "practice") ? "プレイヤー2（自分B）" : "相手のモンスター（P2）";
      const editor2 = renderMonsterEditor(app.monsters[1], cfg, () => {}, p2Title);
      p2Section = el("div", {}, [playerTools(1), editor2]);
    }
  }

  let startBtn;
  if (online) {
    startBtn = el("button", {
      className: "primary big",
      text: app.onlineRole === "create" ? "🌐 ルームを作成" : "🌐 参加する",
      onClick: app.onlineRole === "create" ? onlineCreate : onlineJoin,
    });
  } else {
    startBtn = el("button", { className: "primary big", text: "バトル開始！", onClick: startBattle });
  }

  mount(screen, container);
  container.appendChild(budgetBar);
  if (online) container.appendChild(el("p", { className: "muted", text: app.onlineRole === "create" ? "あなたのモンスターを用意してルームを作成します。コードを相手に伝えてください。" : `ルーム ${app.joinCode} に参加します。ホストと同じルール「${cfg.mode === "balance" ? "バランスビルド" : "フリービルド"}」で作成してください。` }));
  container.appendChild(el("div", {}, [p1Tools, editor1]));
  if (p2Section) container.appendChild(p2Section);
  container.appendChild(el("div", { className: "row" }, [
    backRow(online ? showOnlineLobby : showMode, true),
    el("div", { className: "spacer" }),
    startBtn,
  ]));
  budgetBar.update();

  // プレイヤーごとの 読込/書出/保存 ツールバー
  function playerTools(idx) {
    const fileInput = el("input", {
      type: "file", accept: ".monst,application/zip", className: "hidden",
      onChange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          app.monsters[idx] = await importMonster(f);
          toast("読み込みました");
          showBuild();
        } catch (err) { toast(err.message || "読み込み失敗", true); }
      },
    });
    return el("div", { className: "row" }, [
      el("button", { className: "ghost", text: "📂 .monst 読み込み", onClick: () => fileInput.click() }),
      fileInput,
      el("button", { className: "ghost", text: "💾 .monst 書き出し", onClick: () => downloadMonster(app.monsters[idx]) }),
      el("button", { className: "ghost", text: "⭐ 保存", onClick: async () => { await saveMonster(app.monsters[idx]); toast("保存しました"); } }),
      el("button", { className: "ghost", text: "📥 保存済みから", onClick: () => openSavedPicker(idx) }),
    ]);
  }
}

// 保存済みモンスター選択モーダル（簡易: 画面差し替え）
function openSavedPicker(idx) {
  const items = listMonsters();
  const list = el("div", { className: "saved-list" },
    items.length ? items.map((it) => el("div", { className: "saved-item" }, [
      el("span", { className: "name", text: `${it.name}（${it.formCount}フォーム）` }),
      el("button", { text: "使う", onClick: () => { app.monsters[idx] = loadMonster(it.id); showBuild(); } }),
      el("button", { className: "danger ghost", text: "削除", onClick: () => { deleteMonster(it.id); openSavedPicker(idx); } }),
    ])) : [el("p", { className: "muted", text: "保存済みモンスターはありません" })]
  );
  mount(screen, el("div", { className: "stack" }, [
    el("h2", { text: "保存済みから読み込み" }),
    el("div", { className: "panel" }, [list]),
    backRow(showBuild),
  ]));
}

// CPU相手チューザ（保存済み / プリセット / ランダム生成）
function renderCpuChooser(cfg) {
  const status = el("div", { className: "muted", text: "相手が未選択です" });

  function setOpponent(monster, label) {
    app.monsters[1] = monster;
    status.textContent = `相手: ${label}（${monster.forms[0].name || "無名"}）`;
  }

  const presetButtons = getPresets().map((p) =>
    el("button", { className: "ghost", text: p.name, onClick: () => setOpponent(p.monster, "プリセット") }));

  const savedButtons = listMonsters().map((it) =>
    el("button", { className: "ghost", text: it.name, onClick: () => setOpponent(loadMonster(it.id), "保存済み") }));

  return el("div", { className: "panel stack" }, [
    el("h2", { text: "CPUの相手をえらぶ" }),
    status,
    el("div", {}, [
      el("label", { text: "ランダム自動生成" }),
      el("div", { className: "row" }, [
        el("button", { className: "primary", text: "🎲 ランダム生成", onClick: () => setOpponent(generateRandomMonster(cfg), "ランダム") }),
      ]),
    ]),
    el("div", {}, [
      el("label", { text: "プリセット同梱" }),
      el("div", { className: "row" }, presetButtons),
    ]),
    el("div", {}, [
      el("label", { text: "保存済みから" }),
      el("div", { className: "row" }, savedButtons.length ? savedButtons : [el("span", { className: "muted", text: "なし" })]),
    ]),
  ]);
}

// ============ オンライン対戦 ============

function showOnlineLobby() {
  leaveOnline();
  const card = (icon, title, desc, onClick) => el("button", { className: "choice-card panel", onClick }, [
    el("div", { className: "choice-icon", text: icon }),
    el("h3", { text: title }), el("p", { text: desc }),
  ]);
  mount(screen, el("div", { className: "stack" }, [
    el("h2", { className: "screen-title", text: "オンライン2人" }),
    el("div", { className: "choice-grid" }, [
      card("🆕", "ルームを作成", "ルールを決めてモンスターを作り、コードを発行", () => { app.onlineRole = "create"; showMode(); }),
      card("🔑", "ルームに参加", "相手のコードを入力して参加", () => { app.onlineRole = "join"; showJoinCode(); }),
    ]),
    backRow(showMatchType),
  ]));
}

function showJoinCode() {
  const input = el("input", {
    type: "text", placeholder: "ABCD", maxlength: "4",
    style: { textTransform: "uppercase", width: "200px", fontSize: "1.6rem", letterSpacing: ".4em", textAlign: "center" },
  });
  const go = () => {
    const code = (input.value || "").trim().toUpperCase();
    if (code.length < 4) { toast("4桁のコードを入力してください", true); return; }
    app.joinCode = code;
    connectThen(() => app.conn.send({ type: "peek", code }));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  mount(screen, el("div", { className: "stack center" }, [
    el("h2", { className: "screen-title", text: "ルームに参加" }),
    el("p", { className: "muted", text: "ホストから共有されたルームコードを入力" }),
    el("div", { className: "panel", style: { display: "inline-block" } }, [input]),
    el("div", { className: "row", style: { justifyContent: "center" } }, [
      el("button", { className: "primary big", text: "接続する", onClick: go }),
    ]),
    backRow(showOnlineLobby),
  ]));
}

let connectingMsg = null;
function showConnecting(title, sub) {
  connectingMsg = el("p", { className: "muted", text: "サーバーに接続しています…" });
  mount(screen, el("div", { className: "stack center" }, [
    el("div", { className: "title-dice", text: "🎲" }),
    el("h2", { text: title || "サーバーを起こしています…" }),
    el("p", { className: "muted", text: sub || "初回は最大1分ほどかかることがあります（無料枠のスリープ復帰）" }),
    connectingMsg,
  ]));
}
function updateConnecting(n) {
  if (connectingMsg) connectingMsg.textContent = `接続を試みています…（${n}回目）`;
}

// 接続を確保してから afterOpen を実行（コールドスタート演出つき）
async function connectThen(afterOpen) {
  if (app.conn && app.conn.open) { afterOpen(); return; }
  showConnecting();
  try {
    app.conn = await connect(
      { onMessage: netDispatch, onClose: onNetClose, onError: () => {} },
      { onAttempt: (n) => updateConnecting(n) }
    );
    afterOpen();
  } catch {
    mount(screen, el("div", { className: "stack center" }, [
      el("h2", { text: "接続できませんでした" }),
      el("p", { className: "muted", text: "サーバーが起動しているか確認してください。" }),
      backRow(showOnlineLobby),
    ]));
  }
}

function onlineCreate() {
  const cfg = app.ruleConfig;
  if (cfg.mode === "balance") {
    const v = validateMonster(app.monsters[0], cfg);
    if (!v.ok) { toast(v.errors[0], true); return; }
  }
  connectThen(() => app.conn.send({ type: "create", ruleConfig: cfg, monster: app.monsters[0] }));
}

function onlineJoin() {
  const cfg = app.ruleConfig;
  if (cfg.mode === "balance") {
    const v = validateMonster(app.monsters[0], cfg);
    if (!v.ok) { toast(v.errors[0], true); return; }
  }
  if (!app.conn || !app.conn.open) { toast("接続が切れました。やり直してください", true); showOnlineLobby(); return; }
  app.conn.send({ type: "join", code: app.joinCode, monster: app.monsters[0] });
  showWaiting(null, "対戦開始を待っています…");
}

function showWaiting(code, msg) {
  mount(screen, el("div", { className: "stack center" }, [
    el("h2", { className: "screen-title", text: "対戦相手を待っています" }),
    code ? el("div", { className: "panel", style: { display: "inline-block" } }, [
      el("p", { className: "muted", text: "このコードを相手に伝えてください" }),
      el("div", { style: { fontSize: "2.6rem", fontWeight: "800", letterSpacing: ".4em" }, text: code }),
    ]) : null,
    el("p", { className: "muted", text: msg || "相手の参加を待っています…" }),
    backRow(showTitle),
  ]));
}

function showOpponentLeft(message) {
  app.isOnline = false;
  mount(screen, el("div", { className: "stack center" }, [
    el("h2", { text: "対戦が終了しました" }),
    el("p", { className: "muted", text: message || "相手が退出しました" }),
    el("button", { className: "primary", text: "タイトルへ", onClick: showTitle }),
  ]));
}

// サーバー→クライアントのメッセージ処理
function netDispatch(msg) {
  switch (msg.type) {
    case "created":
      app.onlineRole = "create";
      app.you = 0;
      saveSession({ code: msg.code, token: msg.token, you: 0 });
      showWaiting(msg.code, "相手の参加を待っています…");
      break;
    case "roomInfo": // 参加: ホストのルールでビルド画面へ
      app.ruleConfig = msg.ruleConfig;
      app.onlineRole = "join";
      app.joinCode = msg.code;
      showBuild();
      break;
    case "start":
      app.isOnline = true;
      app.you = msg.you;
      app.game = msg.state;
      saveSession({ code: msg.code, token: msg.token, you: msg.you });
      startOnlineInitiative();
      break;
    case "resumed":
      onResumed(msg);
      break;
    case "rolled":
      onOnlineRolled(msg.roll, msg.state);
      break;
    case "rematchRequested":
      toast("相手が再戦を希望しています");
      break;
    case "opponentDisconnected":
      if (app.game && app.game.phase !== "finished") showOpponentWaiting(msg.graceMs);
      else toast("相手が切断しました");
      break;
    case "opponentReturned":
      toast("相手が復帰しました");
      if (app.isOnline && app.game) { if (app.game.phase === "finished") showResult(); else renderBattle(false); }
      break;
    case "opponentLeft":
      clearSession();
      showOpponentLeft(msg.message);
      break;
    case "error":
      if (app.resuming) { app.resuming = false; clearSession(); showResumeFailed(msg.message); break; }
      toast(msg.message || "エラーが発生しました", true);
      break;
    default:
      break;
  }
}

// 再接続で復帰したとき
function onResumed(msg) {
  app.resuming = false;
  app.you = msg.you;
  app.ruleConfig = msg.ruleConfig || app.ruleConfig;
  app.joinCode = msg.code;
  saveSession({ code: msg.code, token: msg.token, you: msg.you });
  if (!msg.state) {
    // まだ相手待ち（作成直後にリロード等）
    app.isOnline = false;
    showWaiting(msg.code, "相手の参加を待っています…");
    return;
  }
  app.isOnline = true;
  app.game = msg.state;
  toast("対戦に復帰しました");
  if (msg.state.phase === "finished") showResult();
  else renderBattle(false); // 演出なしで現局面から再開
}

function onNetClose() {
  app.conn = null;
  const session = loadSession();
  if (session && !app.resuming) { attemptResume(session); return; }
  if (app.isOnline && !app.resuming) {
    app.isOnline = false;
    showOpponentLeft("サーバーとの接続が切れました");
  }
}

// 切断→自動で同一ルームに復帰を試みる
async function attemptResume(session) {
  if (app.resuming) return;
  app.resuming = true;
  showConnecting("接続が切れました", "対戦への復帰を試みています…");
  try {
    app.conn = await connect(
      { onMessage: netDispatch, onClose: onNetClose, onError: () => {} },
      { onAttempt: (n) => updateConnecting(n) }
    );
    app.conn.send({ type: "resume", code: session.code, token: session.token });
    // 結果は netDispatch の "resumed" / "error" で処理（resuming はそこで解除）
  } catch {
    app.resuming = false;
    clearSession();
    showResumeFailed("サーバーに再接続できませんでした");
  }
}

function showResumeFailed(message) {
  app.isOnline = false;
  mount(screen, el("div", { className: "stack center" }, [
    el("h2", { text: "復帰できませんでした" }),
    el("p", { className: "muted", text: message || "対戦は終了している可能性があります" }),
    el("button", { className: "primary", text: "タイトルへ", onClick: showTitle }),
  ]));
}

// 相手が切断したとき（復帰待ち）
function showOpponentWaiting(graceMs) {
  const sec = Math.round((graceMs || 60000) / 1000);
  mount(screen, el("div", { className: "stack center" }, [
    el("div", { className: "title-dice", text: "🎲" }),
    el("h2", { text: "相手が切断しました" }),
    el("p", { className: "muted", text: `復帰を待っています…（最大${sec}秒）` }),
    el("button", { className: "ghost", text: "対戦をやめてタイトルへ", onClick: showTitle }),
  ]));
}

// 起動時: 復帰可能なセッションがあれば確認
function showResumePrompt(session) {
  mount(screen, el("div", { className: "stack center" }, [
    el("div", { className: "title-dice", text: "🎲" }),
    el("h2", { text: "対戦に復帰しますか？" }),
    el("p", { className: "muted", text: `ルーム ${session.code} の対戦が中断されています` }),
    el("div", { className: "row", style: { justifyContent: "center" } }, [
      el("button", { className: "primary big", text: "復帰する", onClick: () => attemptResume(session) }),
      el("button", { className: "ghost", text: "やめる", onClick: () => { clearSession(); showTitle(); } }),
    ]),
  ]));
}

function startOnlineInitiative() {
  const entry = app.game.log.find((l) => l.kind === "initiative");
  const d1 = makeDice(96), d2 = makeDice(96);
  const nameOf = (i) => app.game.players[i].monster.forms[0].name || `プレイヤー${i + 1}`;
  const youTag = (i) => (i === app.you ? "（あなた）" : "（相手）");
  const line = el("p", { className: "muted", text: "サイコロを振っています…" });
  mount(screen, el("div", { className: "stack center" }, [
    el("h2", { text: "先攻を決める" }),
    el("div", { className: "initiative-dice" }, [
      el("div", { className: "slot" }, [el("div", { className: "who", text: `P1: ${nameOf(0)}${youTag(0)}` }), d1]),
      el("div", { className: "slot" }, [el("div", { className: "who", text: `P2: ${nameOf(1)}${youTag(1)}` }), d2]),
    ]),
    line,
  ]));
  Promise.all([
    animateDiceRoll(d1, entry.rolls[0], 1100),
    animateDiceRoll(d2, entry.rolls[1], 1450),
  ]).then(() => {
    line.textContent = `🎲 P1: ${entry.rolls[0]} ／ P2: ${entry.rolls[1]} → ${entry.result.split("→")[1] || ""}`;
    setTimeout(showBattle, 900);
  });
}

// サーバーから出目つきの新状態が来たとき: ダイスを着地させてから反映
function onOnlineRolled(roll, state) {
  const finish = () => {
    isRolling = false;
    app.game = state;
    if (state.phase === "finished") showResult();
    else renderBattle(false, roll);
  };
  if (diceEl) animateDiceRoll(diceEl, roll).then(finish);
  else finish();
}

function leaveOnline() {
  if (app.conn) { try { app.conn.close(); } catch {} }
  app.conn = null;
  app.isOnline = false;
  app.resuming = false;
  app.you = null;
  app.onlineRole = null;
  app.joinCode = null;
  clearSession();
}

// ============ 5+6. バトル（先攻決定→対戦） ============
function startBattle() {
  const cfg = app.ruleConfig;
  if (!app.monsters[0] || !app.monsters[1]) { toast("両者のモンスターを用意してください", true); return; }

  // バランス時は両者の予算を検証
  if (cfg.mode === "balance") {
    for (let i = 0; i < 2; i++) {
      const v = validateMonster(app.monsters[i], cfg);
      if (!v.ok) { toast(`プレイヤー${i + 1}: ${v.errors[0]}`, true); return; }
    }
  }

  app.game = createGame(app.monsters[0], app.monsters[1], app.matchType);
  showInitiative();
}

function showInitiative() {
  // 先に結果を確定（内部で同値なら振り直し済み）。演出はその出目に着地させる。
  const next = rollInitiative(app.game);
  const entry = next.log.at(-1);

  const d1 = makeDice(96);
  const d2 = makeDice(96);
  const nameOf = (i) => app.monsters[i].forms[0].name || `プレイヤー${i + 1}`;

  const resultLine = el("p", { className: "muted", text: "サイコロを振っています…" });
  const goBtn = el("button", { className: "primary big", text: "バトルへ！", disabled: true, onClick: showBattle });

  mount(screen, el("div", { className: "stack center" }, [
    el("h2", { text: "先攻を決める" }),
    el("p", { className: "muted", text: "両者がダイスを振り、大きい方が先攻（同値なら振り直し）" }),
    el("div", { className: "initiative-dice" }, [
      el("div", { className: "slot" }, [el("div", { className: "who", text: `P1: ${nameOf(0)}` }), d1]),
      el("div", { className: "slot" }, [el("div", { className: "who", text: `P2: ${nameOf(1)}` }), d2]),
    ]),
    resultLine,
    goBtn,
  ]));

  // 2つのダイスを少しずらして着地させ、ドラマを出す
  Promise.all([
    animateDiceRoll(d1, entry.rolls[0], 1100),
    animateDiceRoll(d2, entry.rolls[1], 1450),
  ]).then(() => {
    app.game = next;
    resultLine.className = "";
    resultLine.textContent = `🎲 P1: ${entry.rolls[0]} ／ P2: ${entry.rolls[1]} → ${entry.result.split("→")[1] || entry.result}`;
    goBtn.disabled = false;
  });
}

function showBattle() {
  renderBattle(false);
  maybeCpuTurn();
}

function logEntryClass(entry) {
  if (entry.kind === "initiative") return "initiative";
  if (entry.action && entry.action.type === "transform") return "transform";
  if (entry.action && entry.action.type === "custom") return "custom";
  const r = entry.result || "";
  if (/自分に.*ダメージ|暴発|反動/.test(r)) return "self-harm";
  if (/回復/.test(r)) return "heal";
  return "";
}

let diceEl = null;

function renderBattle(rolling, lastRoll) {
  const g = app.game;
  const fighters = [0, 1].map((i) => {
    const p = g.players[i];
    const ch = currentCharacter(p);
    const isActive = g.turn === i && g.phase !== "finished";
    return el("div", { className: "fighter" + (isActive ? " active" : "") }, [
      el("img", { src: displaySrc(ch), alt: ch.name }),
      el("div", { className: "fname", text: `P${i + 1}: ${ch.name || "無名"}` }),
      p.monster.forms.length > 1 ? el("div", { className: "form-tag", text: `フォーム ${p.currentForm + 1}/${p.monster.forms.length}` }) : null,
      hpBar(p.hp, ch.maxHp),
      el("div", { className: "hp-text", text: `HP ${Math.max(0, p.hp)} / ${ch.maxHp}` + (p.guardValue ? `　🛡${p.guardValue}` : "") }),
    ]);
  });

  diceEl = makeDice(72);
  if (lastRoll) setDiceFace(diceEl, lastRoll);

  const arena = el("div", { className: "arena" }, [fighters[0], diceEl, fighters[1]]);

  const cpuTurn = isCurrentTurnCpu(g);
  let bannerText = "", bannerCls = "";
  if (g.phase !== "finished") {
    if (app.isOnline) bannerText = g.turn === app.you ? "▶ あなたの手番" : "相手の手番…";
    else if (cpuTurn) { bannerText = `CPU（P${g.turn + 1}）の手番…`; bannerCls = " cpu"; }
    else bannerText = `プレイヤー${g.turn + 1}の手番`;
  }
  const banner = el("div", { className: "turn-banner" + bannerCls }, bannerText);

  const myTurn = app.isOnline ? (g.turn === app.you) : !cpuTurn;
  const rollBtn = el("button", {
    className: "primary big", text: "サイコロを振る",
    disabled: rolling || !myTurn || g.phase === "finished",
    onClick: doRoll,
  });

  const log = el("div", { className: "log" },
    g.log.slice().reverse().map((e) => el("div", { className: "entry " + logEntryClass(e), text: formatLog(e) })));

  // 両者の技一覧（現フォーム）。直近に出た面を強調＋これまでに出た出目を集計してマーク。
  const counts = [[], []]; // counts[player][die] = 回数
  for (const l of g.log) {
    if (l.kind === "initiative") continue;
    counts[l.playerIndex][l.diceRoll] = (counts[l.playerIndex][l.diceRoll] || 0) + 1;
  }
  const lastAction = [...g.log].reverse().find((l) => l.kind !== "initiative");
  const hl = [null, null];
  if (lastAction) hl[lastAction.playerIndex] = lastAction.diceRoll;
  const moveLists = el("div", { className: "movelists" }, [
    renderMoveList(g.players[0], `P1: ${currentCharacter(g.players[0]).name || "無名"} の技`, hl[0], counts[0]),
    renderMoveList(g.players[1], `P2: ${currentCharacter(g.players[1]).name || "無名"} の技`, hl[1], counts[1]),
  ]);

  mount(screen, el("div", { className: "battle" }, [
    arena,
    banner,
    el("div", { className: "center" }, [rollBtn]),
    moveLists,
    el("h3", { text: "行動ログ" }),
    log,
  ]));
}

function formatLog(e) {
  if (e.kind === "initiative") return "🎲 " + e.result;
  return `手${e.turn} P${e.playerIndex + 1} 🎲${e.diceRoll}: ${e.result}`;
}

let isRolling = false;

function doRoll() {
  const g = app.game;
  if (g.phase === "finished" || isRolling) return;

  // オンライン: サーバーにロール要求。結果(出目+新状態)は rolled で受け取る。
  if (app.isOnline) {
    if (g.turn !== app.you) return;
    isRolling = true;
    app.conn.send({ type: "roll" });
    renderBattle(true);
    if (diceEl) diceEl.classList.add("rolling"); // 応答までダイスを回す
    return;
  }

  isRolling = true;
  const actor = g.turn;
  const roll = rollDice();

  renderBattle(true); // ボタン無効＋ダイス回転状態で再描画

  // サイコロを振っている演出 → 出目に着地 → 行動適用
  animateDiceRoll(diceEl, roll, 950).then(() => {
    setTimeout(() => {
      isRolling = false;
      app.game = applyAction(g, actor, roll);
      if (app.game.phase === "finished") { showResult(); return; }
      renderBattle(false, roll);
      maybeCpuTurn();
    }, 450); // 出目を見せる余韻
  });
}

// CPU手番なら少し間を置いて自動ロール
function maybeCpuTurn() {
  if (app.game.phase === "finished") return;
  if (isCurrentTurnCpu(app.game)) {
    setTimeout(doRoll, 800);
  }
}

// ============ 7. 結果 ============
function showResult() {
  const g = app.game;
  const online = app.isOnline;
  renderBattle(false); // 最終状態を描画してから結果へ
  const winnerName = currentCharacter(g.players[g.winner]).name || `プレイヤー${g.winner + 1}`;
  const headline = online
    ? (g.winner === app.you ? "🏆 あなたの勝ち！" : "😢 あなたの負け…")
    : `🏆 プレイヤー${g.winner + 1} の勝利！`;
  setTimeout(() => {
    const buttons = online ? [
      el("button", { className: "primary", text: "もう一度（再戦）", onClick: () => { app.conn && app.conn.send({ type: "rematch" }); toast("相手の再戦を待っています…"); } }),
      el("button", { className: "ghost", text: "タイトルへ", onClick: showTitle }),
    ] : [
      el("button", { className: "primary", text: "もう一度", onClick: () => { startBattle(); } }),
      el("button", { className: "ghost", text: "編集に戻る", onClick: showBuild }),
      el("button", { className: "ghost", text: "タイトルへ", onClick: showTitle }),
    ];
    mount(screen, el("div", { className: "result-screen stack" }, [
      el("div", { className: "winner", text: headline }),
      el("p", { text: `勝者: ${winnerName}` }),
      el("div", { className: "row center", style: { justifyContent: "center" } }, buttons),
    ]));
  }, 600);
}

// --- 共通: 戻るボタン ---
function backRow(onBack, inline) {
  const btn = el("button", { className: "ghost", text: "← もどる", onClick: onBack });
  return inline ? btn : el("div", { className: "row" }, [btn]);
}

// 起動: 中断中のオンライン対戦があれば復帰を促す
const resumable = loadSession();
if (resumable) showResumePrompt(resumable);
else showTitle();
