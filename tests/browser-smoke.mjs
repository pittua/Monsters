// ブラウザ実機スモークテスト（puppeteer）。
// 静的サーバを立て、ブラウザ専用コード（JSZip/canvas縮小/アバター）を実地検証する。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer";

const ROOT = process.cwd();
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;
console.log("server on", base);

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();

const errors = [];
const notFound = [];
page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  // favicon の自動取得失敗はアプリの問題ではないので除外
  if (/favicon/i.test(t)) return;
  if (/Failed to load resource/i.test(t)) return; // URLは notFound 側で精査
  errors.push("console: " + t);
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

let failed = 0;
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failed++; };

await page.goto(base + "/index.html", { waitUntil: "networkidle0" });

// JSZip がCDNから読み込まれている
check(await page.evaluate(() => typeof window.JSZip === "function"), "JSZip CDN loaded");

// --- ブラウザ専用ロジックを page 内で直接検証 ---
const results = await page.evaluate(async () => {
  const out = {};
  const img = await import("/src/image.js");
  const exp = await import("/src/export.js");

  // defaultAvatar: canvas経路で PNG data URL
  const av = img.defaultAvatar("ドラゴン");
  out.avatarIsPng = av.startsWith("data:image/png");
  out.avatarDeterministic = img.defaultAvatar("ドラゴン") === av;

  // canvas で大きい画像を作って processImage で縮小
  function makeCanvasBlob(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#3a86ff"; ctx.fillRect(0, 0, w, h);
    return new Promise((res) => c.toBlob(res, "image/png"));
  }
  function blobDims(blob) {
    return new Promise(async (res) => {
      const bmp = await createImageBitmap(blob);
      res({ w: bmp.width, h: bmp.height });
    });
  }

  const bigBlob = await makeCanvasBlob(2000, 1000);
  const big = new File([bigBlob], "big.png", { type: "image/png" });
  const processedBig = await img.processImage(big);
  const dimBig = await blobDims(processedBig);
  out.bigResized = (Math.max(dimBig.w, dimBig.h) === 1024) && (dimBig.w === 1024 && dimBig.h === 512);

  const smallBlob = await makeCanvasBlob(300, 200);
  const small = new File([smallBlob], "small.png", { type: "image/png" });
  const processedSmall = await img.processImage(small);
  out.smallPassthrough = (processedSmall === small); // 1024以下は原画そのまま

  // export/import 往復（画像付き）
  const imgBlob = await makeCanvasBlob(64, 64);
  const url = URL.createObjectURL(imgBlob);
  const monster = {
    forms: [{
      name: "炎の戦士", imageUrl: url, maxHp: 120,
      actions: Array.from({ length: 6 }, (_, i) => ({ id: "x" + i, type: i === 0 ? "attack" : "none", label: "面" + i, power: i === 0 ? 15 : 0 })),
    }],
  };
  const zipBlob = await exp.exportMonster(monster);
  out.zipSize = zipBlob.size;
  const restored = await exp.importMonster(zipBlob);
  out.nameRestored = restored.forms[0].name === "炎の戦士";
  out.imageRestored = !!restored.forms[0].imageUrl && restored.forms[0].imageUrl.startsWith("blob:");
  out.actionsRestored = restored.forms[0].actions[0].power === 15;

  return out;
});

check(results.avatarIsPng, "defaultAvatar uses canvas (PNG data URL)");
check(results.avatarDeterministic, "defaultAvatar deterministic");
check(results.bigResized, "processImage resizes 2000x1000 -> 1024x512");
check(results.smallPassthrough, "processImage passes through <=1024 original");
check(results.zipSize > 0, "exportMonster produced zip (" + results.zipSize + " bytes)");
check(results.nameRestored, "importMonster restored name");
check(results.imageRestored, "importMonster restored image as blob URL");
check(results.actionsRestored, "importMonster restored actions");

