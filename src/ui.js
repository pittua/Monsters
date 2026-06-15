// ui.js — DOM描画・イベント・再利用コンポーネント。
import { ACTION_TYPES } from "./models.js";
import { calcActionCost, calcCharacterCost, calcMonsterCost, validateMonster } from "./rules.js";
import { displaySrc, processImage } from "./image.js";

// --- DOM ユーティリティ ---

/**
 * 要素を生成。props は className/text/html/style/value/disabled/on* イベントなど。
 * children は要素 or 文字列の配列。
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") node.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") node[k] = v;
    else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(node, ...children) {
  clear(node);
  for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
}

let toastTimer = null;
export function toast(message, isBad = false) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", { className: "toast" + (isBad ? " bad" : ""), text: message });
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

// --- 表示コンポーネント ---

export function avatarImg(character, className = "avatar-preview") {
  return el("img", { className, src: displaySrc(character), alt: character.name || "" });
}

export function hpBar(hp, maxHp) {
  const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  const wrap = el("div", { className: "hpbar" + (pct <= 30 ? " low" : "") }, [
    el("div", { style: { width: pct + "%" } }),
  ]);
  return wrap;
}

const TYPE_LABELS = {
  attack: "こうげき", heal: "かいふく", guard: "ガード",
  special: "ひっさつ", transform: "へんしん", custom: "とくしゅ", none: "なし",
};

// --- サイコロ演出 ---

const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
/** 1〜6 を出目の絵に変換（技一覧の小アイコン用） */
export function diceFace(n) {
  return DICE_FACES[n - 1] || "🎲";
}

// 各目をビューア正面に向けるためのキューブ回転角 [rotateX, rotateY]
const FACE_ANGLE = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };
// 各目のピップ配置（3x3グリッドの埋めるセル）
const PIP_LAYOUT = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

/**
 * 立体（3D CSS キューブ）のサイコロ要素を生成。1の目だけ赤。
 * @param {number} [size] px
 */
export function makeDice(size = 72) {
  const root = el("div", { className: "dice3d" });
  root.style.setProperty("--dice-size", size + "px");
  const cube = el("div", { className: "cube" });
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const face = el("div", { className: "cube-face face-" + n });
    for (let i = 0; i < 9; i++) {
      const cell = el("span", { className: "pip-cell" });
      if (PIP_LAYOUT[n].includes(i)) {
        cell.appendChild(el("span", { className: "pip" + (n === 1 ? " pip-red" : "") }));
      }
      face.appendChild(cell);
    }
    cube.appendChild(face);
  }
  root.appendChild(cube);
  root._cube = cube;
  setDiceFace(root, 1);
  return root;
}

/** サイコロの表示を指定の目に向ける（アニメなし） */
export function setDiceFace(diceEl, n) {
  const cube = diceEl._cube || diceEl.querySelector(".cube");
  const [ax, ay] = FACE_ANGLE[n] || FACE_ANGLE[1];
  cube.style.transition = "none";
  cube.style.transform = `rotateX(${ax}deg) rotateY(${ay}deg)`;
}

/**
 * サイコロを振っている演出。立体的に転がり、最後に finalN へ弾むように着地する。
 * @param {HTMLElement} diceEl makeDice() で作った要素
 * @param {number} finalN 最終的な出目(1〜6)
 * @param {number} [duration] 転がり時間(ms)
 * @returns {Promise<void>} 着地したら解決
 */
export function animateDiceRoll(diceEl, finalN, duration = 1000) {
  return new Promise((resolve) => {
    const cube = diceEl._cube || diceEl.querySelector(".cube");
    diceEl.classList.add("rolling");
    const start = performance.now();
    let rx = 0, ry = 0;
    function tick() {
      const t = performance.now() - start;
      // 同方向に転がし続ける（立体的なタンブル）
      rx += 120 + Math.random() * 200;
      ry += 120 + Math.random() * 200;
      cube.style.transition = "transform .12s linear";
      cube.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
      if (t < duration) {
        const interval = 80 + (t / duration) ** 2 * 120; // 終盤ほど減速
        setTimeout(tick, interval);
      } else {
        // 進行方向そのままに、最終の目の向きへ「弾む」ように着地
        const [ax, ay] = FACE_ANGLE[finalN] || FACE_ANGLE[1];
        const fx = Math.ceil(rx / 360) * 360 + 360 + ax;
        const fy = Math.ceil(ry / 360) * 360 + 360 + ay;
        diceEl.classList.remove("rolling");
        diceEl.classList.add("land");
        cube.style.transition = "transform .75s cubic-bezier(.2,1.8,.35,1)"; // オーバーシュート＝弾く感じ
        cube.style.transform = `rotateX(${fx}deg) rotateY(${fy}deg)`;
        setTimeout(() => { diceEl.classList.remove("land"); resolve(); }, 760);
      }
    }
    tick();
  });
}

