// 完全な対戦を1試合シミュレートしてログを表示（コンソール動作確認用）。
// node tests/sim.js
import { defaultRuleConfig } from "../src/models.js";
import { generateRandomMonster, validateMonster, calcMonsterCost } from "../src/rules.js";
import { createGame, rollInitiative, rollDice, applyAction } from "../src/game.js";

const cfg = defaultRuleConfig("balance");
const mA = generateRandomMonster(cfg);
const mB = generateRandomMonster(cfg);

console.log("=== ランダム生成モンスター ===");
for (const [label, m] of [["P1", mA], ["P2", mB]]) {
  console.log(`${label}: ${m.forms[0].name} HP${m.forms[0].maxHp} cost=${calcMonsterCost(m, cfg).toFixed(1)} valid=${validateMonster(m, cfg).ok}`);
  console.log("   面:", m.forms[0].actions.map((a, i) => `[${i + 1}]${a.type}${a.power}`).join(" "));
}

let g = createGame(mA, mB, "cpu");
g = rollInitiative(g);
console.log("\n" + g.log.at(-1).result);
console.log("\n=== バトル ===");

let turns = 0;
while (g.phase !== "finished" && turns < 500) {
  const actor = g.turn; // applyAction 前の手番が行動者
  const roll = rollDice();
  g = applyAction(g, actor, roll);
  const last = g.log.at(-1);
  console.log(`手${last.turn} P${actor + 1} 🎲${roll}: ${last.result}  (HP P1:${g.players[0].hp} P2:${g.players[1].hp})`);
  turns++;
}

console.log(`\n結果: プレイヤー${g.winner + 1}の勝利！ (${turns}手)`);
