// storage.js — モンスター/ルール設定の localStorage 保存・読込。ブラウザ専用。
// 画像は blob URL のままだと再読込で失効するため、保存時に data URL（base64）へ変換する。
import { makeId } from "./models.js";

const MONSTERS_KEY = "monsters.saved";
const RULECONFIG_KEY = "monsters.ruleConfig";

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(MONSTERS_KEY) || "[]");
  } catch {
    return [];
  }
}
function writeStore(list) {
  localStorage.setItem(MONSTERS_KEY, JSON.stringify(list));
}

/** blob/data URL を data URL（base64文字列）に変換。永続化のため。空なら "" */
async function toDataUrl(imageUrl) {
  if (!imageUrl) return "";
  if (imageUrl.startsWith("data:")) return imageUrl;
  const res = await fetch(imageUrl);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("画像のシリアライズに失敗しました"));
    reader.readAsDataURL(blob);
  });
}

/** 保存用に monster の画像を data URL 化したコピーを作る */
async function serializeMonster(monster) {
  const forms = [];
  for (const form of monster.forms) {
    forms.push({
      name: form.name,
      imageUrl: await toDataUrl(form.imageUrl),
      maxHp: form.maxHp,
      actions: form.actions,
    });
  }
  return { forms };
}

/**
 * モンスターを保存（新規 or 上書き）。
 * @param {import("./models.js").Monster} monster
 * @param {string} [id] 既存IDを渡すと上書き
 * @returns {Promise<string>} 保存ID
 */
export async function saveMonster(monster, id) {
  const list = readStore();
  const data = await serializeMonster(monster);
  const entry = {
    id: id || makeId(),
    name: (monster.forms[0] && monster.forms[0].name) || "名無し",
    formCount: monster.forms.length,
    savedAt: Date.now(),
    monster: data,
  };
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  writeStore(list);
  return entry.id;
}

/** 保存済み一覧（メタ情報のみ） */
export function listMonsters() {
  return readStore()
    .map((e) => ({ id: e.id, name: e.name, formCount: e.formCount, savedAt: e.savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * 保存済みモンスターを読み込む。data URL がそのまま imageUrl として使える。
 * @param {string} id
 * @returns {import("./models.js").Monster|null}
 */
export function loadMonster(id) {
  const entry = readStore().find((e) => e.id === id);
  return entry ? entry.monster : null;
}

/** 保存済みモンスターを削除 */
export function deleteMonster(id) {
  writeStore(readStore().filter((e) => e.id !== id));
}

/** ルール設定を保存 */
export function saveRuleConfig(cfg) {
  localStorage.setItem(RULECONFIG_KEY, JSON.stringify(cfg));
}

/** ルール設定を読み込む（なければ null） */
export function loadRuleConfig() {
  try {
    const s = localStorage.getItem(RULECONFIG_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
