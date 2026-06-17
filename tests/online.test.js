// オンライン対戦のプロトコル/サーバー権威テスト（ブラウザ不要・ws クライアントで検証）。
import { WebSocket } from "ws";
import { eq, ok, report } from "./helpers.js";
import { startServer } from "../server/server.js";
import { defaultRuleConfig, makeId } from "../src/models.js";

// 予算ちょうど(100pt)で速攻決着する有効なモンスター: HP50(10pt)+全面attack15(90pt)
function fastMonster(name) {
  return {
    forms: [{
      name, imageUrl: "", maxHp: 50,
      actions: Array.from({ length: 6 }, () => ({ id: makeId(), type: "attack", label: "パンチ", power: 15 })),
    }],
  };
}
// 予算超過の不正モンスター
function overBudgetMonster() {
  return {
    forms: [{
      name: "ズル", imageUrl: "", maxHp: 200,
      actions: Array.from({ length: 6 }, () => ({ id: makeId(), type: "special", label: "ヤバい", power: 50 })),
    }],
  };
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.q = [];
    this.waiters = [];
    this.ws.on("message", (d) => this._push(JSON.parse(d.toString())));
    this.ready = new Promise((r) => this.ws.on("open", r));
  }
  _push(m) {
    const w = this.waiters.find((w) => w.type === m.type);
    if (w) { this.waiters = this.waiters.filter((x) => x !== w); w.resolve(m); }
    else this.q.push(m);
  }
  waitFor(type, timeout = 4000) {
    const i = this.q.findIndex((m) => m.type === type);
    if (i >= 0) { const m = this.q[i]; this.q.splice(i, 1); return Promise.resolve(m); }
    return new Promise((resolve, reject) => {
      const w = { type, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error("timeout waiting " + type)); }, timeout);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = await startServer({ port: 0 });
  const url = `ws://localhost:${srv.port}/ws`;
  const cfg = defaultRuleConfig("balance");

  // ---- 1. 作成→参加→フル対戦 ----
  const A = new Client(url); const B = new Client(url);
  await Promise.all([A.ready, B.ready]);

  A.send({ type: "create", ruleConfig: cfg, monster: fastMonster("アオ") });
  const created = await A.waitFor("created");
  ok(/^[A-Z2-9]{4}$/.test(created.code), "create returns 4-char room code");

  // 参加前に peek でルール取得
  B.send({ type: "peek", code: created.code });
  const info = await B.waitFor("roomInfo");
  eq(info.ruleConfig.mode, "balance", "peek returns room ruleConfig");

  B.send({ type: "join", code: created.code, monster: fastMonster("アカ") });
  const [startA, startB] = await Promise.all([A.waitFor("start"), B.waitFor("start")]);
  eq(startA.you, 0, "host is player 0");
  eq(startB.you, 1, "joiner is player 1");
  eq(startA.state.phase, "rolling", "game starts in rolling phase (initiative done)");
  ok(startA.state.log.some((l) => l.kind === "initiative"), "initiative was rolled server-side");
  eq(startA.state.turn, startB.state.turn, "both clients agree on first turn");

  // フル対戦: 手番側がroll、両者がrolledを受信
  let state = startA.state;
  let turns = 0;
  const clients = [A, B];
  while (state.phase === "rolling" && turns < 400) {
    const actor = state.turn;
    clients[actor].send({ type: "roll" });
    const [rA, rB] = await Promise.all([A.waitFor("rolled"), B.waitFor("rolled")]);
    eq(rA.state.winner, rB.state.winner, "both clients see identical winner field");
    eq(rA.roll === rB.roll, true, "both clients receive same server-rolled die");
    ok(rA.roll >= 1 && rA.roll <= 6, "die is 1..6");
    state = rA.state;
    turns++;
  }
  eq(state.phase, "finished", "game reached finished");
  ok(state.winner === 0 || state.winner === 1, "a winner was decided");

  // ---- 2. 再戦（両者合意で再開） ----
  A.send({ type: "rematch" });
  await B.waitFor("rematchRequested");
  B.send({ type: "rematch" });
  const [reA, reB] = await Promise.all([A.waitFor("start"), B.waitFor("start")]);
  eq(reA.state.phase, "rolling", "rematch restarts a new game");
  eq(reB.you, 1, "rematch keeps player indices");
  A.close(); B.close();
  await sleep(50);

  // ---- 3. バランス検証: 予算超過は拒否 ----
  const C = new Client(url); await C.ready;
  C.send({ type: "create", ruleConfig: cfg, monster: overBudgetMonster() });
  const err = await C.waitFor("error");
  ok(/規定|予算/.test(err.message), "over-budget monster rejected on create");
  C.close();

  // ---- 4. 手番外の roll は拒否され状態が進まない ----
  const D = new Client(url); const E = new Client(url);
  await Promise.all([D.ready, E.ready]);
  D.send({ type: "create", ruleConfig: cfg, monster: fastMonster("D") });
  const dC = await D.waitFor("created");
  E.send({ type: "join", code: dC.code, monster: fastMonster("E") });
  const [sD] = await Promise.all([D.waitFor("start"), E.waitFor("start")]);
  const nonTurn = sD.state.turn === 0 ? E : D; // 手番でない方
  nonTurn.send({ type: "roll" });
  const wrongErr = await nonTurn.waitFor("error");
  ok(/手番/.test(wrongErr.message), "out-of-turn roll is rejected");
  D.close(); E.close();

  // ---- 5. 切断は即破棄せず猶予通知 ＋ 再接続で復帰 ----
  const F = new Client(url); const G = new Client(url);
  await Promise.all([F.ready, G.ready]);
  F.send({ type: "create", ruleConfig: cfg, monster: fastMonster("F") });
  const fC = await F.waitFor("created");
  ok(typeof fC.token === "string" && fC.token.length > 0, "create returns a resume token");
  G.send({ type: "join", code: fC.code, monster: fastMonster("G") });
  const [sF] = await Promise.all([F.waitFor("start"), G.waitFor("start")]);
  ok(typeof sF.token === "string" && sF.code === fC.code, "start includes token and room code");

  F.close();
  const disc = await G.waitFor("opponentDisconnected");
  ok(disc.graceMs > 0, "disconnect notifies opponent with grace (not immediate destroy)");

  // 再接続で同一スロットに復帰
  const F2 = new Client(url); await F2.ready;
  F2.send({ type: "resume", code: fC.code, token: sF.token });
  const [resumed] = await Promise.all([F2.waitFor("resumed"), G.waitFor("opponentReturned")]);
  eq(resumed.you, 0, "resume restores same player index");
  eq(resumed.state.phase, "rolling", "resume returns the in-progress game state");

  // 復帰後も対戦継続できる
  const actor2 = resumed.state.turn;
  (actor2 === 0 ? F2 : G).send({ type: "roll" });
  const [rr] = await Promise.all([F2.waitFor("rolled"), G.waitFor("rolled")]);
  ok(rr.roll >= 1 && rr.roll <= 6, "game continues after reconnect");
  F2.close(); G.close();
  await sleep(50);

  // ---- 6. 復帰猶予を過ぎたらルーム破棄（スイープ） ----
  const srv2 = await startServer({ port: 0, graceMs: 300, sweepMs: 120 });
  const url2 = `ws://localhost:${srv2.port}/ws`;
  const H = new Client(url2); const I = new Client(url2);
  await Promise.all([H.ready, I.ready]);
  H.send({ type: "create", ruleConfig: cfg, monster: fastMonster("H") });
  const hC = await H.waitFor("created");
  I.send({ type: "join", code: hC.code, monster: fastMonster("I") });
  await Promise.all([H.waitFor("start"), I.waitFor("start")]);
  H.close();
  await I.waitFor("opponentDisconnected");
  const gone = await I.waitFor("opponentLeft", 3000); // 猶予超過 → スイープで破棄通知
  ok(!!gone, "room destroyed by sweeper after reconnect grace expires");
  I.close();
  await srv2.close();

  // ---- 7. ルーム上限超過は拒否 ----
  const srv3 = await startServer({ port: 0, maxRooms: 1 });
  const url3 = `ws://localhost:${srv3.port}/ws`;
  const J = new Client(url3); const K = new Client(url3);
  await Promise.all([J.ready, K.ready]);
  J.send({ type: "create", ruleConfig: cfg, monster: fastMonster("J") });
  await J.waitFor("created");
  K.send({ type: "create", ruleConfig: cfg, monster: fastMonster("K") });
  const capErr = await K.waitFor("error");
  ok(/混雑/.test(capErr.message), "create rejected when room limit reached");
  J.close(); K.close();
  await srv3.close();

  // ---- 8. 壊れたモンスター（free でも）は拒否され、サーバーは生存し続ける ----
  const freeCfg = defaultRuleConfig("free");
  const L = new Client(url); await L.ready;
  // 行動面が空（6面でない）→ 受理すると roll 時に applyAction がクラッシュし得る
  L.send({ type: "create", ruleConfig: freeCfg, monster: { forms: [{ name: "壊", imageUrl: "", maxHp: 50, actions: [] }] } });
  const badErr = await L.waitFor("error");
  ok(/規定|不正/.test(badErr.message), "malformed free-mode monster is rejected (no server crash)");
  // サーバーがまだ応答する（=クラッシュしていない）ことを確認
  L.send({ type: "create", ruleConfig: freeCfg, monster: fastMonster("健全") });
  const okCreated = await L.waitFor("created");
  ok(/^[A-Z2-9]{4}$/.test(okCreated.code), "server still serves valid requests after malformed input");
  L.close();

  await sleep(50);
  await srv.close();
  report("online (server protocol)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
