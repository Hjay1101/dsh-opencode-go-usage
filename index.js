// dsh-opencode-go-usage —— Host 半。
//
// 职责：把「OpenCode Go 用量查询」发布为一个 Typert Remote 服务
// （服务键 opencodeUsage），浏览器的设置页经 harness 的 /api RPC
// 调用 usage()。API Key 只在 Host 进程内使用，绝不下发到浏览器。
//
// 说明：Typert 调用按 typert.host.js 中的手写清单做严格模式分发，
// 因此这里不需要 @Remote 装饰器，直接继承 TypertRemoteService 即可。

import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

/** 官方用量接口（未写入 OpenCode 公开文档，见 README 已知限制）。 */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";
/** 官方模型清单接口（OpenAI 兼容 /models）。 */
const DEFAULT_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
/** 额度数据源（仓库根 models.json，仅数据、无敏感内容）。 */
const MODELS_JSON_URL =
  "https://raw.githubusercontent.com/Hjay1101/dsh-opencode-go-usage/main/models.json";
/** 数据缓存 TTL：清单/额度变化不频繁，1 小时刷新一次足够。 */
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
/** 严格校验：额度表必须长这样才采用，否则整体回退（防篡改/防解析错）。 */
function validateCapsTable(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 80) return null;
  const out = {};
  for (const item of v) {
    if (!item || typeof item !== "object") return null;
    const id = item.id, name = item.name;
    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof name !== "string" || name.length === 0) return null;
    if (item.free) {
      out[id] = { id, name, monthlyUsd: null, free: true };
    } else {
      const cap = item.monthlyUsd;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) return null;
      out[id] = { id, name, monthlyUsd: cap, free: false };
    }
  }
  return out;
}
function tableArray(capsMap) {
  return Object.keys(capsMap).map((k) => capsMap[k]);
}
/** 单次请求超时。 */
const DEFAULT_TIMEOUT_MS = 15000;
/** 结果缓存 TTL：接口未公开文档，避免每次打开页面都去打一次。 */
const DEFAULT_CACHE_TTL_MS = 60_000;

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  cacheTtlMs: z.number().default(DEFAULT_CACHE_TTL_MS),
});

/**
 * 解析 OpenCode Go API Key，按可信度从高到低：
 *   1. DSH 凭据 seam / 环境变量：OPENCODE_GO_API_KEY
 *      （覆盖 ~/.dsh/.credentials.yaml 与进程环境变量）
 *   2. OpenCode 自带的凭据文件 auth.json：
 *      优先取 opencode-go 条目，回退 opencode 条目，要求 type === "api"
 * 找不到返回 undefined，由调用方给出友好提示。
 */
async function resolveApiKey(ctx) {
  try {
    const cred = await ctx.credentials.resolve(credentialRef("OPENCODE_GO_API_KEY"));
    if (cred && typeof cred.value === "string" && cred.value.length > 0) {
      return cred.value;
    }
  } catch {
    /* 凭据 seam 不可用则继续走回退 */
  }

  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    const raw = JSON.parse(await readFile(authPath, "utf8"));
    const entry = raw["opencode-go"] ?? raw["opencode"];
    if (entry && entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0) {
      return entry.key;
    }
  } catch {
    /* 文件不存在/解析失败则视为无 Key */
  }

  return undefined;
}

/** 检查「设置 → 模型」里是否已配置 opencode-go（llm-pi-ai 提供方命名空间）。 */
function isOpenCodeGoConfigured(ctx) {
  try {
    const pi = ctx.settings.get(settingsNamespace("llm-pi-ai"));
    return !!(pi && pi.providers && pi.providers["opencode-go"]);
  } catch {
    return false;
  }
}

