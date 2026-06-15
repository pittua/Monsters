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
await page.setViewport({ width: 900, height: 820, deviceScaleFactor: 1.5 });
await page.goto("http://localhost:" + port + "/index.html", { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts && document.fonts.ready);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function click(t) {
  const h = await page.evaluateHandle((t) =>
    [...document.querySelectorAll("button,.choice-card")].find((e) => e.textContent.includes(t)) || null, t);
  await h.asElement().click(); await wait(150);
}

await wait(300);
await page.screenshot({ path: "tests/ui-title.png" });

await click("あそぶ"); await wait(200);
await page.screenshot({ path: "tests/ui-matchtype.png" });

await click("CPU対戦"); await click("バランスビルド"); await wait(250);
await page.evaluate(() => {
  const name = document.querySelector('.form-card input[type=text]'); name.value = "ドラゴン"; name.dispatchEvent(new Event("input", { bubbles: true }));
  const set = (i, type, power, label) => {
    const sel = document.querySelectorAll(".face-row select")[i]; sel.value = type; sel.dispatchEvent(new Event("change", { bubbles: true }));
    const row = document.querySelectorAll(".face-row")[i];
    const num = row.querySelector('input[type=number]'); if (num) { num.value = String(power); num.dispatchEvent(new Event("input", { bubbles: true })); }
    const txt = row.querySelector('input[type=text]'); if (txt && label) { txt.value = label; txt.dispatchEvent(new Event("input", { bubbles: true })); }
  };
  set(0, "attack", 14, "ドラゴンクロー");
  set(1, "attack", -10, "ぼうそう");
  set(2, "special", 10, "ほのおブレス");
  set(3, "guard", 8, "うろこガード");
  set(4, "heal", 12, "きゅうそく");
});
await wait(200);
await page.screenshot({ path: "tests/ui-build.png", fullPage: true });

await click("ランダム生成"); await wait(100);
await click("バトル開始");
await page.waitForFunction(() => { const x = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("バトルへ")); return x && !x.disabled; }, { timeout: 8000 });
await click("バトルへ"); await wait(400);
// 数手進める
for (let i = 0; i < 8; i++) {
  const done = await page.evaluate(() => document.body.textContent.includes("の勝利")); if (done) break;
  const h = await page.evaluateHandle(() => { const x = [...document.querySelectorAll("button")].find((e) => e.textContent.includes("サイコロを振る")); return (x && !x.disabled) ? x : null; });
  const e = h.asElement(); if (e) await e.click(); await wait(220);
}
await page.screenshot({ path: "tests/ui-battle.png" });
console.log("captured UI screenshots");
await b.close(); server.close();
