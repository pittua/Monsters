// presets.js — CPU対戦用の同梱プリセットモンスター（チュートリアル的な相手）。
import { makeId } from "./models.js";

function a(type, label, power, targetForm) {
  const obj = { id: makeId(), type, label, power };
  if (targetForm != null) obj.targetForm = targetForm;
  return obj;
}

/** プリセット一覧を返す（毎回新しいIDで生成） */
export function getPresets() {
  return [
    {
      name: "スライムくん",
      monster: {
        forms: [{
          name: "スライムくん",
          imageUrl: "",
          maxHp: 90,
          actions: [
            a("attack", "たいあたり", 8),
            a("attack", "たいあたり", 8),
            a("heal", "ぷるぷる回復", 10),
            a("guard", "ぼうぎょ", 6),
            a("attack", "とっしん", 14),
            a("none", "ぼーっと", 0),
          ],
        }],
      },
    },
    {
      name: "ゴーレム",
      monster: {
        forms: [{
          name: "ゴーレム",
          imageUrl: "",
          maxHp: 160,
          actions: [
            a("guard", "がんせきガード", 12),
            a("attack", "なぐる", 12),
            a("attack", "なぐる", 12),
            a("guard", "かまえる", 10),
            a("special", "だいばくれつ", 16),
            a("none", "うごかない", 0),
          ],
        }],
      },
    },
    {
      name: "ドラゴン（変身）",
      monster: {
        forms: [
          {
            name: "ドラゴン",
            imageUrl: "",
            maxHp: 110,
            actions: [
              a("attack", "かみつき", 12),
              a("attack", "ひっかき", 10),
              a("guard", "うろこガード", 8),
              a("heal", "きゅうそく", 12),
              a("attack", "テイル", 14),
              a("transform", "覚醒する", 0, 1),
            ],
          },
          {
            name: "覚醒ドラゴン",
            imageUrl: "",
            maxHp: 150,
            actions: [
              a("special", "ブレス", 20),
              a("special", "ブレス", 20),
              a("attack", "かみつき", 18),
              a("attack", "テイル", 16),
              a("guard", "りゅうのまもり", 12),
              a("heal", "りゅうの回復", 15),
            ],
          },
        ],
      },
    },
  ];
}
