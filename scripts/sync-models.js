#!/usr/bin/env node
// dsh-opencode-go-usage —— 模型数据同步脚本。
//
// 数据源：
//   1. GET https://opencode.ai/zen/go/v1/models   → 实时清单（顺序）
//   2. https://opencode.ai/docs/go               → 价格/月额度表（额度）
//
// 用法：
//   node scripts/sync-models.js        默认 --check：只 diff，有变动退出码 1
//   node scripts/sync-models.js --apply 写回 models.json 并同步 client.js 兜底表
//
// 说明：额度仅存在于官方文档 HTML 表格（无 API），解析失败（行数过少 / 格式漂移）
// 会中止，绝不半覆盖。models.json 只含模型 id/名称/额度，无任何敏感信息。

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_JSON = resolve(ROOT, "models.json");
const CLIENT = resolve(ROOT, "client.js");
const MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const DOCS_URL = "https://opencode.ai/docs/go/";
const MIN_ROWS = 15; // 解析到的文档额度行数下限，低于即视为解析失败

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

// ---------- 2) 文档价格表 → { 显示名: 月额度 } ----------
async function fetchDocsCaps() {
  const res = await fetch(DOCS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`docs HTTP ${res.status}`);
  let html = await res.text();
  html = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  html = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const start = html.indexOf("Model Input Output Cached Read");
  if (start === -1) throw new Error("docs price table header not found");
  const end = html.indexOf("Peak hours are", start);
  const seg = end > start ? html.slice(start, end) : html.slice(start);
  // 行: 模型名(可带括号限定) + 2~4 个价格/占位 + $月额度
  const caps = {};
  for (const m of seg.matchAll(/([A-Z][A-Za-z0-9 .\-]+?)(?:\s*\([^)]{0,40}\))?\s*(?:(?:-|\$[\d.]+)\s+){2,4}\s*\$(\d+)/g)) {
    const name = m[1].trim();
    if (!caps[name]) caps[name] = Number(m[2]);
  }
  if (Object.keys(caps).length < MIN_ROWS) throw new Error(`docs parse too few rows: ${Object.keys(caps).length}`);
  return caps;
}

// ---------- 名称 → id（优先已知映射，其次 slug 化） ----------
const slugify = (name) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function buildNameIdMap(cur) {
  const map = {};
  for (const e of cur) map[e.name] = e.id;
  return map;
}

// ---------- 3) 组装新表 ----------
function buildNewTable(liveIds, docsCaps, curByNameId) {
  const curById = new Map(curByNameId.map((e) => [e.id, e]));
  const nameToId = buildNameIdMap(cur);
  const docsIdBySlug = {};
  for (const name of Object.keys(docsCaps)) docsIdBySlug[slugify(name)] = name;

  const table = [];
  for (const id of liveIds) {
    // 名字：已知映射 → slug 回退 → 该项 id
    let used = null;
    for (const name of Object.keys(docsCaps)) {
      const cand = nameToId[name] || slugify(name);
      if (cand === id) { used = name; break; }
    }
    const cap = used != null ? docsCaps[used] : null;
    const prev = curById.get(id);
    if (cap != null) {
      table.push({ id, name: used, monthlyUsd: cap });
    } else if (prev && (prev.free)) {
      table.push(prev); // 免费模型保留下
    } else if (prev && prev.monthlyUsd != null) {
      table.push({ id, name: prev.name, monthlyUsd: prev.monthlyUsd }); // 文档暂无额度，沿用旧值（diff 会提示）
    }
    // 其它（无额度且无旧值）→ 自动排除
  }
  return table;
}

// ---------- main ----------
const cur = JSON.parse(await readFile(MODELS_JSON, "utf8"));
const liveIds = await fetchLiveIds();
const docsCaps = await fetchDocsCaps();
const next = buildNewTable(liveIds, docsCaps, cur);

const same = JSON.stringify(next) === JSON.stringify(cur);
if (!same) {
  console.log("模型数据有更新，diff：");
  const curById = new Map(cur.map((e) => [e.id, e]));
  for (const e of next) {
    const p = curById.get(e.id);
    const capTxt = e.free ? "免费" : `$${e.monthlyUsd}`;
    if (!p) console.log(`  + ${e.name} (${e.id}) ${capTxt}`);
    else if (p.monthlyUsd !== e.monthlyUsd || !!p.free !== !!e.free)
      console.log(`  ~ ${e.name} ${p.monthlyUsd != null ? "$" + p.monthlyUsd : (p.free ? "免费" : "—")} → ${capTxt}`);
  }
  for (const e of cur) {
    if (!next.find((x) => x.id === e.id))
      console.log(`  - ${e.name} (${e.id})（接口已不含）`);
  }
  console.log(`\n${next.length} 个模型 → ${same ? "无变动" : "有变动"}`);
} else {
  console.log(`无变动（${next.length} 个模型）`);
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
  console.log("已写回 models.json + client.js");
} else if (apply && same) {
  console.log("无变动，不写回");
}
process.exit(same ? 0 : 1);