// --- UI クリックスルー（main.js 配線確認） ---
async function clickByText(text) {
  const handle = await page.evaluateHandle((t) => {
    const els = [...document.querySelectorAll("button, .choice-card")];
    return els.find((e) => e.textContent.includes(t)) || null;
  }, text);
  const elh = handle.asElement();
  if (!elh) throw new Error("button not found: " + text);
  await elh.click();
  await new Promise((r) => setTimeout(r, 150));
}

await clickByText("あそぶ");
await clickByText("CPU対戦");
await clickByText("バランスビルド");
await new Promise((r) => setTimeout(r, 200));
const onBuild = await page.evaluate(() => document.body.textContent.includes("CPUの相手をえらぶ"));
check(onBuild, "navigated to build screen with CPU chooser");

// とくしゅ（自由記述）面: 専用の自由記述入力欄が出る
const customOk = await page.evaluate(() => {
  const sel = document.querySelectorAll(".face-row select")[0];
  sel.value = "custom";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  const row = document.querySelectorAll(".face-row")[0];
  const inputs = [...row.querySelectorAll('input[type=text]')];
  return inputs.some((i) => /自由に記述/.test(i.placeholder)) && row.classList.contains("custom");
});
check(customOk, "custom type reveals free-text description input");

// P1 を全面攻撃15・HP50（予算ちょうど100pt）に設定し、決着が確実につくようにする。
// 型セレクト変更でエディタが再構築されるため、毎回 re-query する。
await page.evaluate(() => {
  const hp = document.querySelector('.form-card input[type=number]'); // 先頭のnumber=HP
  hp.value = "50";
  hp.dispatchEvent(new Event("input", { bubbles: true }));
  for (let k = 0; k < 6; k++) {
    const sel = document.querySelectorAll(".face-row select")[k];
    sel.value = "attack";
    sel.dispatchEvent(new Event("change", { bubbles: true })); // ここで再構築
    const rows = document.querySelectorAll(".face-row");
    const num = rows[k].querySelector('input[type=number]');
    num.value = "15";
    num.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
// 弱いプリセットを相手にして短時間で決着
await clickByText("スライムくん");
await new Promise((r) => setTimeout(r, 100));
await clickByText("バトル開始");
// 先攻演出（両ダイスのアニメ）→「バトルへ」ボタンが有効化されるまで待つ
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("バトルへ"));
  return b && !b.disabled;
}, { timeout: 8000 });
// 先攻決定の演出スクショ
await page.screenshot({ path: "tests/initiative-screenshot.png" });
await clickByText("バトルへ");
await new Promise((r) => setTimeout(r, 500));
const inBattle = await page.evaluate(() => !!document.querySelector(".arena"));
check(inBattle, "entered battle arena");

// 両者の技一覧が表示される（各6面）
const moveListsOk = await page.evaluate(() => {
  const lists = document.querySelectorAll(".movelist");
  if (lists.length !== 2) return false;
  return [...lists].every((l) => l.querySelectorAll(".move").length === 6);
});
check(moveListsOk, "battle shows both players' move lists (6 each)");

await page.screenshot({ path: "tests/battle-screenshot.png" });

// --- 決着まで進める（人間手番は押す、CPU手番は自動ロールを待つ） ---
let result = false;
for (let i = 0; i < 700; i++) {
  result = await page.evaluate(() => document.body.textContent.includes("の勝利"));
  if (result) break;
  const btn = await page.evaluateHandle(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("サイコロを振る"));
    return (b && !b.disabled) ? b : null;
  });
  const e = btn.asElement();
  if (e) await e.click();
  await new Promise((r) => setTimeout(r, 120));
}
check(result, "battle played to a winner (result screen)");
await page.screenshot({ path: "tests/result-screenshot.png" });

const realNotFound = notFound.filter((u) => !/favicon/i.test(u));
check(realNotFound.length === 0, "no missing resources (404)" + (realNotFound.length ? ": " + realNotFound.join(", ") : ""));
check(errors.length === 0, "no console/page errors" + (errors.length ? ": " + errors.join(" | ") : ""));

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
await browser.close();
server.close();
process.exit(failed === 0 ? 0 : 1);
