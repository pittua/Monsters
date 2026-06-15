import { eq, ok, approx, report } from "./helpers.js";
import { makeId } from "../src/models.js";
import {
  createGame,
  rollInitiative,
  applyAction,
  checkWinner,
  isCurrentTurnCpu,
  currentCharacter,
} from "../src/game.js";

function act(type, power, targetForm) {
  const a = { id: makeId(), type, label: type, power };
  if (targetForm != null) a.targetForm = targetForm;
  return a;
}
function form(name, maxHp, actions) {
  return { name, imageUrl: "", maxHp, actions };
}
function pad(actions) {
  const out = actions.slice();
  while (out.length < 6) out.push(act("none", 0));
  return out;
}

// --- createGame ---
{
  const mA = { forms: [form("A", 120, pad([act("attack", 10)]))] };
  const mB = { forms: [form("B", 100, pad([act("attack", 10)]))] };
  const g = createGame(mA, mB, "cpu");
  eq(g.players[0].hp, 120, "P0 hp = maxHp");
  eq(g.players[1].hp, 100, "P1 hp = maxHp");
  eq(g.controllers, ["human", "cpu"], "cpu controllers");
  eq(g.phase, "initiative", "starts in initiative");
  ok(isCurrentTurnCpu(createGame(mA, mB, "cpu")) === false, "turn0 human not cpu at start");
}