/** 防御式提取单个用量窗口：字段缺失/类型不符时置 null，绝不抛错。 */
function pickWindow(w) {
  if (!w || typeof w !== "object") return null;
  const percent = typeof w.percent === "number" ? w.percent : Number(w.percent);
  return {
    status: typeof w.status === "string" ? w.status : null,
    percent: Number.isFinite(percent) ? percent : null,
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
}

export class OpencodeGoUsageGateway extends TypertRemoteService {
  static inject = ["credentials", "settings"];
  static Config = Config;

  constructor(ctx, config) {
    super(ctx, "opencodeUsage");
    this.config = config ?? {};
    // 简单 TTL 缓存：同一个 baseUrl 在缓存期内直接复用结果。
    this._cache = { key: null, at: 0, value: null };
    this._modelsCache = { at: 0, value: null }; // 实时 /models 清单（ids）
    this._capsCache = { at: 0, value: null };   // 额度表（id → {id,name,monthlyUsd,free}）
  }

  /**
   * 查询用量。默认命中 60s 缓存；force=true 时绕过缓存直连接口
   * （弹窗"打开即刷新"用），拿到的最新结果仍会写回缓存。
   * @param {boolean} [force] 是否强制刷新（跳过缓存）。
   */
  async usage(force = false) {
    const baseUrl = this.config.baseUrl || DEFAULT_BASE_URL;
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const cacheTtlMs = this.config.cacheTtlMs || DEFAULT_CACHE_TTL_MS;

    // 前置条件 1：模型列表里得有 opencode-go，否则直接引导。
    if (!isOpenCodeGoConfigured(this.ctx)) {
      return { configured: false, reason: "not-in-models", error: null, usage: null };
    }

    // 前置条件 2：得有 API Key。
    const apiKey = await resolveApiKey(this.ctx);
    if (!apiKey) {
      return { configured: false, reason: "no-api-key", error: null, usage: null };
    }

    // 命中缓存则直接返回（force 时跳过缓存，直接打接口）。
    const now = Date.now();
    if (!force && this._cache.key === baseUrl && now - this._cache.at < cacheTtlMs) {
      return this._cache.value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(baseUrl, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      return { configured: true, reason: null, error: "network", usage: null };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      return { configured: true, reason: null, error: "unauthorized", usage: null };
    }
    if (!res.ok) {
      return { configured: true, reason: null, error: `http-${res.status}`, usage: null };
    }

    let body;
    try {
      body = await res.json();
    } catch {
      return { configured: true, reason: null, error: "bad-json", usage: null };
    }

    // 接口可能把窗口直接放在顶层，也可能放在 usage 字段下，两种都兼容。
    const usage = body && typeof body === "object" && body.usage ? body.usage : body;
    const result = {
      configured: true,
      reason: null,
      error: null,
      usage: {
        rolling: pickWindow(usage && usage.rolling),
        weekly: pickWindow(usage && usage.weekly),
        monthly: pickWindow(usage && usage.monthly),
      },
    };

    this._cache = { key: baseUrl, at: now, value: result };
    return result;
  }

  /** 运行时拉取 /models 实时清单（1h 缓存），失败返回 null。 */
  async _liveIds() {
    const now = Date.now();
    if (this._modelsCache.value !== null && now - this._modelsCache.at < MODELS_CACHE_TTL_MS) {
      return this._modelsCache.value;
    }
    const apiKey = await resolveApiKey(this.ctx);
    if (!apiKey) { this._modelsCache = { at: now, value: null }; return null; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(DEFAULT_MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch { this._modelsCache = { at: now, value: null }; return null; }
    finally { clearTimeout(timer); }
    if (!res.ok) { this._modelsCache = { at: now, value: null }; return null; }
    let body;
    try { body = await res.json(); } catch { this._modelsCache = { at: now, value: null }; return null; }
    const ids = Array.isArray(body && body.data)
      ? body.data.map((m) => (m && typeof m.id === "string" ? m.id : null)).filter(Boolean)
      : null;
    this._modelsCache = { at: now, value: ids };
    return ids;
  }

  /** 运行时拉取 models.json（GitHub raw），严格校验后转 map；失败回退包内内置 models.json。 */
  async _caps() {
    const now = Date.now();
    if (this._capsCache.value !== null && now - this._capsCache.at < MODELS_CACHE_TTL_MS) {
      return this._capsCache.value;
    }
    // 1) 线上数据源（数据更新走它，用户无需重装）
    try {
      const res = await fetch(MODELS_JSON_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
      if (res.ok) {
        const v = validateCapsTable(await res.json());
        if (v) { this._capsCache = { at: now, value: v }; return v; }
      }
    } catch { /* 走回退 */ }
    // 2) 包内内置快照（离线兜底）
    try {
      const raw = await readFile(new URL("./models.json", import.meta.url), "utf8");
      const v = validateCapsTable(JSON.parse(raw));
      if (v) { this._capsCache = { at: now, value: v }; return v; }
    } catch { /* 彻底无兜底 */ }
    this._capsCache = { at: now, value: null };
    return null;
  }

  /**
   * 返回展示用的模型表（实时清单 ∩ 额度表，接口顺序）：每个元素
   * { id, name, monthlyUsd, free }。数据不可得时 models 为 null，
   * 客户端回退到自带静态表。
   */
  async models() {
    const now = Date.now();
    const [ids, caps] = await Promise.all([this._liveIds(), this._caps()]);
    if (!caps) return { configured: true, reason: null, error: null, models: null };
    let table = [];
    if (ids && ids.length) {
      for (const id of ids) {
        const c = caps[id];
        if (c && (typeof c.monthlyUsd === "number" || c.free)) table.push(c);
      }
    }
    if (table.length === 0) table = tableArray(caps); // 兜底：无实时清单时用整个额度表
    return { configured: true, reason: null, error: null, models: table };
  }
}

export default OpencodeGoUsageGateway;
