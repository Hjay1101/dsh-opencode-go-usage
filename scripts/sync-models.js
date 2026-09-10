#!/usr/bin/env node
// dsh-opencode-go-usage —— 模型数据同步脚本。
//
// 数据源：
//   1. GET https://opencode.ai/zen/go/v1/models   → 实时清单（顺序）
//   2. https://opencode.ai/docs/go                → 价格/月额度表 + 官方 Model ID 表
//
// 用法：
//   node scripts/sync-models.js         默认 --check：只 diff，有变动退出码 1
//   node scripts/sync-models.js --apply 写回 models.json 并同步 client.js 兜底表
//
// 匹配规则：官方文档的「Model ID」表是 名称→id 的唯一权威来源
// （例：DeepSeek V4.1 Flash → deepseek-flash、LongCat-2.0 → longcat-2.0）。
// 历史上用 slug 猜 id 会翻车：GLM 5.2 → "glm-5-2" ≠ "glm-5.2"，新模型会被静默丢掉。
// 本版先按「两个表格的归一化名称」join，再用归一化 id 兜底，并保留已有显示名。
//
// 边界：实时接口有、Go 文档未公开额度的模型一律不进 models.json（不展示），
// 但会列在报告里；以前有额度、现在文档已移除的会沿用旧值并单独提示人工确认。
// 解析失败（表头找不到 / 行数过少 / 命中率过低）一律中止，绝不半覆盖。
// models.json 只含模型 id/名称/额度，无任何敏感信息。

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_JSON = resolve(ROOT, "models.json");
const CLIENT = resolve(ROOT, "client.js");
const MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const DOCS_URL = "https://opencode.ai/docs/go/";
const MIN_ROWS = 15; // 文档额度行数下限，低于即视为解析失败

const apply = process.argv.includes("--apply");

// ---------- 1) 实时清单 ----------
async function fetchLiveIds() {
  const res = await fetch(MODELS_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`models API HTTP ${res.status}`);
  const body = await res.json();
  const ids = Array.isArray(body.data)
    ? body.data.map((m) => (m && typeof m.id === "string" ? m.id : null)).filter(Boolean)
    : [];
  if (!ids.length) throw new Error("models API returned empty list");
  return ids;
}

