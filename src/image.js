// image.js — 画像処理層。ブラウザ専用（canvas/Image/Blob を使用）。
// 縮小は canvas 経由で非同期になる点に注意。

export const MAX_DIMENSION = 1024;            // 長辺の上限px
export const MAX_FILE_SIZE = 8 * 1024 * 1024; // 元ファイルサイズ上限（8MB）
export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * 画像ファイルを受け取り、長辺1024px超なら canvas でアスペクト比維持縮小して Blob を返す。
 * 1024px以下はそのまま（原画質保持）。gif はここで静止画化される（1コマ目）。
 * 結果を保存・表示・zip同梱・送信に一貫使用する。
 * @param {File|Blob} file
 * @returns {Promise<Blob>}
 */
export async function processImage(file) {
  if (file.type && !ALLOWED_TYPES.includes(file.type)) {
    throw new Error(`未対応の画像形式です: ${file.type}`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`画像が大きすぎます（上限 ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB）`);
  }

  const img = await loadImage(file);
  const { width, height } = img;
  const longSide = Math.max(width, height);

  // 上限以下はそのまま返す（縮小しない＝原画質を保つ）
  if (longSide <= MAX_DIMENSION) {
    closeImage(img);
    return file;
  }

  const scale = MAX_DIMENSION / longSide;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  closeImage(img);

  // gif/未対応の出力形式は png に正規化。png は透過保持、それ以外は元形式優先。
  const outType = (file.type === "image/jpeg" || file.type === "image/webp")
    ? file.type
    : "image/png";

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("画像の変換に失敗しました"))),
      outType,
      0.92
    );
  });
  return blob;
}

/** File/Blob を Image 要素として読み込む（createImageBitmap があればそちらを優先） */
async function loadImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // フォールバックへ
    }
  }
  // Blob URL は drawImage まで保持が必要。closeImage で解放する。
  const url = URL.createObjectURL(file);
  return await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像の読み込みに失敗しました"));
    };
    im.src = url;
  });
}

function closeImage(img) {
  if (img && typeof img.close === "function") img.close(); // ImageBitmap
  // Image 経由で作った Blob URL を解放
  if (img && img.src && img.src.startsWith("blob:")) {
    URL.revokeObjectURL(img.src);
  }
}

// 頭文字アバター用のパレット（背景色）。名前から決定的に選ぶ。
const AVATAR_COLORS = [
  "#e76f51", "#2a9d8f", "#e9c46a", "#f4a261", "#264653",
  "#8338ec", "#3a86ff", "#ff006e", "#fb5607", "#06d6a0",
  "#118ab2", "#ef476f", "#073b4c", "#7209b7", "#4361ee",
];

/** 文字列から決定的なハッシュ（同じ名前→同じ値） */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 名前の頭文字を取り出す（空なら "?"） */
function initialOf(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  // サロゲートペア対応で先頭1文字
  return Array.from(trimmed)[0];
}

/**
 * 画像未設定時のフォールバック。名前の頭文字＋名前由来の背景色を描画した
 * data URL を返す。同じ名前は常に同じ色。
 * @param {string} name
 * @param {number} [size]
 * @returns {string} data URL (PNG)
 */
export function defaultAvatar(name, size = 256) {
  const color = AVATAR_COLORS[hashString(name || "?") % AVATAR_COLORS.length];
  const letter = initialOf(name);

  // ブラウザに canvas があればそれで描画、なければ SVG data URL でフォールバック
  if (typeof document !== "undefined" && document.createElement) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(size * 0.5)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, size / 2, size / 2 + size * 0.02);
    return canvas.toDataURL("image/png");
  }

  // 非ブラウザ環境フォールバック
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<rect width="100%" height="100%" fill="${color}"/>`
    + `<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#fff" `
    + `font-family="sans-serif" font-weight="bold" font-size="${Math.round(size * 0.5)}">`
    + `${escapeXml(letter)}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

/** 表示用の画像 src を返す。imageUrl が空なら名前からアバター生成。 */
export function displaySrc(character) {
  return character.imageUrl || defaultAvatar(character.name);
}
