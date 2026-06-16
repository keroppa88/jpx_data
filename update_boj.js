// 日本銀行「時系列統計データ検索サイト」API から政府統計（マクロ統計）を取得する。
// 階層API(getDataLayer) で DB を丸ごと取得し、data/boj/ 配下に DB×期種ごとのCSVを出力する。
//
// このサービスは、日本銀行時系列統計データ検索サイトのAPI機能を使用しています。
// サービスの内容は日本銀行によって保証されたものではありません。
//
// ・APIキー不要（どなたでも利用可）。
// ・高頻度アクセス禁止のため、リクエスト間に必ず間隔を空ける。
// ・出力: data/boj/<DB>_<期種>.csv（ワイド形式: Date,<系列コード>,...）
//         data/boj/_catalog.csv（系列コード・名称・単位・期種・既定集約の一覧）

const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "data", "boj");
const API_BASE = "/api/v1/getDataLayer";
const HOST = "www.stat-search.boj.or.jp";

// 取得開始期（YYYYMM）。日次・週次・月次は YYYYMM 形式で指定する。
const START_DATE = process.env.BOJ_START || "200001";

// 取得対象。db=DB名, frequency=期種(D/W/M/Q/CY/FY...), suffix=ファイル名サフィックス,
// agg=既定の集約方法（last=期末値 / sum=合計）。系列ごとの上書きは bojlist.csv で行う。
const TARGETS = [
  { db: "FM08", frequency: "D", suffix: "D", agg: "last", label: "外国為替市況(日次)" },
  { db: "FM09", frequency: "M", suffix: "M", agg: "last", label: "実効為替レート(月次)" },
  { db: "FM01", frequency: "D", suffix: "D", agg: "last", label: "無担保コールO/N物レート(日次)" },
  { db: "IR01", frequency: "M", suffix: "M", agg: "last", label: "基準割引率・基準貸付利率(月次)" },
  { db: "IR04", frequency: "M", suffix: "M", agg: "last", label: "貸出約定平均金利(月次)" },
  { db: "MD01", frequency: "M", suffix: "M", agg: "last", label: "マネタリーベース(月次)" },
  { db: "MD02", frequency: "M", suffix: "M", agg: "last", label: "マネーストック(月次)" },
  { db: "CO",   frequency: "Q", suffix: "Q", agg: "last", label: "日銀短観(四半期)" },
  { db: "PR01", frequency: "M", suffix: "M", agg: "last", label: "企業物価指数(月次)" },
  { db: "PR02", frequency: "M", suffix: "M", agg: "last", label: "企業向けサービス価格指数(月次)" },
  // 資金循環(FF)は系列数が非常に多く、layer=* では系列上限(1250)を超えてエラーになる場合がある。
  // 必要に応じて階層を絞って取得すること。既定では四半期・全層を試行（失敗時はスキップ）。
  { db: "FF",   frequency: "Q", suffix: "Q", agg: "sum",  label: "資金循環(四半期)", optional: true },
];

