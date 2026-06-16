// 日銀APIのレスポンス構造を確認するための診断スクリプト（数秒で終了）。
// getMetadata と getDataCode の実際のJSON構造をログに出力する。
const https = require("https");
const zlib = require("zlib");

const HOST = "www.stat-search.boj.or.jp";
function get(pathWithQuery) {
  return new Promise((resolve, reject) => {
    https.get({ host: HOST, path: pathWithQuery, headers: { "Accept-Encoding": "gzip", "User-Agent": "jpx_data-boj-probe/1.0" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        if ((res.headers["content-encoding"] || "").includes("gzip")) { try { buf = zlib.gunzipSync(buf); } catch (e) {} }
        resolve({ status: res.statusCode, text: buf.toString("utf8") });
      });
    }).on("error", reject);
  });
}
function findSeriesArray(node) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && "SERIES_CODE" in x)) return node;
    for (const el of node) { const r = findSeriesArray(el); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") for (const k of Object.keys(node)) { const r = findSeriesArray(node[k]); if (r) return r; }
  return null;
}
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "…(略)" : s; }

(async () => {
  // 1) メタデータ（小さいDB: MD01 マネタリーベース）
  const meta = await get(`/api/v1/getMetadata?format=json&lang=jp&db=MD01`);
  console.log("=== getMetadata(MD01) status:", meta.status);
  let mj;
  try { mj = JSON.parse(meta.text); } catch (e) { console.log("META parse error:", e.message, "\nRAW:", trunc(meta.text, 1000)); return; }
  console.log("META top-level keys:", Object.keys(mj));
  const marr = findSeriesArray(mj) || [];
  console.log("META series array length:", marr.length);
  if (marr[0]) {
    console.log("META[0] keys:", Object.keys(marr[0]));
    console.log("META[0] sample:", trunc(JSON.stringify(marr[0]), 900));
  }
  // 期種ごとのコードを2つ拾う
  const codes = marr.map((m) => String(m.SERIES_CODE || "")).filter(Boolean).slice(0, 2);
  console.log("probe codes:", codes);
  if (!codes.length) return;

  // 2) データ（getDataCode）
  const data = await get(`/api/v1/getDataCode?format=json&lang=jp&db=MD01&code=${codes.join(",")}&startDate=202301`);
  console.log("\n=== getDataCode(MD01) status:", data.status);
  let dj;
  try { dj = JSON.parse(data.text); } catch (e) { console.log("DATA parse error:", e.message, "\nRAW:", trunc(data.text, 1500)); return; }
  console.log("DATA top-level keys:", Object.keys(dj));
  console.log("DATA NEXTPOSITION:", JSON.stringify(dj.NEXTPOSITION));
  const darr = findSeriesArray(dj);
  console.log("DATA findSeriesArray length:", darr ? darr.length : "(null)");
  if (darr && darr[0]) {
    console.log("DATA[0] keys:", Object.keys(darr[0]));
    console.log("DATA[0] sample:", trunc(JSON.stringify(darr[0]), 1500));
  } else {
    // 構造を浅く展開して見せる
    console.log("DATA shallow dump:", trunc(JSON.stringify(dj), 2000));
  }
})();
