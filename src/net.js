// net.js — WebSocket クライアントの薄いラッパ。コールドスタート対応の接続と送受信。
// 結合サーバー想定: 同一オリジンの /ws に接続。別配信時は ?ws=URL か window.WS_URL で上書き可。

/** 接続先 WS URL を決定 */
export function wsUrl() {
  const override = new URLSearchParams(location.search).get("ws") || window.WS_URL;
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

/**
 * サーバーへ接続する。Render のコールドスタート（最大30〜50秒）を見込んでリトライする。
 * @param {object} handlers { onMessage(msg), onClose(), onError() }
 * @param {object} [opts] { timeout, onAttempt(n) }
 * @returns {Promise<Connection>}
 */
export function connect(handlers = {}, opts = {}) {
  const url = wsUrl();
  const timeout = opts.timeout ?? 75000; // 全体のあきらめ時間
  const start = Date.now();
  let attempt = 0;
  let closedByUs = false;

  return new Promise((resolve, reject) => {
    function tryOnce() {
      attempt++;
      if (opts.onAttempt) opts.onAttempt(attempt);
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return retryOrFail(e); }

      // 1接続あたりの待ち時間
      const perTry = setTimeout(() => { try { ws.close(); } catch {} retryOrFail(new Error("timeout")); }, 8000);

      ws.onopen = () => {
        clearTimeout(perTry);
        const conn = makeConn(ws, handlers, () => { closedByUs = true; });
        ws.onmessage = (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          handlers.onMessage && handlers.onMessage(m);
        };
        ws.onclose = () => { if (!closedByUs) handlers.onClose && handlers.onClose(); };
        ws.onerror = () => { handlers.onError && handlers.onError(); };
        resolve(conn);
      };
      ws.onerror = () => { /* onclose/timeout 側で処理 */ };
      ws.onclose = () => {
        clearTimeout(perTry);
        if (ws.__opened) return;
        retryOrFail(new Error("closed before open"));
      };
    }

    function retryOrFail(err) {
      if (Date.now() - start >= timeout) { reject(err); return; }
      setTimeout(tryOnce, 1500); // 起床待ちの間隔
    }

    tryOnce();
  });
}

function makeConn(ws, handlers, markClosed) {
  return {
    ws,
    send(obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); },
    close() { markClosed(); try { ws.close(); } catch {} },
    get open() { return ws.readyState === WebSocket.OPEN; },
  };
}