const SLEEP_MS = 1500; // 高頻度アクセス回避
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsGetGzip(pathWithQuery) {
  return new Promise((resolve, reject) => {
    https.get(
      {
        host: HOST,
        path: pathWithQuery,
        headers: { "Accept-Encoding": "gzip", "User-Agent": "jpx_data-boj/1.0" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          try {
            if ((res.headers["content-encoding"] || "").includes("gzip")) {
              buf = zlib.gunzipSync(buf);
            }
          } catch (e) { return reject(new Error("gunzip失敗: " + e.message)); }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${buf.toString("utf8").slice(0, 300)}`));
          }
          resolve(buf.toString("utf8"));
        });
      }
    ).on("error", reject);
  });
}

// レスポンスJSONから系列配列を再帰的に探す（SERIES_CODE と VALUES/SURVEY_DATES を持つ配列）。
function findSeriesArray(node) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && "SERIES_CODE" in x)) {
      return node;
    }
    for (const el of node) {
      const r = findSeriesArray(el);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      const r = findSeriesArray(node[k]);
      if (r) return r;
    }
  }
  return null;
}

function getNextPosition(json) {
  if (json && json.NEXTPOSITION != null && String(json.NEXTPOSITION).trim() !== "" && String(json.NEXTPOSITION) !== "null") {
    const n = parseInt(json.NEXTPOSITION, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// SURVEY_DATES の各期を共通形式（YYYY-MM-DD / YYYY-MM）に正規化する。
function normalizeDate(raw, freq) {
  const s = String(raw || "").trim();
  const f = String(freq || "").toUpperCase();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (f.startsWith("QUARTERLY") && /^\d{6}$/.test(s)) {
    const q = parseInt(s.slice(4, 6), 10);
    const mm = ["03", "06", "09", "12"][Math.max(1, Math.min(4, q)) - 1];
    return `${s.slice(0, 4)}-${mm}`;
  }
  if (f.startsWith("SEMIANNUAL") && /^\d{6}$/.test(s)) {
    const h = parseInt(s.slice(4, 6), 10);
    return `${s.slice(0, 4)}-${h === 2 ? "12" : "06"}`;
  }
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`; // 月次
  if (/^\d{4}$/.test(s)) return `${s}-12`; // 暦年・年度
  return s;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function fetchDb(target) {
  const series = [];
  let startPosition = null;
  let guard = 0;
  while (guard++ < 200) {
    const params = new URLSearchParams();
    params.set("format", "json");
    params.set("lang", "jp");
    params.set("db", target.db);
    params.set("frequency", target.frequency);
    params.set("layer", "*");
    params.set("startDate", START_DATE);
    if (startPosition != null) params.set("startPosition", String(startPosition));

    const txt = await httpsGetGzip(`${API_BASE}?${params.toString()}`);
    let json;
    try { json = JSON.parse(txt); } catch (e) { throw new Error("JSON parse失敗: " + e.message); }

    const status = json && json.STATUS != null ? String(json.STATUS) : "";
    if (status && status !== "200") {
      throw new Error(`STATUS ${status}: ${json.MESSAGE || ""}`);
    }
    const arr = findSeriesArray(json) || [];
    series.push(...arr);

    const next = getNextPosition(json);
    if (next == null) break;
    startPosition = next;
    await sleep(SLEEP_MS);
  }
  return series;
}

function writeDbCsv(target, series) {
  // series[i]: { SERIES_CODE, NAME_OF_TIME_SERIES_J, UNIT_J, FREQUENCY, SURVEY_DATES[], VALUES[] }
  const codes = [];
  const valueMaps = new Map(); // code -> Map(date -> value)
  const allDates = new Set();
  const catalogRows = [];

  for (const s of series) {
    const code = String(s.SERIES_CODE || "").trim();
    if (!code) continue;
    const dates = s.SURVEY_DATES || s.SURVEY_DATE || [];
    const values = s.VALUES || s.VALUE || [];
    if (!Array.isArray(dates) || !Array.isArray(values)) continue;

    const m = new Map();
    for (let i = 0; i < dates.length; i++) {
      const d = normalizeDate(dates[i], s.FREQUENCY || target.frequency);
      const raw = values[i];
      if (raw == null || raw === "null" || raw === "") continue;
      const v = Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(v)) continue;
      m.set(d, v);
      allDates.add(d);
    }
    if (m.size === 0) continue;
    codes.push(code);
    valueMaps.set(code, m);
    catalogRows.push({
      file: `${target.db}_${target.suffix}`,
      code,
      name: String(s.NAME_OF_TIME_SERIES_J || "").trim(),
      unit: String(s.UNIT_J || "").trim(),
      freq: String(s.FREQUENCY || target.frequency).trim(),
      agg: target.agg,
    });
  }

  if (codes.length === 0) return { rows: 0, codes: 0, catalog: [] };

  const sortedDates = Array.from(allDates).sort();
  const header = ["Date", ...codes];
  const lines = [header.join(",")];
  for (const d of sortedDates) {
    const row = [d];
    for (const code of codes) {
      const m = valueMaps.get(code);
      row.push(m.has(d) ? m.get(d) : "");
    }
    lines.push(row.map(csvEscape).join(","));
  }

  const file = path.join(OUT_DIR, `${target.db}_${target.suffix}.csv`);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { rows: sortedDates.length, codes: codes.length, catalog: catalogRows };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`日銀API 政府統計の取得を開始します（startDate=${START_DATE}）`);

  const catalog = [];
  for (const target of TARGETS) {
    try {
      const series = await fetchDb(target);
      const res = writeDbCsv(target, series);
      catalog.push(...res.catalog);
      console.log(`✅ ${target.db}_${target.suffix} (${target.label}): 系列${res.codes} / 期間${res.rows}`);
    } catch (e) {
      const msg = `${target.db}_${target.suffix} (${target.label}): ${e.message}`;
      if (target.optional) console.warn(`⏭️  スキップ ${msg}`);
      else console.error(`❌ エラー ${msg}`);
    }
    await sleep(SLEEP_MS);
  }

  // カタログ出力（index.html とリスト整備用）
  const catHeader = ["file", "code", "name", "unit", "freq", "agg"];
  const catLines = [catHeader.join(",")];
  for (const c of catalog) {
    catLines.push(catHeader.map((k) => csvEscape(c[k])).join(","));
  }
  fs.writeFileSync(path.join(OUT_DIR, "_catalog.csv"), catLines.join("\n") + "\n", "utf8");
  console.log(`catalog: data/boj/_catalog.csv（系列 ${catalog.length}）`);
  console.log("すべての処理が完了しました。");
}

main();
