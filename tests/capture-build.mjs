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
await page.setViewport({ width: 900, height: 1200 });
await page.goto("http://localhost:" + port + "/index.html", { waitUntil: "networkidle0" });

async function click(t) {
  const h = await page.evaluateHandle((t) =>
    [...document.querySelectorAll("button,.choice-card")].find((e) => e.textContent.includes(t)) || null, t);
  await h.asElement().click();
  await new Promise((r) => setTimeout(r, 150));
}
await click("あそぶ");
await click("練習対戦");
await click("バランスビルド");
await new Promise((r) => setTimeout(r, 200));

await page.evaluate(() => {
  const name = document.querySelector('.form-card input[type=text]');
  name.value = "ドラゴン"; name.dispatchEvent(new Event("input", { bubbles: true }));
  const set = (idx, type, power) => {
    const sel = document.querySelectorAll(".face-row select")[idx];
    sel.value = type; sel.dispatchEvent(new Event("change", { bubbles: true }));
    const rows = document.querySelectorAll(".face-row");
    const n = rows[idx].querySelector('input[type=number]');
    if (n) { n.value = String(power); n.dispatchEvent(new Event("input", { bubbles: true })); }
  };
  set(0, "attack", 12);
  set(1, "attack", -10); // マイナス面（赤）
  set(2, "special", 8);
  set(3, "guard", 6);
  // とくしゅ（自由記述）面
  const sel = document.querySelectorAll(".face-row select")[4];
  sel.value = "custom"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  const rows = document.querySelectorAll(".face-row");
  const texts = [...rows[4].querySelectorAll('input[type=text]')];
  texts[0].value = "ねむらせ"; texts[0].dispatchEvent(new Event("input", { bubbles: true }));
  const desc = texts.find((t) => /自由に記述/.test(t.placeholder));
  desc.value = "相手を眠らせて次の1回休み"; desc.dispatchEvent(new Event("input", { bubbles: true }));
});
// 変身フォーム追加
await click("フォームを追加");
await new Promise((r) => setTimeout(r, 150));

await page.screenshot({ path: "tests/build-screenshot.png", fullPage: true });
console.log("captured build screen");
await b.close(); server.close();
