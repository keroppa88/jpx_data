// 日本銀行「時系列統計データ検索サイト」API から政府統計（マクロ統計）を取得する。
// メタデータAPI(getMetadata)で系列コード一覧を取得し、目的の期種に絞り、
// コードAPI(getDataCode)で250件ずつデータを取得して data/boj/ 配下にCSV出力する。
// （階層API layer=* は「期種で絞る前の全系列数」で1250制限に掛かるため使わない）
//
// このサービスは、日本銀行時系列統計データ検索サイトのAPI機能を使用しています。
// サービスの内容は日本銀行によって保証されたものではありません。
//
// ・APIキー不要。高頻度アクセス禁止のためリクエスト間に間隔を空ける。
// ・出力: data/boj/<DB>_<期種>.csv（ワイド形式: Date,<系列コード>,...）
//         data/boj/_catalog.csv（系列コード・名称・単位・期種・既定集約の一覧）

const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "data", "boj");
const HOST = "www.stat-search.boj.or.jp";
const META_BASE = "/api/v1/getMetadata";
const CODE_BASE = "/api/v1/getDataCode";

// 取得開始期（YYYYMM）。日次・週次・月次は YYYYMM 形式で指定する。
const START_DATE = process.env.BOJ_START || "200001";

// 1リクエストの系列コード数上限は250。安全側で200ずつ。
const CODE_BATCH = 200;
const SLEEP_MS = 1500; // 高頻度アクセス回避
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 取得対象。db=DB名, frequency=期種(D/W/M/Q/CY/FY), suffix=ファイル名サフィックス,
// agg=既定の集約方法（last=期末値 / sum=合計）。系列ごとの上書きは bojlist.csv で行う。
const TARGETS = [
  { db: "FM08", frequency: "D", suffix: "D", agg: "last", label: "外国為替市況(日次)" },
  { db: "CO",   frequency: "Q", suffix: "Q", agg: "last", label: "日銀短観(四半期)", optional: true },
  { db: "FM01", frequency: "D", suffix: "D", agg: "last", label: "無担保コールO/N物レート(日次)" },
  { db: "PR01", frequency: "M", suffix: "M", agg: "last", label: "企業物価指数(月次)" },
  { db: "MD02", frequency: "M", suffix: "M", agg: "last", label: "マネーストック(月次)" },
  { db: "FM09", frequency: "M", suffix: "M", agg: "last", label: "実効為替レート(月次)" },
  { db: "MD01", frequency: "M", suffix: "M", agg: "last", label: "マネタリーベース(月次)" },
];

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
            if ((res.headers["content-encoding"] || "").includes("gzip")) buf = zlib.gunzipSync(buf);
          } catch (e) { return reject(new Error("gunzip失敗: " + e.message)); }
          const text = buf.toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          }
          resolve(text);
        });
      }
    ).on("error", reject);
  });
}

// レスポンスJSONから系列配列を再帰的に探す（SERIES_CODE を持つオブジェクトの配列）。
function findSeriesArray(node) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && "SERIES_CODE" in x)) return node;
    for (const el of node) { const r = findSeriesArray(el); if (r) return r; }
    return null;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) { const r = findSeriesArray(node[k]); if (r) return r; }
  }
  return null;
}

function getNextPosition(json) {
  if (json && json.NEXTPOSITION != null) {
    const s = String(json.NEXTPOSITION).trim();
    if (s !== "" && s !== "null") { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; }
  }
  return null;
}

function checkStatus(json, ctx) {
  const status = json && json.STATUS != null ? String(json.STATUS) : "";
  if (status && status !== "200") {
    throw new Error(`${ctx} STATUS ${status}: ${(json.MESSAGE || "").trim()}`);
  }
}

// target.frequency と、メタ情報の FREQUENCY 文字列の対応判定。
function freqMatches(freqStr, targetFreq) {
  const f = String(freqStr || "").toUpperCase();
  switch (targetFreq) {
    case "D": return f === "DAILY";
    case "W": return f.startsWith("WEEKLY");
    case "M": return f === "MONTHLY";
    case "Q": return f === "QUARTERLY";
    case "CY": return f === "ANNUAL";
    case "FY": return f === "ANNUAL(MAR)";
    case "CH": return f === "SEMIANNUAL";
    case "FH": return f === "SEMIANNUAL(SEP)";
    default: return true;
  }
}