// --- rollInitiative (注入ダイスで決定的に) ---
{
  const mA = { forms: [form("A", 100, pad([]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  const g = createGame(mA, mB, "local");
  // P1=5, P2=3 → P0先攻。tie回避ロジック確認のため最初tieを返す
  const seq = [4, 4, 5, 3];
  let i = 0;
  const dice = () => seq[i++];
  const g2 = rollInitiative(g, dice);
  eq(g2.turn, 0, "higher roll goes first (P0)");
  eq(g2.phase, "rolling", "phase -> rolling");
  ok(g2.log.some((l) => l.kind === "initiative"), "initiative logged");
  eq(i, 4, "rerolled once on tie");
}

// --- attack & guard 消費 ---
{
  const mA = { forms: [form("A", 100, pad([act("attack", 30)]))] };
  const mB = { forms: [form("B", 100, pad([act("guard", 10)]))] };
  let g = createGame(mA, mB, "local");
  g.phase = "rolling"; g.turn = 1;
  // P1 が guard(面1) → guardValue=10
  g = applyAction(g, 1, 1);
  eq(g.players[1].guardValue, 10, "guard sets guardValue");
  eq(g.turn, 0, "turn passes to P0");
  // P0 attack 30 → 30-10=20
  g = applyAction(g, 0, 1);
  eq(g.players[1].hp, 80, "attack 30 vs guard 10 = 20 dmg");
  eq(g.players[1].guardValue, 0, "guard consumed after hit");
}

// --- 無防備(負ガード)で被ダメ増加 ---
{
  const mA = { forms: [form("A", 100, pad([act("attack", 20)]))] };
  const mB = { forms: [form("B", 100, pad([act("guard", -10)]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 1;
  g = applyAction(g, 1, 1); // P1 guard -10
  g = applyAction(g, 0, 1); // P0 attack 20 → 20-(-10)=30
  eq(g.players[1].hp, 70, "negative guard increases damage (30)");
}

// --- 自爆 (attack 負) ---
{
  const mA = { forms: [form("A", 100, pad([act("attack", -20)]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g = applyAction(g, 0, 1);
  eq(g.players[0].hp, 80, "negative attack = self damage");
}

// --- special 正/負 ---
{
  const mA = { forms: [form("A", 100, pad([act("special", 15), act("special", -10)]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g = applyAction(g, 0, 1); // special 15 → 30 to opp
  eq(g.players[1].hp, 70, "special 15 = 30 dmg to opp");
  g.turn = 0;
  g = applyAction(g, 0, 2); // special -10 → 20 to self
  eq(g.players[0].hp, 80, "special -10 = 20 self dmg");
}

// --- heal 正(上限)/負(反動) ---
{
  const mA = { forms: [form("A", 100, pad([act("heal", 30), act("heal", -10)]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g.players[0].hp = 80;
  g = applyAction(g, 0, 1); // heal 30 → cap at 100
  eq(g.players[0].hp, 100, "heal capped at maxHp");
  g.turn = 0;
  g = applyAction(g, 0, 2); // heal -10 → 10 self dmg
  eq(g.players[0].hp, 90, "negative heal = self damage");
}

// --- 変身: HP割合維持 + guardリセット ---
{
  // form0 maxHp=100, form1 maxHp=200。HP50(50%)で変身 → 100
  const mA = {
    forms: [
      form("Base", 100, pad([act("transform", 0, 1)])),
      form("Mega", 200, pad([act("attack", 50)])),
    ],
  };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g.players[0].hp = 50;
  g.players[0].guardValue = 5;
  g = applyAction(g, 0, 1); // transform to form1
  eq(g.players[0].currentForm, 1, "currentForm updated");
  eq(g.players[0].hp, 100, "HP ratio maintained (50% of 200 = 100)");
  eq(g.players[0].guardValue, 0, "guardValue reset on transform");
  eq(currentCharacter(g.players[0]).name, "Mega", "currentCharacter reflects new form");
}
// 変身: 低HPフォームへ → 実HP減少（弱体変身）
{
  const mA = {
    forms: [
      form("Base", 200, pad([act("transform", 0, 1)])),
      form("Mini", 100, pad([])),
    ],
  };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g.players[0].hp = 100; // 50% of 200
  g = applyAction(g, 0, 1);
  eq(g.players[0].hp, 50, "transform to smaller form reduces real HP (50% of 100)");
}

// --- custom (自由記述・HP変化なし・ログに説明文) ---
{
  const customAct = { id: makeId(), type: "custom", label: "さくせん", power: 0, desc: "相手を眠らせて1回休み" };
  const mA = { forms: [form("A", 100, pad([customAct]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g = applyAction(g, 0, 1);
  eq(g.players[0].hp, 100, "custom does not change own HP");
  eq(g.players[1].hp, 100, "custom does not change opponent HP");
  ok(g.log.at(-1).result.includes("相手を眠らせて1回休み"), "custom logs the free description");
}

// --- none 面の自由記述（任意） ---
{
  const noneDesc = { id: makeId(), type: "none", label: "ためる", power: 0, desc: "次のターンに備える" };
  const noneEmpty = { id: makeId(), type: "none", label: "なし", power: 0 };
  const mA = { forms: [form("A", 100, pad([noneDesc, noneEmpty]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g = applyAction(g, 0, 1);
  ok(g.log.at(-1).result.includes("次のターンに備える"), "none with desc logs description");
  g.turn = 0;
  g = applyAction(g, 0, 2);
  ok(g.log.at(-1).result.includes("効果なし"), "none without desc logs 効果なし");
  eq(g.players[0].hp, 100, "none never changes HP");
}

// --- 勝敗 ---
{
  const mA = { forms: [form("A", 100, pad([act("attack", 100)]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g = applyAction(g, 0, 1);
  eq(g.players[1].hp <= 0, true, "opp dropped to <=0");
  eq(g.winner, 0, "P0 wins");
  eq(g.phase, "finished", "phase finished");
}
// 自爆死 = 相手の勝ち
{
  const mA = { forms: [form("A", 50, pad([act("special", -30)]))] }; // -30*2 = 60 self
  const mB = { forms: [form("B", 100, pad([]))] };
  let g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  g = applyAction(g, 0, 1);
  eq(g.winner, 1, "self-destruct death = opponent wins");
}

// --- 不変性: 元stateが変化しない ---
{
  const mA = { forms: [form("A", 100, pad([act("attack", 10)]))] };
  const mB = { forms: [form("B", 100, pad([]))] };
  const g = createGame(mA, mB, "local"); g.phase = "rolling"; g.turn = 0;
  const before = g.players[1].hp;
  applyAction(g, 0, 1);
  eq(g.players[1].hp, before, "applyAction does not mutate input state");
}

report("game.js");
