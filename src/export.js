// export.js — .monst（zip）の書き出し/読み込み。JSZip を使用。
// JSZip は index.html で CDN script として読み込み、グローバル window.JSZip を参照する。

const FILENAME_MAX = 50;

/** グローバルの JSZip を取得。未ロードならエラー。 */
function getJSZip() {
  const Z = (typeof window !== "undefined" && window.JSZip) || (typeof globalThis !== "undefined" && globalThis.JSZip);
  if (!Z) throw new Error("JSZip が読み込まれていません（CDN script を確認してください）");
  return Z;
}

/** MIME から拡張子を決定 */
function extFromType(type) {
  switch (type) {
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/png":
    default: return "png";
  }
}

/** imageUrl（blob: または data: URL）から Blob を取得。空なら null。 */
async function urlToBlob(imageUrl) {
  if (!imageUrl) return null;
  const res = await fetch(imageUrl);
  return await res.blob();
}

/**
 * .monst（zip）を生成。全フォームの monster.json と各フォーム画像を同梱。
 * @param {import("./models.js").Monster} monster
 * @returns {Promise<Blob>}
 */
export async function exportMonster(monster) {
  const JSZip = getJSZip();
  const zip = new JSZip();

  // monster.json 用に imageUrl を画像参照名へ置き換えたフォーム配列を作る
  const formsMeta = [];
  for (let i = 0; i < monster.forms.length; i++) {
    const form = monster.forms[i];
    const blob = await urlToBlob(form.imageUrl);
    let imageName = null;
    if (blob) {
      imageName = `form${i}.${extFromType(blob.type)}`;
      zip.file(imageName, blob);
    }
    formsMeta.push({
      name: form.name,
      maxHp: form.maxHp,
      actions: form.actions,
      image: imageName, // null なら画像なし（読み込み時はデフォルトアバター）
    });
  }

  const json = { version: 1, forms: formsMeta };
  zip.file("monster.json", JSON.stringify(json, null, 2));

  return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

/**
 * .monst（zip）を読み、全フォームと画像を復元して Monster を返す。
 * @param {File|Blob} file
 * @returns {Promise<import("./models.js").Monster>}
 */
export async function importMonster(file) {
  const JSZip = getJSZip();
  // ArrayBuffer はあらゆる環境で JSZip が受け付ける（Blob は環境依存があるため変換）
  const data = (file && typeof file.arrayBuffer === "function") ? await file.arrayBuffer() : file;
  const zip = await JSZip.loadAsync(data);

  const jsonFile = zip.file("monster.json");
  if (!jsonFile) throw new Error("monster.json が見つかりません（不正な .monst ファイル）");
  const json = JSON.parse(await jsonFile.async("string"));
  if (!json.forms || !Array.isArray(json.forms)) {
    throw new Error("monster.json の構造が不正です");
  }

  const forms = [];
  for (const meta of json.forms) {
    let imageUrl = "";
    if (meta.image) {
      const imgFile = zip.file(meta.image);
      if (imgFile) {
        const blob = await imgFile.async("blob");
        imageUrl = URL.createObjectURL(blob);
      }
    }
    forms.push({
      name: meta.name || "",
      imageUrl,
      maxHp: meta.maxHp,
      actions: meta.actions,
    });
  }

  if (forms.length === 0) throw new Error("フォームが1つもありません");
  return { forms };
}

/**
 * ファイル名用に安全化。使用不可文字を置換、長さ切り詰め、空なら "monster"。
 * 元の名前は monster.json 内に正確に保持されるため、これはファイル名専用。
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFileName(name) {
  let s = (name || "").trim();
  // 使用不可文字（/ \ : * ? " < > |）と制御文字を _ に
  s = s.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
  // 連続する _ をまとめ、前後の . と空白を除去
  s = s.replace(/_+/g, "_").replace(/^[.\s_]+|[.\s_]+$/g, "");
  if (s.length > FILENAME_MAX) s = s.slice(0, FILENAME_MAX);
  if (!s) s = "monster";
  return s;
}

/**
 * exportMonster + sanitizeFileName で {初期フォーム名}.monst をダウンロード。
 * @param {import("./models.js").Monster} monster
 */
export async function downloadMonster(monster) {
  const blob = await exportMonster(monster);
  const base = sanitizeFileName(monster.forms[0] && monster.forms[0].name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}.monst`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 少し遅らせて revoke（一部ブラウザで即時 revoke するとDLが失敗するため）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
