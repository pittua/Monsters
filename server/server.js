// server.js — 結合サーバー（1プロセスで 静的配信 + /health + WebSocket(/ws)）。
// 戦闘ロジックは src/game.js / src/rules.js をそのまま流用（同じ判定・コスト検証で不正防止）。
// 再接続（同一ルーム復帰）と、負荷時のクリーンアップ（猶予切断・TTL・上限・定期スイープ）に対応。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

import { createGame, rollInitiative, rollDice, applyAction } from "../src/game.js";
import { validateMonster } from "../src/rules.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(req, res) {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const safe = normalize(p).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, safe);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

// ====================== ルーム管理 ======================

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい O0 I1 を除外

/** サーバー1インスタンス分の状態（テストで複数起動しても干渉しないようローカル保持） */
function createState(cfg) {
  /** @type {Map<string, any>} */
  const rooms = new Map();

  function makeRoomCode() {
    let code;
    do {
      code = "";
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    } while (rooms.has(code));
    return code;
  }

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }
  // 接続中の相手にのみ送る。builder(index, conn) でプレイヤー個別メッセージを作れる。
  function broadcast(room, builder) {
    room.conns.forEach((c, i) => { if (!c.disconnected) send(c.ws, builder(i, c)); });
  }
  function touch(room) { room.lastActivity = Date.now(); }

  function startMatch(room) {
    room.game = rollInitiative(createGame(room.conns[0].monster, room.conns[1].monster, "online"));
    room.rematch = [false, false];
    touch(room);
    broadcast(room, (i, c) => ({ type: "start", you: i, code: room.code, token: c.token, state: room.game }));
  }

  function destroyRoom(room, reason) {
    for (const c of room.conns) {
      if (!c.disconnected) send(c.ws, { type: "opponentLeft", message: reason || "相手が退出しました" });
      if (c.ws) c.ws._room = null;
    }
    rooms.delete(room.code);
  }

  function validMonsterOrError(ws, monster, ruleConfig) {
    if (!monster || !Array.isArray(monster.forms) || monster.forms.length === 0) {
      send(ws, { type: "error", message: "モンスターが不正です" });
      return false;
    }
    if (ruleConfig.mode === "balance") {
      const v = validateMonster(monster, ruleConfig);
      if (!v.ok) {
        send(ws, { type: "error", message: "モンスターが規定を満たしません: " + (v.errors[0] || "予算超過") });
        return false;
      }
    }
    return true;
  }

  // --- メッセージ処理 ---

  function handleMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "create": return onCreate(ws, msg);
      case "peek": return onPeek(ws, msg);
      case "join": return onJoin(ws, msg);
      case "resume": return onResume(ws, msg);
      case "roll": return onRoll(ws);
      case "rematch": return onRematch(ws);
      default: return;
    }
  }

  function onCreate(ws, msg) {
    if (ws._room) { send(ws, { type: "error", message: "すでに別のルームに参加しています" }); return; }
    if (rooms.size >= cfg.maxRooms) { send(ws, { type: "error", message: "サーバーが混雑しています。時間をおいて再試行してください" }); return; }
    const ruleConfig = msg.ruleConfig;
    if (!ruleConfig || (ruleConfig.mode !== "free" && ruleConfig.mode !== "balance")) {
      send(ws, { type: "error", message: "ルール設定が不正です" }); return;
    }
    if (!validMonsterOrError(ws, msg.monster, ruleConfig)) return;

    const code = makeRoomCode();
    const token = randomUUID();
    const now = Date.now();
    const room = {
      code, ruleConfig,
      conns: [{ ws, monster: msg.monster, token, disconnected: false, disconnectedAt: 0 }],
      game: null, rematch: [false, false], createdAt: now, lastActivity: now,
    };
    rooms.set(code, room);
    ws._room = room; ws._you = 0;
    send(ws, { type: "created", code, token, you: 0 });
  }

  function onPeek(ws, msg) {
    const room = rooms.get((msg.code || "").toUpperCase());
    if (!room) { send(ws, { type: "error", message: "ルームが見つかりません" }); return; }
    if (room.conns.length >= 2) { send(ws, { type: "error", message: "ルームが満員です" }); return; }
    send(ws, { type: "roomInfo", code: room.code, ruleConfig: room.ruleConfig });
  }

  function onJoin(ws, msg) {
    if (ws._room) { send(ws, { type: "error", message: "すでに別のルームに参加しています" }); return; }
    const room = rooms.get((msg.code || "").toUpperCase());
    if (!room) { send(ws, { type: "error", message: "ルームが見つかりません" }); return; }
    if (room.conns.length >= 2) { send(ws, { type: "error", message: "ルームが満員です" }); return; }
    if (!validMonsterOrError(ws, msg.monster, room.ruleConfig)) return;

    const token = randomUUID();
    room.conns.push({ ws, monster: msg.monster, token, disconnected: false, disconnectedAt: 0 });
    ws._room = room; ws._you = 1;
    startMatch(room); // 2人揃ったので開始（先攻もここで決定）
  }

  // 再接続: コード＋トークンで同一スロットに復帰
  function onResume(ws, msg) {
    if (ws._room) { send(ws, { type: "error", message: "すでに接続中です" }); return; }
    const room = rooms.get((msg.code || "").toUpperCase());
    if (!room) { send(ws, { type: "error", message: "ルームが見つかりません（期限切れの可能性）" }); return; }
    const i = room.conns.findIndex((c) => c.token === msg.token);
    if (i < 0) { send(ws, { type: "error", message: "復帰できません（セッションが無効です）" }); return; }

    const conn = room.conns[i];
    // 既存接続が生きている場合は古い方を閉じる（多重接続防止）
    if (conn.ws && conn.ws !== ws && conn.ws.readyState === conn.ws.OPEN) { try { conn.ws._room = null; conn.ws.close(); } catch {} }
    conn.ws = ws; conn.disconnected = false; conn.disconnectedAt = 0;
    ws._room = room; ws._you = i;
    touch(room);

    send(ws, {
      type: "resumed", you: i, code: room.code, token: conn.token,
      ruleConfig: room.ruleConfig, state: room.game, // game が null なら相手待ち
    });
    // 相手に復帰を通知
    const other = room.conns[i === 0 ? 1 : 0];
    if (other && !other.disconnected) send(other.ws, { type: "opponentReturned" });
  }

  function onRoll(ws) {
    const room = ws._room;
    if (!room || !room.game || room.game.phase !== "rolling") return;
    if (ws._you !== room.game.turn) { send(ws, { type: "error", message: "あなたの手番ではありません" }); return; }
    const roll = rollDice(); // ダイスはサーバー生成（チート防止）
    room.game = applyAction(room.game, room.game.turn, roll);
    touch(room);
    broadcast(room, () => ({ type: "rolled", roll, state: room.game }));
  }

  function onRematch(ws) {
    const room = ws._room;
    if (!room || !room.game || room.game.phase !== "finished") return;
    room.rematch[ws._you] = true;
    touch(room);
    if (room.rematch[0] && room.rematch[1] && room.conns.length === 2 && !room.conns.some((c) => c.disconnected)) {
      startMatch(room);
    } else {
      const other = room.conns[ws._you === 0 ? 1 : 0];
      if (other && !other.disconnected) send(other.ws, { type: "rematchRequested" });
    }
  }

  function handleClose(ws) {
    const room = ws._room;
    ws._room = null;
    if (!room || !rooms.has(room.code)) return;
    const conn = room.conns.find((c) => c.ws === ws);
    if (!conn) return;
    conn.disconnected = true;
    conn.disconnectedAt = Date.now();

    // 全員切断ならルーム破棄。そうでなければ猶予を設け、相手に通知。
    if (room.conns.every((c) => c.disconnected)) {
      rooms.delete(room.code);
    } else {
      const other = room.conns.find((c) => !c.disconnected);
      if (other) send(other.ws, { type: "opponentDisconnected", graceMs: cfg.graceMs });
    }
  }

  // --- 定期スイープ（負荷時のメモリ解放） ---
  function sweep() {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (room.conns.every((c) => c.disconnected)) { rooms.delete(room.code); continue; }
      // 切断猶予を超えたら破棄（相手が戻らなかった）
      if (room.conns.some((c) => c.disconnected && now - c.disconnectedAt > cfg.graceMs)) {
        destroyRoom(room, "相手が戻りませんでした"); continue;
      }
      // 相手待ちのまま放置
      if (!room.game && now - room.createdAt > cfg.waitingTtlMs) { destroyRoom(room, "ルームの期限が切れました"); continue; }
      // 終了後の放置
      if (room.game && room.game.phase === "finished" && now - room.lastActivity > cfg.finishedTtlMs) {
        destroyRoom(room, "ルームを終了しました"); continue;
      }
      // 全体の無操作TTL
      if (now - room.lastActivity > cfg.roomTtlMs) { destroyRoom(room, "無操作のためルームを終了しました"); continue; }
    }
  }

  return { rooms, handleMessage, handleClose, sweep };
}