// ---------- 2) 文档 HTML → 两个关键表格 ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
const cellText = (html) => decode(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
/** 去掉规格限定，如 "(Off-Peak)"、"(≤ 256K tokens)"。 */
const stripParen = (s) => s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
/** 归一化：忽略大小写、空格、点、连字符（"MiMo-V2.5" == "MiMo V2.5"）。 */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function extractTables(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  return tables.map((t) =>
    (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((r) =>
      (r.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(cellText)
    )
  );
}

async function fetchDocsTables() {
  const res = await fetch(DOCS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`docs HTTP ${res.status}`);
  const tables = extractTables(await res.text());
  const head = (t) => (t[0] || []).join("|").toLowerCase();
  const price = tables.find((t) => head(t).includes("model") && head(t).includes("monthly"));
  const idTable = tables.find((t) => head(t).includes("model id"));
  if (!price) throw new Error("docs price table not found");
  if (!idTable) throw new Error("docs model-id table not found");

  // 价格表：第一列是显示名，最后一列是月额度。
  const capsByName = new Map(); // norm(name) -> { name, monthlyUsd }
  for (const row of price.slice(1)) {
    if (row.length < 3) continue;
    const m = /^\$(\d+(?:\.\d+)?)$/.exec(row[row.length - 1]);
    if (!m) continue;
    const name = stripParen(row[0]);
    const key = norm(name);
    if (key && !capsByName.has(key)) capsByName.set(key, { name, monthlyUsd: Number(m[1]) });
  }
  // 官方 Model ID 表：显示名 → id
  const idByNormName = new Map();
  for (const row of idTable.slice(1)) {
    if (row.length < 2) continue;
    const id = row[1];
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(id)) continue;
    idByNormName.set(norm(stripParen(row[0])), id);
  }
  if (capsByName.size < MIN_ROWS) throw new Error(`docs parse too few rows: ${capsByName.size}`);
  if (idByNormName.size < MIN_ROWS) throw new Error(`docs id table too few rows: ${idByNormName.size}`);

  // join：两份表在同一页，按归一化名对齐后拿到 该模型的 id+额度
  const docById = new Map(); // id -> { name, monthlyUsd }
  for (const [key, cap] of capsByName) {
    const id = idByNormName.get(key);
    if (id) docById.set(id, { name: cap.name, monthlyUsd: cap.monthlyUsd });
  }
  if (docById.size < MIN_ROWS) throw new Error(`docs join too few models: ${docById.size}`);
  return docById;
}

// ---------- 3) 组装新表 ----------
function buildNewTable(liveIds, docById, cur) {
  const curById = new Map(cur.map((e) => [e.id, e]));
  // 兜底：文档 ID 表缺行时，用归一化 id 对齐（"glm-5.3" ↔ "GLM-5.3"）
  const docByNormId = new Map();
  for (const [id, doc] of docById) docByNormId.set(norm(id), doc);

  const table = [], stale = [], unknown = [];
  for (const id of liveIds) {
    const doc = docById.get(id) || docByNormId.get(norm(id));
    const prev = curById.get(id);
    const name = prev ? prev.name : doc ? doc.name : id;
    if (doc) {
      table.push({ id, name, monthlyUsd: doc.monthlyUsd });
    } else if (prev && (prev.free || prev.monthlyUsd != null)) {
      const e = { id, name: prev.name, monthlyUsd: prev.monthlyUsd ?? null };
      if (prev.free) e.free = true;
      table.push(e);
      stale.push(prev); // 文档已移除额度，沿用旧值（diff 会提示）
    } else {
      unknown.push(id); // Go 套餐未公开额度 → 排除
    }
  }
  return { table, stale, unknown };
}

// ---------- main ----------
const cur = JSON.parse(await readFile(MODELS_JSON, "utf8"));
const liveIds = await fetchLiveIds();
const docById = await fetchDocsTables();
const { table: next, stale, unknown } = buildNewTable(liveIds, docById, cur);

const same = JSON.stringify(next) === JSON.stringify(cur);
if (!same) {
  console.log("模型数据有更新，diff：");
  const curById = new Map(cur.map((e) => [e.id, e]));
  for (const e of next) {
    const p = curById.get(e.id);
    const capTxt = e.free ? "免费" : `$${e.monthlyUsd}`;
    if (!p) console.log(`  + ${e.name} (${e.id}) ${capTxt}`);
    else if (p.monthlyUsd !== e.monthlyUsd || !!p.free !== !!e.free || p.name !== e.name)
      console.log(`  ~ ${e.name} (${e.id}) ${p.monthlyUsd != null ? "$" + p.monthlyUsd : (p.free ? "免费" : "—")} → ${capTxt}`);
  }
  for (const e of cur) {
    if (!next.find((x) => x.id === e.id))
      console.log(`  - ${e.name} (${e.id})（接口已不含）`);
  }
  console.log(`\n${next.length} 个模型 → 有变动`);
} else {
  console.log(`无变动（${next.length} 个模型）`);
}

// 报告：实时接口有、但文档没给额度的模型（不进表，需人工确认/补额度）
if (unknown.length) {
  console.log(`\n⚠ 接口有、Go 文档未公开额度（已排除，共 ${unknown.length} 个）：`);
  console.log(`  ${unknown.join(", ")}`);
}
if (stale.length) {
  console.log(`\n⚠ 文档已移除额度、沿用旧值（请人工确认，共 ${stale.length} 个）：`);
  for (const e of stale) console.log(`  ${e.name} (${e.id}) 沿用 $${e.monthlyUsd}`);
}
if (liveIds.length && unknown.length / liveIds.length > 0.5) {
  console.error("\n错误：实时清单过半模型在文档里找不到额度，疑似文档结构变更，已中止。");
  process.exit(2);
}

if (apply && !same) {
  await writeFile(MODELS_JSON, JSON.stringify(next, null, 2) + "\n", "utf8");
  // 同步 client.js 兜底表
  let src = await readFile(CLIENT, "utf8");
  const start = src.indexOf("const MODEL_LIST = [");
  const end = src.indexOf("];\n", start) + 3;
  const lines = ["const MODEL_LIST = ["].concat(
    next.map((e) => {
      const f = e.free ? ", free: true" : "";
      return `      { id: "${e.id}", name: "${e.name}", monthlyUsd: ${e.monthlyUsd}${f} },`;
    })
  ).concat(["    ];", ""]);
  src = src.slice(0, start) + lines.join("\n") + src.slice(end);
  await writeFile(CLIENT, src, "utf8");
  console.log("\n已写回 models.json + client.js");
} else if (apply && same) {
  console.log("\n无变动，不写回");
}
process.exit(same ? 0 : 1);
