// game.js — 戦闘コアロジック。モード非依存・純粋関数。UI/通信に依存しない。
// 状態は不変的に扱う（structuredClone でコピーしてから書き換え、新stateを返す）。
import { SPECIAL_MULTIPLIER } from "./models.js";

const clone = (typeof structuredClone === "function")
  ? structuredClone
  : (o) => JSON.parse(JSON.stringify(o));

/** 1〜6 を返す */
export function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
}

/** 現在のフォーム（Character）を取得 */
export function currentCharacter(playerState) {
  return playerState.monster.forms[playerState.currentForm];
}

function controllersFor(matchType) {
  switch (matchType) {
    case "cpu": return ["human", "cpu"];
    case "local":
    case "practice":
    case "online":
    default: return ["human", "human"];
  }
}

/**
 * 対戦開始時の GameState を生成。currentForm=0、phase="initiative"。
 */
export function createGame(monsterA, monsterB, matchType = "local") {
  const mkPlayer = (monster) => ({
    monster: clone(monster),
    currentForm: 0,
    hp: monster.forms[0].maxHp,
    guardValue: 0,
  });
  return {
    players: [mkPlayer(monsterA), mkPlayer(monsterB)],
    matchType,
    controllers: controllersFor(matchType),
    turn: 0,
    phase: "initiative",
    winner: null,
    log: [],
  };
}

/**
 * 先攻決定: 両者がダイスを1回振り、大きい方を先攻に。同値なら割れるまで振り直す。
 * 勝敗には影響しない。結果を log に残し phase="rolling" へ。
 * @param {() => number} [dice] テスト用にダイス関数を注入可能
 */
export function rollInitiative(state, dice = rollDice) {
  const next = clone(state);
  let a, b;
  do {
    a = dice();
    b = dice();
  } while (a === b);
  const first = a > b ? 0 : 1;
  next.turn = first;
  next.phase = "rolling";
  next.log.push({
    kind: "initiative",
    rolls: [a, b],
    winner: first,
    result: `先攻ロール: P1=${a} / P2=${b} → プレイヤー${first + 1}が先攻`,
  });
  return next;
}

/**
 * ダメージを対象プレイヤーに与える（guardValue を考慮し消費する）。
 * guardValue: 正=軽減、負=被ダメ増加。適用後 0 にリセット（1回分）。
 * @returns {number} 実際に与えたダメージ
 */
function dealDamage(playerState, rawAmount) {
  let effective = rawAmount - playerState.guardValue;
  if (effective < 0) effective = 0;
  playerState.hp -= effective;
  playerState.guardValue = 0;
  return effective;
}

/**
 * 出目の面の行動を適用し、新しい GameState を返す。
 * transform面なら HP割合維持で変身（currentForm更新・guardValueリセット）。
 * それ以外は power符号で自他どちらに作用かを判定して適用。
 * @param {number} diceRoll 1〜6
 */
export function applyAction(state, playerIndex, diceRoll) {
  const next = clone(state);
  const self = next.players[playerIndex];
  const oppIndex = playerIndex === 0 ? 1 : 0;
  const opp = next.players[oppIndex];
  const form = self.monster.forms[self.currentForm];
  const action = form.actions[diceRoll - 1];
  const power = action.power || 0;
  let result = "";

  switch (action.type) {
    case "attack": {
      if (power >= 0) {
        const dealt = dealDamage(opp, power);
        result = `${action.label}: 相手に${dealt}ダメージ`;
      } else {
        const dealt = dealDamage(self, Math.abs(power));
        result = `${action.label}: 自分に${dealt}ダメージ(暴発)`;
      }
      break;
    }
    case "special": {
      if (power >= 0) {
        const dealt = dealDamage(opp, power * SPECIAL_MULTIPLIER);
        result = `${action.label}: 相手に${dealt}ダメージ(必殺)`;
      } else {
        const dealt = dealDamage(self, Math.abs(power) * SPECIAL_MULTIPLIER);
        result = `${action.label}: 自分に${dealt}ダメージ(大暴発)`;
      }
      break;
    }
    case "heal": {
      if (power >= 0) {
        const before = self.hp;
        self.hp = Math.min(form.maxHp, self.hp + power);
        result = `${action.label}: ${self.hp - before}回復`;
      } else {
        const dealt = dealDamage(self, Math.abs(power));
        result = `${action.label}: 自分に${dealt}ダメージ(反動)`;
      }
      break;
    }
    case "guard": {
      self.guardValue = power;
      result = power >= 0
        ? `${action.label}: 次の被ダメを${power}軽減`
        : `${action.label}: 次の被ダメが${Math.abs(power)}増加(無防備)`;
      break;
    }
    case "transform": {
      const targetIndex = action.targetForm;
      const target = self.monster.forms[targetIndex];
      const ratio = self.hp / form.maxHp;
      const newHp = Math.round(target.maxHp * ratio);
      self.currentForm = targetIndex;
      self.hp = newHp;
      self.guardValue = 0; // フォームが変わるので持ち越さない
      result = `${action.label}: 「${target.name || "?"}」に変身 (HP ${newHp}/${target.maxHp})`;
      break;
    }
    case "custom": {
      // 自由記述。自動でのHP変化はなし（プレイヤーが手動判定する）。
      const text = (action.desc && action.desc.trim()) || "（効果未記入）";
      result = `${action.label || "とくしゅ"}: ${text}`;
      break;
    }
    case "none": {
      // 自由記述があればそれをログに（手動判定）、なければ「効果なし」
      const text = (action.desc && action.desc.trim());
      result = text ? `${action.label || "なし"}: ${text}` : `${action.label || "なし"}: 効果なし`;
      break;
    }
    default:
      result = `${action.label}: 効果なし`;
      break;
  }

  next.log.push({
    turn: next.log.filter((l) => l.kind !== "initiative").length,
    playerIndex,
    diceRoll,
    action: clone(action),
    result,
  });

  const winner = checkWinner(next);
  if (winner !== null) {
    next.winner = winner;
    next.phase = "finished";
  } else {
    next.turn = oppIndex;
    next.phase = "rolling";
  }
  return next;
}

/**
 * 勝者判定。HPが0以下のプレイヤーがいれば相手が勝ち。なければ null。
 * 自傷で自分のHPが0になったら相手の勝ち（自爆は諸刃）。
 * @returns {0|1|null}
 */
export function checkWinner(state) {
  const p0Dead = state.players[0].hp <= 0;
  const p1Dead = state.players[1].hp <= 0;
  if (p0Dead && p1Dead) {
    // 同時に0以下になることは通常ないが、手番側の自爆を優先（手番側=自分が負け）
    return state.turn === 0 ? 1 : 0;
  }
  if (p0Dead) return 1;
  if (p1Dead) return 0;
  return null;
}

/** 現手番が CPU か。UI層がこれを見て自動ロールする。戦闘判定は CPU を意識しない。 */
export function isCurrentTurnCpu(state) {
  return state.controllers[state.turn] === "cpu";
}
