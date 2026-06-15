// rules.js — ルール/コスト層。純粋関数のみ。UI/通信に依存しない。
import {
  FORM_DISCOUNT,
  ACTION_TYPES,
  makeId,
  defaultRuleConfig,
} from "./models.js";

/**
 * 1面のコストを計算。負の値もあり得る。transform/none は 0。
 * power>=0: TYPE_BASE_COST + power * POWER_COST
 * power<0 : -(|power| * POWER_REFUND)  ← ポイントが戻る（割引）
 * @param {import("./models.js").Action} action
 * @param {import("./models.js").RuleConfig} cfg
 * @returns {number}
 */
export function calcActionCost(action, cfg) {
  // transform/none/custom はコスト0（custom は自動効果なしの自由記述＝手動判定）
  if (action.type === "transform" || action.type === "none" || action.type === "custom") return 0;
  const power = action.power || 0;
  if (power >= 0) {
    return (cfg.typeBaseCost[action.type] || 0) + power * (cfg.powerCost[action.type] || 0);
  }
  return -(Math.abs(power) * (cfg.powerRefund[action.type] || 0));
}

/** HPのコスト = floor(maxHp / hpPerPoint) */
export function calcHpCost(maxHp, cfg) {
  return Math.floor(maxHp / cfg.hpPerPoint);
}

/**
 * 1フォーム分のコスト: HP + 全面合計。下限0でクランプ。
 * @param {import("./models.js").Character} character
 * @param {import("./models.js").RuleConfig} cfg
 */
export function calcCharacterCost(character, cfg) {
  let total = calcHpCost(character.maxHp, cfg);
  for (const action of character.actions) {
    total += calcActionCost(action, cfg);
  }
  return Math.max(0, total);
}

/**
 * forms[0] から transform 面をたどって到達できる全フォームの index 集合。
 * Set で訪問管理＝循環があっても各フォーム1回だけ。
 * @returns {Set<number>}
 */
export function reachableForms(monster) {
  const reachable = new Set();
  const stack = [0];
  while (stack.length) {
    const i = stack.pop();
    if (i == null || i < 0 || i >= monster.forms.length) continue;
    if (reachable.has(i)) continue;
    reachable.add(i);
    for (const action of monster.forms[i].actions) {
      if (action.type === "transform" && typeof action.targetForm === "number") {
        stack.push(action.targetForm);
      }
    }
  }
  return reachable;
}

/**
 * モンスター総コスト: forms[0] 満額 + 到達可能な変身先を FORM_DISCOUNT 倍で合算。
 * 到達フォームは Set で集めるため循環安全。
 */
export function calcMonsterCost(monster, cfg) {
  const reachable = reachableForms(monster);
  let total = 0;
  for (const i of reachable) {
    const cost = calcCharacterCost(monster.forms[i], cfg);
    total += i === 0 ? cost : cost * FORM_DISCOUNT;
  }
  return total;
}

/**
 * モンスターの妥当性検証。モード差を吸収する唯一の場所（free は常に ok=true）。
 * @returns {{ ok: boolean, totalCost: number, remaining: number, errors: string[] }}
 */
export function validateMonster(monster, cfg) {
  const errors = [];

  // 構造チェック（両モード共通の最低限）
  if (!monster.forms || monster.forms.length === 0) {
    errors.push("フォームが1つもありません");
  }
  monster.forms.forEach((form, fi) => {
    if (!form.actions || form.actions.length !== 6) {
      errors.push(`フォーム${fi + 1}: 行動は6面必要です`);
    }
    (form.actions || []).forEach((action, ai) => {
      if (action.type === "transform") {
        const t = action.targetForm;
        if (typeof t !== "number" || t < 0 || t >= monster.forms.length) {
          errors.push(`フォーム${fi + 1}の${ai + 1}面: 変身先が不正です`);
        }
      }
      if (cfg.mode === "balance" && (action.power || 0) < cfg.powerMin) {
        errors.push(`フォーム${fi + 1}の${ai + 1}面: power が下限(${cfg.powerMin})未満です`);
      }
    });
    if (cfg.mode === "balance") {
      if (form.maxHp < cfg.hpMin) errors.push(`フォーム${fi + 1}: HPが下限(${cfg.hpMin})未満です`);
      if (form.maxHp > cfg.hpMax) errors.push(`フォーム${fi + 1}: HPが上限(${cfg.hpMax})超過です`);
    }
  });

  const totalCost = calcMonsterCost(monster, cfg);
  const remaining = cfg.budget - totalCost;

  if (cfg.mode === "balance" && totalCost > cfg.budget) {
    errors.push(`予算超過: ${totalCost.toFixed(1)}pt / ${cfg.budget}pt`);
  }

  return { ok: errors.length === 0, totalCost, remaining, errors };
}

// --- ランダム生成（CPU対戦の相手用） ---

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const RANDOM_LABELS = {
  attack: ["パンチ", "たいあたり", "ひっかき", "かみつき"],
  heal: ["かいふく", "きゅうそく", "いやし"],
  guard: ["ぼうぎょ", "ガード", "かまえる"],
  special: ["ひっさつ", "かくせい", "メガ"],
  none: ["なにもしない", "ぼーっと", "ミス"],
};

/**
 * 単一フォームのランダムなフォームを生成。
 * 極端・全ハズレを避ける軽い下限を設ける。
 */
function randomCharacter(cfg) {
  const maxHp = cfg.mode === "balance"
    ? randInt(cfg.hpMin, cfg.hpMax)
    : randInt(50, 200);

  // 6面: attack を最低1つ入れ、残りはバラけさせる
  const types = ["attack", "attack", "heal", "guard", "special", pick(["attack", "heal", "guard", "none"])];
  // シャッフル
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }

  const actions = types.map((type) => {
    if (type === "none") {
      return { id: makeId(), type, label: pick(RANDOM_LABELS.none), power: 0 };
    }
    const power = randInt(1, 20);
    return { id: makeId(), type, label: pick(RANDOM_LABELS[type]), power };
  });

  return {
    name: "CPU-" + Math.random().toString(36).slice(2, 5).toUpperCase(),
    imageUrl: "",
    maxHp,
    actions,
  };
}

/**
 * ruleConfig の枠内でランダムなモンスターを生成。
 * balance時は validateMonster を通し、超過なら作り直す（数回リトライ）。
 * まずは単一フォーム中心。
 */
export function generateRandomMonster(cfg = defaultRuleConfig()) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const monster = { forms: [randomCharacter(cfg)] };
    if (cfg.mode === "free") return monster;
    if (validateMonster(monster, cfg).ok) return monster;
  }
  // フォールバック: 最小構成（必ず予算内に収まる安全なモンスター）
  return {
    forms: [{
      name: "CPU-MIN",
      imageUrl: "",
      maxHp: cfg.hpMin,
      actions: Array.from({ length: 6 }, (_, i) => ({
        id: makeId(),
        type: i === 0 ? "attack" : "none",
        label: i === 0 ? "パンチ" : "なし",
        power: i === 0 ? 5 : 0,
      })),
    }],
  };
}

export { ACTION_TYPES };
