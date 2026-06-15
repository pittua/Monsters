// オンライン対戦のブラウザ2ページE2E（実サーバー使用）。
// 結合サーバーを起動 → タブA作成 → タブB参加 → 先攻 → 対戦完走を検証。
import puppeteer from "puppeteer";
import { startServer } from "../server/server.js";

const srv = await startServer({ port: 0 });
const base = `http://localhost:${srv.port}`;
console.log("server on", base);

const browser = await puppeteer.launch({ headless: true, protocolTimeout: 60000 });
const step = (s) => console.log("· " + s);
let failed = 0;
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function newTab() {
  const page = await browser.newPage();
  // 無限アニメ中の要素クリックでスタビリティ待ちがハングするのを避ける
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  page.on("pageerror", (e) => { failed++; console.log("PAGEERROR:", e.message); });
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/i.test(m.text())) { failed++; console.log("CONSOLE:", m.text()); } });
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".title-screen", { timeout: 8000 });
  return page;
}
// クリックはページ内で要素を探して .click() する（ElementHandle のスタビリティ待ちを回避）
async function clickText(page, text) {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button,.choice-card")].find((e) => e.textContent.includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, text);
  if (!ok) throw new Error("not found: " + text);
  await wait(150);
}
// P1 を全面 attack15 / HP50（balance 予算ちょうど）に設定
async function buildFast(page, name) {
  await page.evaluate((nm) => {
    const nameInput = document.querySelector('.form-card input[type=text]');
    nameInput.value = nm; nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    const hp = document.querySelector('.form-card input[type=number]'); hp.value = "50"; hp.dispatchEvent(new Event("input", { bubbles: true }));
    for (let k = 0; k < 6; k++) {
      const sel = document.querySelectorAll(".face-row select")[k]; sel.value = "attack"; sel.dispatchEvent(new Event("change", { bubbles: true }));
      const num = document.querySelectorAll(".face-row")[k].querySelector('input[type=number]'); num.value = "15"; num.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, name);
}
const hasText = (page, t) => page.evaluate((t) => document.body.textContent.includes(t), t);
// 背景タブでは waitForFunction(raf polling) が止まるため、evaluate で手動ポーリングする
async function waitFor(page, fn, label, timeout = 14000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await wait(200);
  }
  throw new Error("waitFor timeout: " + label);
}

try {
  step("opening tabs");
  const A = await newTab();
  const B = await newTab();

  // --- タブA: ルーム作成 ---
  step("A: create room");
  await clickText(A, "あそぶ");
  await clickText(A, "オンライン2人");
  await clickText(A, "ルームを作成");
  await clickText(A, "バランスビルド");
  await wait(200);
  await buildFast(A, "アオ");
  await clickText(A, "ルームを作成");
  // コード取得（待機画面）
  await waitFor(A, () => document.body.textContent.includes("このコードを相手に伝えて"), "A waiting screen");
  const code = await A.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => /^[A-Z2-9]{4}$/.test(d.textContent.trim()));
    return el ? el.textContent.trim() : null;
  });
  check(/^[A-Z2-9]{4}$/.test(code || ""), "host got a room code: " + code);

  // --- タブB: 参加 ---
  await clickText(B, "あそぶ");
  await clickText(B, "オンライン2人");
  await clickText(B, "ルームに参加");
  await B.evaluate((c) => {
    const inp = document.querySelector("input[type=text]");
    inp.value = c; inp.dispatchEvent(new Event("input", { bubbles: true }));
  }, code);
  await clickText(B, "接続する");
  // peek 後、ホストのルールでビルド画面へ
  await waitFor(B, () => !!document.querySelector(".face-row"), "B build screen");
  check(await hasText(B, "バランスビルド") || await hasText(B, "残り"), "joiner sees build screen under host rule");
  await buildFast(B, "アカ");
  await clickText(B, "参加する");
  step("B: joined, waiting for battle");

  // --- 両者: 先攻 → バトルへ ---
  const snap = async (p, tag) => console.log(`  [${tag}] ` + (await p.evaluate(() => document.querySelector("#screen").textContent.replace(/\s+/g, " ").slice(0, 120))));
  try {
    await waitFor(A, () => !!document.querySelector(".arena"), "A arena");
    await waitFor(B, () => !!document.querySelector(".arena"), "B arena");
    check(true, "both tabs entered battle arena");
  } catch (e) {
    await snap(A, "A"); await snap(B, "B");
    throw e;
  }

  // --- 再接続: タブBをリロードして同一ルームへ復帰 ---
  step("B: reload to test reconnect");
  await B.reload({ waitUntil: "domcontentloaded" });
  await B.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await waitFor(B, () => document.body.textContent.includes("対戦に復帰しますか"), "B resume prompt");
  check(true, "reload offers resume prompt (session persisted)");
  // A は相手切断→復帰待ちを表示しているはず
  check(await hasText(A, "相手が切断") || await hasText(A, "復帰"), "host sees opponent disconnected (grace)");
  await A.bringToFront(); await A.screenshot({ path: "tests/online-disconnect.png" });
  await B.bringToFront(); await B.screenshot({ path: "tests/online-resume-prompt.png" });
  await clickText(B, "復帰する");
  await waitFor(B, () => !!document.querySelector(".arena"), "B re-entered arena");
  await waitFor(A, () => !!document.querySelector(".arena"), "A back to arena after opponent returned");
  check(true, "B reconnected and both resumed the same battle");

  // 手番のタブだけ「サイコロを振る」が有効。決着まで進める。
  let winnerSeen = false;
  for (let i = 0; i < 120; i++) {
    if (await hasText(A, "勝ち") || await hasText(A, "負け") || await hasText(A, "勝者")) { winnerSeen = true; break; }
    for (const page of [A, B]) {
      const clicked = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("サイコロを振る"));
        if (b && !b.disabled) { b.click(); return true; }
        return false;
      });
      if (clicked) { await wait(200); break; }
    }
    await wait(150);
  }
  check(winnerSeen, "online battle played to a result on host tab");
  let bResult = false;
  try { await waitFor(B, () => /勝者|勝ち|負け/.test(document.body.textContent), "B result", 8000); bResult = true; } catch {}
  check(bResult, "joiner tab also reached result");
  // 両者が同じ勝者を見ているか（権威ある同一状態）
  const aWin = await A.evaluate(() => document.body.textContent.includes("あなたの勝ち"));
  const bWin = await B.evaluate(() => document.body.textContent.includes("あなたの勝ち"));
  check(aWin !== bWin, "exactly one player sees a win (consistent authoritative result)");

  await A.bringToFront(); await A.screenshot({ path: "tests/online-hostA.png" });
  await B.bringToFront(); await B.screenshot({ path: "tests/online-joinB.png" });
} catch (e) {
  failed++; console.log("ERROR:", e.message);
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
await browser.close();
await srv.close();
process.exit(failed === 0 ? 0 : 1);