// SURVEY_DATES の各期を共通形式（YYYY-MM-DD / YYYY-MM）に正規化する。
function normalizeDate(raw, freq) {
  const s = String(raw || "").trim();
  const f = String(freq || "").toUpperCase();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (f.startsWith("QUARTERLY") && /^\d{6}$/.test(s)) {
    const q = parseInt(s.slice(4, 6), 10);
    return `${s.slice(0, 4)}-${["03", "06", "09", "12"][Math.max(1, Math.min(4, q)) - 1]}`;
  }
  if (f.startsWith("SEMIANNUAL") && /^\d{6}$/.test(s)) {
    return `${s.slice(0, 4)}-${parseInt(s.slice(4, 6), 10) === 2 ? "12" : "06"}`;
  }
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`; // 月次
  if (/^\d{4}$/.test(s)) return `${s}-12`;                          // 暦年・年度
  return s;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// メタデータAPIで DB の系列一覧を取得（{SERIES_CODE, FREQUENCY, NAME_OF_TIME_SERIES_J, UNIT_J}）。
async function fetchMetadata(db) {
  const params = new URLSearchParams({ format: "json", lang: "jp", db });
  const json = JSON.parse(await httpsGetGzip(`${META_BASE}?${params.toString()}`));
  checkStatus(json, `getMetadata(${db})`);
  return findSeriesArray(json) || [];
}

// コードAPIで指定コード群のデータを取得（250件以下／同一期種）。NEXTPOSITIONでページング。
async function fetchDataChunk(db, codes) {
  const merged = new Map(); // code -> series object
  let startPosition = null, guard = 0;
  while (guard++ < 500) {
    const params = new URLSearchParams({ format: "json", lang: "jp", db, code: codes.join(","), startDate: START_DATE });
    if (startPosition != null) params.set("startPosition", String(startPosition));
    const json = JSON.parse(await httpsGetGzip(`${CODE_BASE}?${params.toString()}`));
    checkStatus(json, `getDataCode(${db})`);
    for (const s of findSeriesArray(json) || []) {
      const code = String(s.SERIES_CODE || "").trim();
      if (code) merged.set(code, s);
    }
    const next = getNextPosition(json);
    if (next == null) break;
    startPosition = next;
    await sleep(SLEEP_MS);
  }
  return merged;
}

// 系列オブジェクトから時期配列・値配列を取り出す。
// getDataCode では VALUES が { SURVEY_DATES:[...], VALUES:[...] } の入れ子になっている。
function extractSeriesDV(s) {
  const w = s && s.VALUES && typeof s.VALUES === "object" && !Array.isArray(s.VALUES) ? s.VALUES : null;
  const dates = w ? (w.SURVEY_DATES || []) : (s.SURVEY_DATES || []);
  const values = w ? (w.VALUES || []) : (Array.isArray(s.VALUES) ? s.VALUES : []);
  return { dates: Array.isArray(dates) ? dates : [], values: Array.isArray(values) ? values : [] };
}

function writeDbCsv(target, seriesList) {
  const codes = [];
  const valueMaps = new Map();
  const allDates = new Set();
  const catalogRows = [];

  for (const s of seriesList) {
    const code = String(s.SERIES_CODE || "").trim();
    if (!code) continue;
    const { dates, values } = extractSeriesDV(s);

    const m = new Map();
    for (let i = 0; i < dates.length; i++) {
      const raw = values[i];
      if (raw == null || raw === "null" || raw === "") continue;
      const v = Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(v)) continue;
      const d = normalizeDate(dates[i], s.FREQUENCY || target.frequency);
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
  const lines = [["Date", ...codes].join(",")];
  for (const d of sortedDates) {
    const row = [d];
    for (const code of codes) { const m = valueMaps.get(code); row.push(m.has(d) ? m.get(d) : ""); }
    lines.push(row.map(csvEscape).join(","));
  }
  fs.writeFileSync(path.join(OUT_DIR, `${target.db}_${target.suffix}.csv`), lines.join("\n") + "\n", "utf8");
  return { rows: sortedDates.length, codes: codes.length, catalog: catalogRows };
}

async function fetchTarget(target) {
  // 1) メタ情報で系列コードを取得し、目的の期種だけに絞る
  const meta = await fetchMetadata(target.db);
  await sleep(SLEEP_MS);
  const metaByCode = new Map();
  const codes = [];
  for (const m of meta) {
    const code = String(m.SERIES_CODE || "").trim();
    if (!code) continue;
    if (!freqMatches(m.FREQUENCY, target.frequency)) continue;
    metaByCode.set(code, m);
    codes.push(code);
  }
  if (codes.length === 0) return { rows: 0, codes: 0, catalog: [] };

  // 2) コードAPIで250件以下ずつデータ取得
  const seriesList = [];
  for (let i = 0; i < codes.length; i += CODE_BATCH) {
    const chunk = codes.slice(i, i + CODE_BATCH);
    const got = await fetchDataChunk(target.db, chunk);
    for (const code of chunk) {
      const s = got.get(code);
      const meta1 = metaByCode.get(code) || {};
      if (!s) continue;
      const { dates, values } = extractSeriesDV(s);
      // 名称・単位・期種はメタ情報を優先（データ応答に欠けても補う）
      seriesList.push({
        SERIES_CODE: code,
        NAME_OF_TIME_SERIES_J: s.NAME_OF_TIME_SERIES_J || meta1.NAME_OF_TIME_SERIES_J || "",
        UNIT_J: s.UNIT_J || meta1.UNIT_J || "",
        FREQUENCY: s.FREQUENCY || meta1.FREQUENCY || target.frequency,
        SURVEY_DATES: dates,
        VALUES: values,
      });
    }
    await sleep(SLEEP_MS);
  }
  return writeDbCsv(target, seriesList);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`日銀API 政府統計の取得を開始します（startDate=${START_DATE}）`);

  const catalog = [];
  for (const target of TARGETS) {
    try {
      const res = await fetchTarget(target);
      catalog.push(...res.catalog);
      console.log(`✅ ${target.db}_${target.suffix} (${target.label}): 系列${res.codes} / 期間${res.rows}`);
    } catch (e) {
      const msg = `${target.db}_${target.suffix} (${target.label}): ${e.message}`;
      if (target.optional) console.warn(`⏭️  スキップ ${msg}`);
      else console.error(`❌ エラー ${msg}`);
    }
    await sleep(SLEEP_MS);
  }

  const catHeader = ["file", "code", "name", "unit", "freq", "agg"];
  const catLines = [catHeader.join(",")];
  for (const c of catalog) catLines.push(catHeader.map((k) => csvEscape(c[k])).join(","));
  fs.writeFileSync(path.join(OUT_DIR, "_catalog.csv"), catLines.join("\n") + "\n", "utf8");
  console.log(`catalog: data/boj/_catalog.csv（系列 ${catalog.length}）`);
  console.log("すべての処理が完了しました。");
}

main();
