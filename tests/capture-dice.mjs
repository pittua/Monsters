import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer";

const ROOT = process.cwd();
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const d = await readFile(f);
    res.writeHead(200, { "Content-Type": MIME[extname(f)] || "application/octet-stream" });
    res.end(d);
  } catch { res.writeHead(404); res.end("x"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const b = await puppeteer.launch({ headless: "new" });
const page = await b.newPage();
await page.setViewport({ width: 900, height: 900 });
await page.goto("http://localhost:" + port + "/index.html", { waitUntil: "networkidle0" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function click(t) {
  const h = await page.evaluateHandle((t) =>
    [...document.querySelectorAll("button,.choice-card")].find((e) => e.textContent.includes(t)) || null, t);
  await h.asElement().click(); await wait(120);
}

await click("あそぶ"); await click("CPU対戦"); await click("バランスビルド"); await wait(200);
await page.evaluate(() => {
  const hp = document.querySelector('.form-card input[type=number]'); hp.value = "50"; hp.dispatchEvent(new Event("input", { bubbles: true }));
  for (let k = 0; k < 6; k++) {
    const sel = document.querySelectorAll(".face-row select")[k]; sel.value = "attack"; sel.dispatchEvent(new Event("change", { bubbles: true }));
    const num = document.querySelectorAll(".face-row")[k].querySelector('input[type=number]'); num.value = "12"; num.dispatchEvent(new Event("input", { bubbles: true }));
    const lbl = document.querySelectorAll(".face-row")[k].querySelector('input[type=text]'); lbl.value = ["パンチ", "キック", "たいあたり", "ひっかき", "とっしん", "かみつき"][k]; lbl.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await click("スライムくん"); await wait(100);
await click("バトル開始");
// 先攻アニメ中（立体ダイスが転がっている瞬間）を撮る
await wait(500);
await page.screenshot({ path: "tests/dice-initiative-rolling.png" });
// 着地・ボタン有効化を待ってバトルへ
await page.waitForFunction(() => {
  const x = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("バトルへ"));
  return x && !x.disabled;
}, { timeout: 8000 });
await click("バトルへ"); await wait(400);

// 何手か進めて出目マークを溜める
for (let i = 0; i < 14; i++) {
  const done = await page.evaluate(() => document.body.textContent.includes("の勝利"));
  if (done) break;
  const h = await page.evaluateHandle(() => {
    const x = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("サイコロを振る"));
    return (x && !x.disabled) ? x : null;
  });
  const e = h.asElement();
  if (e) await e.click();
  await wait(200);
}
await page.screenshot({ path: "tests/dice-battle-marks.png" });
console.log("captured dice screenshots");
await b.close(); server.close();