/**
 * 1面の効果を短い文言にまとめる（技一覧表示用）。
 * @param {import("./models.js").Action} action
 * @param {import("./models.js").Character[]} forms 変身先名の解決に使用
 */
export function actionSummary(action, forms) {
  const p = action.power || 0;
  switch (action.type) {
    case "attack": return p >= 0 ? `相手に${p}` : `自分に${Math.abs(p)}(自爆)`;
    case "special": return p >= 0 ? `相手に${p * 2}(必殺)` : `自分に${Math.abs(p) * 2}(大暴発)`;
    case "heal": return p >= 0 ? `回復${p}` : `自分に${Math.abs(p)}(反動)`;
    case "guard": return p >= 0 ? `被ダメ-${p}` : `被ダメ+${Math.abs(p)}(無防備)`;
    case "transform": {
      const t = forms && forms[action.targetForm];
      return `→ ${(t && t.name) || "?"}に変身`;
    }
    case "custom": return (action.desc && action.desc.trim()) || "(自由記述)";
    case "none":
    default: return (action.desc && action.desc.trim()) || "なし";
  }
}

/**
 * バトル画面の技一覧。現フォームの6面を表示。highlightDice で直近の出目を強調し、
 * これまでに出た出目（counts）にマークを付ける。
 * @param {import("./models.js").PlayerState} player
 * @param {string} title
 * @param {number|null} highlightDice 1〜6 or null
 * @param {number[]} [counts] index 1〜6 = その目が出た回数
 */
export function renderMoveList(player, title, highlightDice, counts = []) {
  const ch = player.monster.forms[player.currentForm];
  const rows = ch.actions.map((a, i) => {
    const die = i + 1;
    const rolled = (counts[die] || 0) > 0;
    const mark = rolled ? "✓" : "";
    return el("div", {
      className: "move"
        + (highlightDice === die ? " hot" : "")
        + (rolled ? " rolled" : "")
        + (a.type === "transform" ? " mv-transform" : ""),
    }, [
      el("span", { className: "mv-die" + (die === 1 ? " die-one" : ""), text: diceFace(die) }),
      el("span", { className: "mv-label", text: a.label || TYPE_LABELS[a.type] }),
      el("span", { className: "mv-eff", text: actionSummary(a, player.monster.forms) }),
      el("span", { className: "mv-mark", text: mark }),
    ]);
  });
  return el("div", { className: "movelist panel" }, [
    el("div", { className: "mv-title", text: title }),
    ...rows,
  ]);
}

// --- モンスター作成エディタ ---

/**
 * モンスター作成エディタを生成。monster をその場で書き換え、変化時に onChange を呼ぶ。
 * @param {import("./models.js").Monster} monster
 * @param {import("./models.js").RuleConfig} cfg
 * @param {() => void} onChange  予算表示などの再計算に使う
 * @param {string} title
 */
export function renderMonsterEditor(monster, cfg, onChange, title) {
  const root = el("div", { className: "editor panel" });

  function rerender() {
    clear(root);
    root.appendChild(el("h2", { text: title }));

    monster.forms.forEach((form, fi) => {
      root.appendChild(renderFormCard(monster, form, fi, cfg, () => { rerender(); onChange(); }, onChange));
    });

    const addBtn = el("button", {
      className: "ghost",
      text: "＋ フォームを追加（変身先）",
      onClick: () => {
        monster.forms.push({
          name: "",
          imageUrl: "",
          maxHp: 100,
          actions: Array.from({ length: 6 }, () => ({ id: rid(), type: "none", label: "なし", power: 0 })),
        });
        rerender();
        onChange();
      },
    });
    root.appendChild(addBtn);
  }

  rerender();
  return root;
}

