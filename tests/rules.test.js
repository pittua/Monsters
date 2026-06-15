import { eq, ok, approx, report } from "./helpers.js";
import { defaultRuleConfig, makeId } from "../src/models.js";
import {
  calcActionCost,
  calcHpCost,
  calcCharacterCost,
  calcMonsterCost,
  reachableForms,
  validateMonster,
  generateRandomMonster,
} from "../src/rules.js";

const cfg = defaultRuleConfig("balance");

function act(type, power, targetForm) {
  const a = { id: makeId(), type, label: type, power };
  if (targetForm != null) a.targetForm = targetForm;
  return a;
}
function form(maxHp, actions) {
  return { name: "X", imageUrl: "", maxHp, actions };
}
function sixNone() {
  return Array.from({ length: 6 }, () => act("none", 0));
}

// --- calcActionCost ---
approx(calcActionCost(act("attack", 10), cfg), 10, "attack 10 = 0 + 10*1.0");
approx(calcActionCost(act("special", 10), cfg), 3 + 15, "special 10 = 3 + 10*1.5");
approx(calcActionCost(act("guard", 10), cfg), 1 + 8, "guard 10 = 1 + 10*0.8");
approx(calcActionCost(act("none", 0), cfg), 0, "none = 0");
approx(calcActionCost(act("transform", 0, 1), cfg), 0, "transform face cost = 0");
// マイナス面は払い戻し（負コスト）
approx(calcActionCost(act("attack", -10), cfg), -6, "attack -10 refund = -(10*0.6)");
approx(calcActionCost(act("special", -10), cfg), -8, "special -10 refund = -(10*0.8)");

approx(calcActionCost({ id: "x", type: "custom", label: "ねむらせ", power: 0, desc: "1回休み" }, cfg), 0, "custom cost = 0");

// --- calcHpCost ---
eq(calcHpCost(100, cfg), 20, "HP100 / 5 = 20pt");
eq(calcHpCost(103, cfg), 20, "HP103 floor = 20pt");

// --- calcCharacterCost ---
// HP100(20pt) + attack10(10) + 4 none(0) + heal5(1+5=6) = 36
{
  const c = form(100, [act("attack", 10), act("heal", 5), ...sixNone().slice(0, 4)]);
  approx(calcCharacterCost(c, cfg), 36, "character cost sum");
}
// 下限0クランプ: マイナス面だらけ
{
  const c = form(50, [act("attack", -50), act("attack", -50), ...sixNone().slice(0, 4)]);
  ok(calcCharacterCost(c, cfg) >= 0, "character cost clamped to >= 0");
}

// --- reachableForms / 循環安全 ---
{
  // 0 -> 1 -> 0 の循環
  const m = {
    forms: [
      form(100, [act("transform", 0, 1), ...sixNone().slice(0, 5)]),
      form(100, [act("transform", 0, 0), ...sixNone().slice(0, 5)]),
    ],
  };
  const r = reachableForms(m);
  ok(r.has(0) && r.has(1) && r.size === 2, "cyclic forms reachable counted once each");
}
{
  // 到達不能フォーム(2)は数えない
  const m = {
    forms: [
      form(100, [act("transform", 0, 1), ...sixNone().slice(0, 5)]),
      form(100, sixNone()),
      form(200, sixNone()), // 孤立
    ],
  };
  const r = reachableForms(m);
  ok(!r.has(2), "unreachable form excluded");
}

// --- calcMonsterCost: 初期満額 + 変身先0.5倍 ---
{
  const m = {
    forms: [
      form(100, [act("attack", 10), act("transform", 0, 1), ...sixNone().slice(0, 4)]), // 20+10 = 30
      form(100, [act("attack", 20), ...sixNone().slice(0, 5)]), // 20+20 = 40, *0.5 = 20
    ],
  };
  approx(calcMonsterCost(m, cfg), 30 + 20, "monster cost = full form0 + 0.5*form1");
}

// --- validateMonster: balance 予算 ---
{
  const cheap = { forms: [form(100, [act("attack", 10), ...sixNone().slice(0, 5)])] }; // 30pt
  const v = validateMonster(cheap, cfg);
  ok(v.ok, "cheap monster ok in balance");
  approx(v.remaining, 100 - 30, "remaining = budget - cost");
}
{
  const expensive = { forms: [form(200, [act("special", 50), act("special", 50), ...sixNone().slice(0, 4)])] };
  const v = validateMonster(expensive, cfg);
  ok(!v.ok, "expensive monster rejected (over budget)");
  ok(v.errors.some((e) => e.includes("予算超過")), "has budget error");
}
// free は常に ok
{
  const freeCfg = defaultRuleConfig("free");
  const expensive = { forms: [form(999, [act("special", 999), ...sixNone().slice(0, 5)])] };
  ok(validateMonster(expensive, freeCfg).ok, "free mode always ok");
}
// transform 先不正
{
  const bad = { forms: [form(100, [act("transform", 0, 5), ...sixNone().slice(0, 5)])] };
  ok(!validateMonster(bad, cfg).ok, "invalid targetForm rejected");
}

// --- generateRandomMonster ---
{
  for (let i = 0; i < 30; i++) {
    const m = generateRandomMonster(cfg);
    if (!validateMonster(m, cfg).ok) {
      ok(false, "random balance monster always valid");
      break;
    }
    if (i === 29) ok(true, "random balance monster always valid (30x)");
  }
  const free = generateRandomMonster(defaultRuleConfig("free"));
  ok(free.forms.length >= 1 && free.forms[0].actions.length === 6, "random monster has 6 faces");
}

report("rules.js");
