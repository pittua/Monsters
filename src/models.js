// models.js — 型・デフォルト値・定数。UI/通信に依存しない純粋データ層。

/**
 * @typedef {"attack"|"heal"|"guard"|"special"|"transform"|"custom"|"none"} ActionType
 *
 * @typedef {Object} Action
 * @property {string} id
 * @property {ActionType} type
 * @property {string} label
 * @property {number} power            効果量。負でデメリット面。none/transform/custom は 0
 * @property {number} [targetForm]     type==="transform" のときのみ。変身先フォーム index
 * @property {string} [desc]           type==="custom" のときのみ。自由記述の効果説明（手動判定）
 *
 * @typedef {Object} Character
 * @property {string} name
 * @property {string} imageUrl         Blob URL or Base64。未設定は ""
 * @property {number} maxHp
 * @property {Action[]} actions        サイコロ1〜6に対応。必ず6個
 *
 * @typedef {Object} Monster
 * @property {Character[]} forms        forms[0] が初期フォーム
 *
 * @typedef {Object} RuleConfig
 * @property {"free"|"balance"} mode
 * @property {number} budget
 * @property {number} hpPerPoint
 * @property {number} hpMin
 * @property {number} hpMax
 * @property {number} powerMin          マイナス power の下限
 * @property {Record<ActionType, number>} typeBaseCost
 * @property {Record<ActionType, number>} powerCost
 * @property {Record<ActionType, number>} powerRefund
 */

export const ACTION_TYPES = ["attack", "heal", "guard", "special", "transform", "custom", "none"];

// 変身先フォームの割引率（初期フォームは満額、変身先は確率的にしか使えないため割引）
export const FORM_DISCOUNT = 0.5;

// special のダメージ倍率
export const SPECIAL_MULTIPLIER = 2;

/** ランダムID生成（衝突は実用上無視できる） */
export function makeId() {
  return "a" + Math.random().toString(36).slice(2, 10);
}

/** デフォルトのルール設定を生成（mode を指定可能） */
export function defaultRuleConfig(mode = "balance") {
  return {
    mode,
    budget: 100,
    hpPerPoint: 5,
    hpMin: 50,
    hpMax: 200,
    powerMin: -50,
    typeBaseCost: { attack: 0, heal: 1, guard: 1, special: 3, transform: 0, custom: 0, none: 0 },
    powerCost: { attack: 1.0, heal: 1.0, guard: 0.8, special: 1.5, transform: 0, custom: 0, none: 0 },
    powerRefund: { attack: 0.6, heal: 0.6, guard: 0.5, special: 0.8, transform: 0, custom: 0, none: 0 },
  };
}

/** 空の行動（none面） */
export function defaultAction() {
  return { id: makeId(), type: "none", label: "なし", power: 0 };
}

/** デフォルトのフォーム（6面すべて none、HPは中央付近） */
export function defaultCharacter(name = "") {
  return {
    name,
    imageUrl: "",
    maxHp: 100,
    actions: Array.from({ length: 6 }, () => defaultAction()),
  };
}

/** 単一フォームのモンスター */
export function defaultMonster(name = "") {
  return { forms: [defaultCharacter(name)] };
}