// ====================== サーバー起動 ======================

const DEFAULTS = {
  graceMs: 60000,        // 切断後の復帰猶予
  sweepMs: 15000,        // スイープ間隔
  waitingTtlMs: 600000,  // 相手待ちの期限(10分)
  finishedTtlMs: 300000, // 終了後の保持(5分・再戦用)
  roomTtlMs: 1800000,    // 無操作の最大保持(30分)
  maxRooms: 1000,        // 同時ルーム上限
};

/**
 * サーバーを起動する。テストからも呼べるよう Promise を返す。
 * @param {object} [opts] port と各種TTL/上限を上書き可能（テストでは短く設定）
 * @returns {Promise<{server, wss, port, state, close}>}
 */
export function startServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT != null ? Number(process.env.PORT) : 8080);
  const cfg = { ...DEFAULTS, ...opts };
  const state = createState(cfg);

  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); return; }
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => state.handleMessage(ws, data.toString()));
    ws.on("close", () => state.handleClose(ws));
    ws.on("error", () => {});
  });

  const sweeper = setInterval(() => state.sweep(), cfg.sweepMs);
  if (sweeper.unref) sweeper.unref();

  return new Promise((res) => {
    server.listen(port, () => {
      res({
        server, wss, state, port: server.address().port,
        close: () => new Promise((r) => { clearInterval(sweeper); wss.close(); server.close(() => r()); state.rooms.clear(); }),
      });
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(({ port }) => {
    console.log(`Monsters server: http://localhost:${port}  (WS: /ws, health: /health)`);
  });
}