function rid() { return "a" + Math.random().toString(36).slice(2, 10); }

function renderFormCard(monster, form, fi, cfg, rerenderAll, onChange) {
  const card = el("div", { className: "form-card" });

  // --- ヘッダ: 画像 / 名前 / HP ---
  const preview = avatarImg(form);
  const fileInput = el("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/webp,image/gif",
    onChange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const blob = await processImage(file); // 縮小は非同期
        if (form.imageUrl && form.imageUrl.startsWith("blob:")) URL.revokeObjectURL(form.imageUrl);
        form.imageUrl = URL.createObjectURL(blob);
        preview.src = displaySrc(form);
        onChange();
      } catch (err) {
        toast(err.message || "画像の処理に失敗しました", true);
      }
    },
  });

  const nameInput = el("input", {
    type: "text", value: form.name, placeholder: fi === 0 ? "モンスター名" : `変身先${fi}の名前`,
    onInput: (e) => { form.name = e.target.value; preview.src = displaySrc(form); onChange(); },
  });

  const hpInput = el("input", {
    type: "number", value: form.maxHp, min: cfg.mode === "balance" ? cfg.hpMin : 1,
    max: cfg.mode === "balance" ? cfg.hpMax : 9999, step: 5,
    onInput: (e) => { form.maxHp = parseInt(e.target.value, 10) || 0; onChange(); refreshCosts(); },
  });

  const removeBtn = fi === 0 ? null : el("button", {
    className: "danger ghost", text: "フォーム削除",
    onClick: () => {
      if (form.imageUrl && form.imageUrl.startsWith("blob:")) URL.revokeObjectURL(form.imageUrl);
      monster.forms.splice(fi, 1);
      // 削除されたフォームを指す transform をクリーンアップ
      for (const f of monster.forms) {
        for (const act of f.actions) {
          if (act.type === "transform" && act.targetForm != null) {
            if (act.targetForm === fi) { act.type = "none"; act.power = 0; delete act.targetForm; }
            else if (act.targetForm > fi) act.targetForm -= 1;
          }
        }
      }
      rerenderAll();
    },
  });

  const head = el("div", { className: "form-head" }, [
    el("div", { className: "col" }, [preview, fileInput]),
    el("div", { className: "col", style: { flex: "1", minWidth: "200px" } }, [
      el("label", { text: fi === 0 ? "名前（初期フォーム）" : `名前（フォーム${fi}）` }),
      nameInput,
      el("div", { className: "row" }, [
        el("label", { text: "最大HP" }), hpInput,
        cfg.mode === "balance" ? el("span", { className: "muted", text: `(${cfg.hpMin}〜${cfg.hpMax})` }) : null,
      ]),
    ]),
    removeBtn,
  ]);
  card.appendChild(head);

  // --- 6面 ---
  const faces = el("div", { className: "faces" });
  const costRefreshers = [];
  form.actions.forEach((action, ai) => {
    const { row, refresh } = renderFaceRow(monster, action, ai, cfg, () => { rerenderAll(); }, onChange);
    faces.appendChild(row);
    costRefreshers.push(refresh);
  });
  card.appendChild(faces);

  const formCostLine = el("div", { className: "cost-detail" });
  card.appendChild(formCostLine);

  function refreshCosts() {
    costRefreshers.forEach((fn) => fn());
    const c = calcCharacterCost(form, cfg);
    formCostLine.textContent = `このフォームのコスト: ${c.toFixed(1)}pt` + (fi > 0 ? "（変身先は0.5倍で合算）" : "");
  }
  refreshCosts();

  return card;
}

function renderFaceRow(monster, action, ai, cfg, rerenderAll, onChange) {
  // custom と none は自由記述欄を持つので幅広レイアウト(freetext)。custom は青枠も付ける。
  const freetext = (action.type === "custom" || action.type === "none");
  const row = el("div", {
    className: "face-row" + (freetext ? " freetext" : "") + (action.type === "custom" ? " custom" : ""),
  });

  const typeSel = el("select", {
    onChange: (e) => {
      action.type = e.target.value;
      if (action.type === "transform") {
        action.power = 0;
        delete action.desc;
        if (action.targetForm == null) action.targetForm = firstOtherForm(monster, ai);
      } else if (action.type === "custom") {
        action.power = 0;
        delete action.targetForm;
        if (action.desc == null) action.desc = "";
      } else if (action.type === "none") {
        action.power = 0;
        delete action.targetForm;
        if (action.desc == null) action.desc = "";
      } else {
        delete action.targetForm;
        delete action.desc;
      }
      rerenderAll(); // transform先セレクトの出し入れのため作り直す
      onChange();
    },
  }, ACTION_TYPES.map((t) => el("option", { value: t, selected: action.type === t, text: TYPE_LABELS[t] })));

  const labelInput = el("input", {
    type: "text", value: action.label, placeholder: "行動名",
    onInput: (e) => { action.label = e.target.value; onChange(); },
  });

  let powerEl;
  if (action.type === "transform") {
    // 変身先フォーム選択
    powerEl = el("select", {
      onChange: (e) => { action.targetForm = parseInt(e.target.value, 10); onChange(); },
    }, monster.forms.map((f, idx) => el("option", {
      value: idx, selected: action.targetForm === idx,
      text: `→ ${idx === 0 ? "初期" : "F" + idx}: ${f.name || "(無名)"}`,
    })));
  } else if (action.type === "custom" || action.type === "none") {
    // 自由記述の効果説明（自動効果なし・手動判定）。none も任意で記述できる。
    powerEl = el("input", {
      type: "text", value: action.desc || "",
      placeholder: action.type === "custom" ? "効果を自由に記述（例: 相手を1回休み）" : "効果を自由に記述（任意）",
      onInput: (e) => { action.desc = e.target.value; onChange(); },
    });
  } else {
    powerEl = el("input", {
      type: "number", value: action.power, step: 1,
      min: cfg.mode === "balance" ? cfg.powerMin : -999,
      onInput: (e) => {
        action.power = parseInt(e.target.value, 10) || 0;
        updateNegativeStyle();
        refresh();
        onChange();
      },
    });
  }

  const costSpan = el("span", { className: "face-cost" });

  function refresh() {
    const c = calcActionCost(action, cfg);
    costSpan.textContent = (c === 0) ? "0pt" : (c > 0 ? `${c.toFixed(1)}pt` : `${c.toFixed(1)}pt`);
  }
  function updateNegativeStyle() {
    const neg = (action.type !== "transform" && action.type !== "none" && (action.power || 0) < 0);
    row.classList.toggle("negative", neg);
  }
  refresh();
  updateNegativeStyle();

  row.appendChild(el("div", { className: "dice-num", text: String(ai + 1) }));
  row.appendChild(typeSel);
  row.appendChild(labelInput);
  row.appendChild(powerEl);
  row.appendChild(costSpan);

  return { row, refresh };
}

function firstOtherForm(monster, _ai) {
  // 自フォーム以外の最初のindexを既定に（なければ0）
  return monster.forms.length > 1 ? 1 : 0;
}

// --- 予算バー（ビルド画面上部） ---

export function renderBudgetBar(getMonster, cfg) {
  const remaining = el("span", { className: "remaining" });
  const detail = el("span", { className: "muted" });
  const errorsBox = el("div", { className: "errors" });

  const bar = el("div", { className: "build-top" }, [
    cfg.mode === "balance" ? el("span", { className: "muted", text: "予算" }) : null,
    cfg.mode === "balance" ? remaining : el("span", { className: "muted", text: "フリービルド（制限なし）" }),
    detail,
    el("div", { className: "spacer" }),
    errorsBox,
  ]);

  bar.update = () => {
    const monster = getMonster();
    const v = validateMonster(monster, cfg);
    if (cfg.mode === "balance") {
      remaining.textContent = `残り ${v.remaining.toFixed(1)} / ${cfg.budget} pt`;
      remaining.className = "remaining " + (v.remaining < 0 ? "over" : "ok");
      detail.textContent = `（使用 ${v.totalCost.toFixed(1)}pt）`;
    }
    clear(errorsBox);
    for (const e of v.errors) errorsBox.appendChild(el("div", { text: "⚠ " + e }));
    return v;
  };
  bar.update();
  return bar;
}
