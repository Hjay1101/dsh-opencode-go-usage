// dsh-opencode-go-usage —— 客户端半（浏览器 bundle）。
//
// 以 lazy-CJS 格式交给客户端模块加载器：这里只注册工厂函数，
// 真正执行发生在物化（materialize）时。做的事有五件：
//   1. 挂载 opencodeUsage Typert Remote（拿到调用 Host 的通道）
//   2. 注册 settings.section 侧边栏分区「OpenCode Go」（常驻入口）
//   3. 注册 conversation.input.right 工具行控件：当会话当前模型是
//      opencode-go 时，在模型选择器旁边显示一个闪电图标按钮；
//      悬停显示用量百分比，点击弹出独立 Modal
//   4. 弹窗内为左右滑动卡片（v0.3.0）：卡0 = Go 用量总览（三窗口 +
//      按配额换算已用金额），后续卡 = 每个模型的限额（可维护的限额表，
//      存 localStorage），末卡 = 限额表管理
//   5. 渲染用量页面：三个窗口的进度条 / 百分比 / 换算金额 / 重置时间
//
// 注意：结果/参数编解码器是透传——业务结果在 Host 侧已用 zod 校验过，
// 这里只需要描述符的严格形态来挂载和调用，不再重复校验。

window.__ModuleLoader__.load({
  id: "dsh-opencode-go-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;
    // primitives 是 web shell 注册的 shell-own 模块，可直接 require。
    const { Modal, Tooltip } = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "settings.opencodeGoUsage";
    const inject = ["slots", "locale", "remote", "modelDirectories"];

    // ---------- 文案（中 / 英） ----------
    const zh = {
      nav: "OpenCode Go",
      title: "OpenCode Go 用量",
      loading: "查询中…",
      notInModels: "尚未在「设置 → 模型」中添加 opencode-go。请先添加后再查询。",
      noApiKey: "未找到 OpenCode Go API Key（OPENCODE_GO_API_KEY / auth.json）。",
      unauthorized: "API Key 无效或已过期（401）。",
      network: "网络请求失败，请稍后重试。",
      httpError: "接口返回 HTTP {status}。",
      badJson: "接口响应解析失败。",
      refresh: "刷新",
      close: "关闭",
      rolling: "5 小时滚动",
      weekly: "每周",
      monthly: "每月",
      limit: "限额",
      reset: "重置",
      used: "已用",
      unknown: "未知",
      footnote: "限额为展示参考，以 OpenCode Go 实际套餐为准。",
      short5h: "5h",
      shortW: "周",
      shortM: "月",
      openUsage: "查看 OpenCode Go 用量",
      noData: "暂无用量数据",
      // v0.3.0 轮播 + 限额表
      swipeHint: "左右滑动查看模型限额 →",
      modelLimits: "模型限额",
      model: "模型",
      monthlyCap: "月额度上限",
      reqHint: "请求上限（次）",
      accountMonthly: "套餐月用量",
      manage: "管理限额表",
      addModel: "添加模型",
      resetDefaults: "恢复默认",
      deleteM: "删除",
      name: "名称",
      noModels: "暂无模型限额 — 滑到最右添加",
      dataNote: "官方接口未提供单模型用量；限额为政策参考，随套餐变动。",
    };
    const en = {
      nav: "OpenCode Go",
      title: "OpenCode Go usage",
      loading: "Loading…",
      notInModels: "opencode-go is not added under Settings → Models yet. Add it first.",
      noApiKey: "No OpenCode Go API key found (OPENCODE_GO_API_KEY / auth.json).",
      unauthorized: "API key is invalid or expired (401).",
      network: "Network request failed, try again later.",
      httpError: "HTTP {status} from the usage endpoint.",
      badJson: "Failed to parse the usage response.",
      refresh: "Refresh",
      close: "Close",
      rolling: "5h rolling",
      weekly: "Weekly",
      monthly: "Monthly",
      limit: "limit",
      reset: "resets",
      used: "used",
      unknown: "unknown",
      footnote: "Limits shown for reference only; follow your OpenCode Go plan.",
      short5h: "5h",
      shortW: "W",
      shortM: "M",
      openUsage: "View OpenCode Go usage",
      noData: "No usage data yet",
      // v0.3.0 carousel + limit table
      swipeHint: "Swipe to see model limits →",
      modelLimits: "Model limits",
      model: "Model",
      monthlyCap: "Monthly cap",
      reqHint: "Request cap",
      accountMonthly: "Plan monthly usage",
      manage: "Manage limits",
      addModel: "Add model",
      resetDefaults: "Reset defaults",
      deleteM: "Remove",
      name: "Name",
      noModels: "No model limits yet — swipe to the end to add",
      dataNote: "No per-model usage from the official API; limits are policy references and may change.",
    };

    // ---------- Remote 描述符 ----------
    // 带一个 force 参数（true = 绕过 Host 缓存强制刷新），与 typert.host.js 对齐。
    const TYPERT_REMOTE = {
      package: "dsh-opencode-go-usage",
      descriptors: [
        {
          id: "dsh-opencode-go-usage#opencodeUsage/usage",
          service: "opencodeUsage",
          namespace: "opencodeUsage",
          method: "usage",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "force",
              wire: "force",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-opencode-go-usage#usage:force",
                schema: { parse(value) { return value; } },
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-opencode-go-usage#OpencodeGoUsageResult",
            schema: { parse(value) { return value; } },
          },
        },
      ],
    };

    // ---------- 配额与限额表 ----------
    // 官方配额（政策数字，用于 percent×配额换算已用金额；接口不返回）。
    const QUOTAS = { rolling: 12, weekly: 30, monthly: 60 };
    // 限额表：localStorage 持久化，UI 可维护，默认仅 DeepSeek（社区公开政策：月上限 $30）。
    const LIMITS_STORAGE_KEY = "opencode-go-usage.limits.v1";
    const DEFAULT_LIMITS = [
      { id: "deepseek", name: "DeepSeek", monthlyUsd: 30, req5h: null, reqWeek: null, reqMonth: null },
    ];
    function normalizeEntry(v) {
      const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
      return {
        id: String(v && v.id || ("m" + Date.now() + Math.random().toString(36).slice(2, 6))),
        name: String(v && v.name || ""),
        monthlyUsd: num(v && v.monthlyUsd),
        req5h: num(v && v.req5h),
        reqWeek: num(v && v.reqWeek),
        reqMonth: num(v && v.reqMonth),
      };
    }
    function loadLimits() {
      try {
        const raw = localStorage.getItem(LIMITS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed.map(normalizeEntry);
        }
      } catch { /* 损坏则回退默认 */ }
      return DEFAULT_LIMITS.map(normalizeEntry);
    }
    function persistLimits(list) {
      try { localStorage.setItem(LIMITS_STORAGE_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
    }
    function usd(n) {
      return Number.isFinite(n) ? "$" + n.toFixed(2) : "—";
    }

    // 注入一次轮播滚动条样式（懒执行，幂等）。
    let cssInjected = false;
    function ensureCarouselCss() {
      if (cssInjected) return;
      cssInjected = true;
      try {
        const style = document.createElement("style");
        style.textContent =
          ".ocu-track{scrollbar-width:none}.ocu-track::-webkit-scrollbar{display:none}";
        document.head.appendChild(style);
      } catch { /* 忽略 */ }
    }

    // ---------- 样式（跟随 harness 主题变量） ----------
    const styles = {
      wrap: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 14, padding: "8px 0" },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.6, margin: 0 },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13, lineHeight: 1.6, margin: 0 },
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 },
      cardHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
      cardName: { fontSize: 14, fontWeight: 600, margin: 0 },
      cardMeta: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: 0 },
      barTrack: { height: 8, borderRadius: 4, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" },
      barFill: { height: "100%", borderRadius: 4, background: "var(--dsw-alias-state-business-primary)", transition: "width .2s ease" },
      row: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--dsw-alias-label-secondary)", gap: 8 },
      rowLabel: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
      button: { alignSelf: "flex-start", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "transparent", borderRadius: 6, padding: "5px 12px" },
      // 工具行小按钮：无边框幽灵按钮，跟随主题色。
      toolButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", borderRadius: 4 },
      // v0.3.0 轮播
      carouselWrap: { display: "flex", flexDirection: "column", gap: 10, padding: "2px 0 4px" },
      track: { display: "flex", gap: 12, overflowX: "auto", scrollSnapType: "x mandatory", scrollbarWidth: "none", paddingBottom: 2 },
      slide: { minWidth: "calc(100% - 44px)", scrollSnapAlign: "start", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 10 },
      dots: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10 },
      dot: { width: 7, height: 7, borderRadius: "50%", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", cursor: "pointer", padding: 0, flex: "none" },
      dotActive: { background: "var(--dsw-alias-state-business-primary)", borderColor: "var(--dsw-alias-state-business-primary)" },
      arrow: { border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: 16, padding: "0 6px", lineHeight: 1 },
      input: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", borderRadius: 6, padding: "4px 6px", fontSize: 12, font: "inherit", width: "100%", boxSizing: "border-box" },
      editorRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      btnRow: { display: "flex", gap: 10, marginTop: 4 },
    };

    function fmtReset(resetsAt, t) {
      if (!resetsAt) return t("unknown");
      const d = new Date(resetsAt);
      if (Number.isNaN(d.getTime())) return resetsAt;
      return d.toLocaleString();
    }

    // ---------- 单个用量窗口卡片 ----------
    // quotaUsd: 该窗口的政策配额（$），用于换算已用金额。
    function WindowCard(props) {
      const { name, quotaUsd, windowData, t } = props;
      const percent = windowData && typeof windowData.percent === "number" ? windowData.percent : null;
      const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
      const used = percent === null ? null : (pct / 100) * quotaUsd;
      return React.createElement("div", { style: styles.card },
        React.createElement("div", { style: styles.cardHead },
          React.createElement("h3", { style: styles.cardName }, name),
          React.createElement("p", { style: styles.cardMeta }, t("limit") + ": " + usd(quotaUsd))
        ),
        React.createElement("div", { style: styles.barTrack },
          React.createElement("div", { style: { ...styles.barFill, width: pct + "%" } })
        ),
        React.createElement("div", { style: styles.row },
          React.createElement("span", null, percent === null ? t("unknown") : pct + "%"),
          React.createElement("span", null, t("reset") + ": " + fmtReset(windowData && windowData.resetsAt, t))
        ),
        React.createElement("div", { style: styles.row },
          React.createElement("span", null, t("used") + " " + usd(used) + " / " + usd(quotaUsd)),
          React.createElement("span", { style: styles.rowLabel }, t("limit"))
        )
      );
    }

    // ---------- 闪电图标 ----------
    function BoltIcon(props) {
      const { size = 16 } = props;
      return React.createElement("svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor", xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("path", { d: "M9.75 1 L3.25 9.5 H7 L6 15 L12.75 6.5 H8.9 Z" })
      );
    }

    // ---------- 用量主体（设置页用：堆叠卡片 + 脚注 + 刷新） ----------
    function UsageBody(props) {
      const { query, t, title, showFootnote = false, showRefresh = true } = props;
      const [state, setState] = React.useState({ kind: "loading" });

      const load = React.useCallback(() => {
        setState({ kind: "loading" });
        Promise.resolve()
          .then(() => query())
          .then((result) => {
            if (!result || result.ok === false) {
              setState({ kind: "failure", message: (result && result.error && result.error.message) || "remote failed" });
              return;
            }
            setState({ kind: "done", value: result.value });
          })
          .catch((e) => setState({ kind: "failure", message: String((e && e.message) || e) }));
      }, [query]);

      React.useEffect(() => { load(); }, [load]);

      if (state.kind === "loading") {
        return React.createElement("div", { style: styles.wrap },
          React.createElement("p", { style: styles.hint }, t("loading"))
        );
      }
      if (state.kind === "failure") {
        return React.createElement("div", { style: styles.wrap },
          React.createElement("p", { style: styles.error }, state.message),
          showRefresh ? React.createElement("button", { style: styles.button, onClick: load }, t("refresh")) : null
        );
      }

      const value = state.value || {};
      if (value.configured !== true) {
        const msg = value.reason === "no-api-key" ? t("noApiKey") : t("notInModels");
        return React.createElement("div", { style: styles.wrap },
          React.createElement("p", { style: styles.error }, msg),
          showRefresh ? React.createElement("button", { style: styles.button, onClick: load }, t("refresh")) : null
        );
      }
      if (value.error) {
        let msg = value.error;
        if (value.error === "unauthorized") msg = t("unauthorized");
        else if (value.error === "network") msg = t("network");
        else if (value.error === "bad-json") msg = t("badJson");
        else if (value.error.startsWith("http-")) msg = t("httpError").replace("{status}", value.error.slice(5));
        return React.createElement("div", { style: styles.wrap },
          React.createElement("p", { style: styles.error }, msg),
          showRefresh ? React.createElement("button", { style: styles.button, onClick: load }, t("refresh")) : null
        );
      }

      const usage = value.usage || {};
      return React.createElement("div", { style: styles.wrap },
        title ? React.createElement("h2", { style: styles.title }, title) : null,
        React.createElement(WindowCard, { name: t("rolling"), quotaUsd: QUOTAS.rolling, windowData: usage.rolling, t }),
        React.createElement(WindowCard, { name: t("weekly"), quotaUsd: QUOTAS.weekly, windowData: usage.weekly, t }),
        React.createElement(WindowCard, { name: t("monthly"), quotaUsd: QUOTAS.monthly, windowData: usage.monthly, t }),
        showFootnote ? React.createElement("p", { style: styles.hint }, t("footnote")) : null,
        showRefresh ? React.createElement("button", { style: styles.button, onClick: load }, t("refresh")) : null
      );
    }

    // ---------- 轮播弹窗（v0.3.0） ----------
    // 卡0：Go 用量总览；卡1..N：每个模型的限额；末卡：限额表管理。
    function CarouselUsage(props) {
      const { query, t } = props;
      const [state, setState] = React.useState({ kind: "loading" });
      const [limits, setLimits] = React.useState(loadLimits);
      const [active, setActive] = React.useState(0);
      const trackRef = useRef(null);

      const load = React.useCallback(() => {
        setState({ kind: "loading" });
        Promise.resolve()
          .then(() => query())
          .then((result) => {
            if (!result || result.ok === false) {
              setState({ kind: "failure", message: (result && result.error && result.error.message) || "remote failed" });
              return;
            }
            setState({ kind: "done", value: result.value });
          })
          .catch((e) => setState({ kind: "failure", message: String((e && e.message) || e) }));
      }, [query]);

      React.useEffect(() => { load(); }, [load]);
      React.useEffect(() => { persistLimits(limits); }, [limits]);

      // 轮播页码计算：单页步进 = clientWidth - 44(slide 缩进) + 12(gap)
      const pageStep = () => {
        const el = trackRef.current;
        return el && el.clientWidth > 0 ? el.clientWidth - 44 + 12 : 0;
      };
      const onScroll = () => {
        const el = trackRef.current;
        const step = pageStep();
        if (!el || step <= 0) return;
        setActive(Math.max(0, Math.min(slideCount(), Math.round(el.scrollLeft / step))));
      };
      const goTo = (i) => {
        const el = trackRef.current;
        const step = pageStep();
        if (el && step > 0) el.scrollTo({ left: i * step, behavior: "smooth" });
        setActive(i);
      };

      // ---- 各卡片内容 ----
      const overviewSlide = (usage) => React.createElement("div", { key: "overview", style: styles.slide },
        React.createElement("p", { style: styles.hint }, t("swipeHint")),
        React.createElement(WindowCard, { name: t("rolling"), quotaUsd: QUOTAS.rolling, windowData: usage.rolling, t }),
        React.createElement(WindowCard, { name: t("weekly"), quotaUsd: QUOTAS.weekly, windowData: usage.weekly, t }),
        React.createElement(WindowCard, { name: t("monthly"), quotaUsd: QUOTAS.monthly, windowData: usage.monthly, t })
      );

      const modelSlide = (m, monthlyPct, i) => {
        const fmtReq = (v) => (v === null || v === undefined ? "—" : String(v));
        const rows = [
          [t("monthlyCap"), usd(m.monthlyUsd)],
          [t("short5h") + " " + t("reqHint"), fmtReq(m.req5h)],
          [t("shortW") + " " + t("reqHint"), fmtReq(m.reqWeek)],
          [t("shortM") + " " + t("reqHint"), fmtReq(m.reqMonth)],
          [t("accountMonthly"), (monthlyPct === null ? "—" : monthlyPct + "%")],
        ];
        return React.createElement("div", { key: "model-" + m.id, style: styles.slide },
          React.createElement("div", { style: styles.card },
            React.createElement("div", { style: styles.cardHead },
              React.createElement("h3", { style: styles.cardName }, m.name || t("unknown")),
              React.createElement("p", { style: styles.cardMeta }, t("modelLimits"))
            ),
            rows.map((r, ri) =>
              React.createElement("div", { key: ri, style: styles.row },
                React.createElement("span", { style: styles.rowLabel }, r[0]),
                React.createElement("span", null, r[1])
              )
            )
          )
        );
      };

      const emptyModelSlide = () => React.createElement("div", { key: "models-empty", style: styles.slide },
        React.createElement("div", { style: styles.card },
          React.createElement("p", { style: styles.hint }, t("noModels"))
        )
      );

      const updateEntry = (id, patch) =>
        setLimits((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      const removeEntry = (id) => setLimits((list) => list.filter((x) => x.id !== id));
      const addEntry = () =>
        setLimits((list) => [...list, normalizeEntry({ id: "m" + Date.now(), name: "", monthlyUsd: null })]);
      const resetDefaults = () => setLimits(DEFAULT_LIMITS.map(normalizeEntry));

      const inputNum = (v) => (v === null || v === undefined || v === "" ? "" : String(v));
      const parseNum = (s) => (s === "" ? null : Number(s));

      const manageSlide = () => React.createElement("div", { key: "manage", style: styles.slide },
        React.createElement("h3", { style: styles.title }, t("manage")),
        limits.map((m) =>
          React.createElement("div", { key: m.id, style: styles.editorRow },
            React.createElement("input", {
              style: { ...styles.input, flex: 1.4, minWidth: 70 },
              value: m.name,
              placeholder: t("name"),
              onChange: (e) => updateEntry(m.id, { name: e.target.value }),
            }),
            React.createElement("input", {
              style: { ...styles.input, width: 74 },
              type: "number", min: 0, step: 1,
              value: inputNum(m.monthlyUsd),
              title: t("monthlyCap"),
              onChange: (e) => updateEntry(m.id, { monthlyUsd: parseNum(e.target.value) }),
            }),
            React.createElement("input", {
              style: { ...styles.input, width: 60 },
              type: "number", min: 0, step: 1,
              value: inputNum(m.req5h),
              title: t("short5h") + " " + t("reqHint"),
              onChange: (e) => updateEntry(m.id, { req5h: parseNum(e.target.value) }),
            }),
            React.createElement("input", {
              style: { ...styles.input, width: 60 },
              type: "number", min: 0, step: 1,
              value: inputNum(m.reqWeek),
              title: t("shortW") + " " + t("reqHint"),
              onChange: (e) => updateEntry(m.id, { reqWeek: parseNum(e.target.value) }),
            }),
            React.createElement("input", {
              style: { ...styles.input, width: 60 },
              type: "number", min: 0, step: 1,
              value: inputNum(m.reqMonth),
              title: t("shortM") + " " + t("reqHint"),
              onChange: (e) => updateEntry(m.id, { reqMonth: parseNum(e.target.value) }),
            }),
            React.createElement("button", { style: styles.button, onClick: () => removeEntry(m.id) }, t("deleteM"))
          )
        ),
        React.createElement("div", { style: styles.btnRow },
          React.createElement("button", { style: styles.button, onClick: addEntry }, t("addModel")),
          React.createElement("button", { style: styles.button, onClick: resetDefaults }, t("resetDefaults"))
        )
      );

      const slideCount = () => 1 + (limits.length > 0 ? limits.length : 1) + 1;

      // ---- 状态渲染 ----
      if (state.kind === "loading") {
        return React.createElement("p", { style: styles.hint }, t("loading"));
      }
      if (state.kind === "failure") {
        return React.createElement("p", { style: styles.error }, state.message);
      }
      const value = state.value || {};
      if (value.configured !== true) {
        return React.createElement("p", { style: styles.error },
          value.reason === "no-api-key" ? t("noApiKey") : t("notInModels"));
      }
      if (value.error) {
        let msg = value.error;
        if (value.error === "unauthorized") msg = t("unauthorized");
        else if (value.error === "network") msg = t("network");
        else if (value.error === "bad-json") msg = t("badJson");
        else if (value.error.startsWith("http-")) msg = t("httpError").replace("{status}", value.error.slice(5));
        return React.createElement("p", { style: styles.error }, msg);
      }

      const usage = value.usage || {};
      const monthlyPct = usage.monthly && typeof usage.monthly.percent === "number" ? usage.monthly.percent : null;

      const slides = [overviewSlide(usage)];
      if (limits.length > 0) {
        limits.forEach((m, i) => slides.push(modelSlide(m, monthlyPct, i)));
      } else {
        slides.push(emptyModelSlide());
      }
      slides.push(manageSlide());

      return React.createElement("div", { style: styles.carouselWrap },
        React.createElement("div", { ref: trackRef, className: "ocu-track", style: styles.track, onScroll },
          slides
        ),
        React.createElement("div", { style: styles.dots },
          React.createElement("button", { style: styles.arrow, type: "button", "aria-label": "<", onClick: () => goTo(Math.max(0, active - 1)) }, "‹"),
          slides.map((s, i) =>
            React.createElement("button", {
              key: i,
              type: "button",
              style: i === active ? { ...styles.dot, ...styles.dotActive } : styles.dot,
              "aria-label": "card " + (i + 1),
              onClick: () => goTo(i),
            })
          ),
          React.createElement("button", { style: styles.arrow, type: "button", "aria-label": ">", onClick: () => goTo(Math.min(slides.length - 1, active + 1)) }, "›")
        ),
        React.createElement("p", { style: styles.hint }, t("dataNote"))
      );
    }

    // 悬停提示文案：三个窗口的紧凑百分比。
    function tooltipText(usage, t) {
      if (!usage) return t("noData");
      const fmt = (w) => (w && typeof w.percent === "number" ? w.percent + "%" : "—");
      return t("short5h") + " " + fmt(usage.rolling) + " · " + t("shortW") + " " + fmt(usage.weekly) + " · " + t("shortM") + " " + fmt(usage.monthly);
    }

    // ---------- 工具行控件（conversation.input.right） ----------
    function UsageButton(props) {
      const { directory, query, forceQuery, t } = props;
      const [open, setOpen] = React.useState(false);
      const [usage, setUsage] = React.useState(null);

      const state = useSyncExternalStore(
        (fn) => directory.subscribe(fn),
        () => directory.getSnapshot()
      );
      const isOpencode = !!(state && state.current && state.current.provider === "opencode-go");

      useEffect(() => {
        if (!isOpencode) return;
        let alive = true;
        query().then((r) => { if (alive && r && r.value) setUsage(r.value.usage); }).catch(() => {});
        return () => { alive = false; };
      }, [isOpencode, query]);

      useEffect(() => {
        if (open || !isOpencode) return;
        let alive = true;
        query().then((r) => { if (alive && r && r.value) setUsage(r.value.usage); }).catch(() => {});
        return () => { alive = false; };
      }, [open, isOpencode, query]);

      if (!isOpencode) return null;

      return React.createElement(React.Fragment, null,
        React.createElement(Tooltip,
          { label: tooltipText(usage, t), side: "top", delayMs: 400 },
          React.createElement("button",
            {
              style: styles.toolButton,
              type: "button",
              onClick: () => setOpen(true),
              "aria-label": t("openUsage"),
            },
            React.createElement(BoltIcon, null)
          )
        ),
        React.createElement(Modal,
          {
            open,
            onClose: () => setOpen(false),
            title: t("title"),
            closeLabel: t("close"),
            contentClassName: "opencode-go-usage-modal-body",
          },
          React.createElement(CarouselUsage, { query: forceQuery, t })
        )
      );
    }

    // ---------- 插件装配 ----------
    function apply(ctx) {
      ensureCarouselCss();
      const mountReady = ctx.remote.$mount(TYPERT_REMOTE);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "opencode-go-usage: dictionaries");
      const t = ctx.locale.bind(NS);

      const query = async () => {
        await mountReady;
        const api = ctx.get("remote.opencodeUsage");
        if (!api) throw new Error("opencodeUsage remote is unavailable");
        return api.usage(false);
      };
      const forceQuery = async () => {
        await mountReady;
        const api = ctx.get("remote.opencodeUsage");
        if (!api) throw new Error("opencodeUsage remote is unavailable");
        return api.usage(true);
      };

      // 入口 1：设置页侧边栏常驻分区。
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "opencode-go",
        order: 40,
        label: () => t("nav"),
        locale: NS,
        inject: () => ({ query, t }),
      }, (props) => React.createElement(UsageBody, { query, t: props.t, title: t("title"), showFootnote: true })));

      // 入口 2：会话工具行的闪电按钮（仅 opencode-go 模型时出现）。
      ctx.inject(["slots", "modelDirectories"], (scope) => {
        const models = scope.modelDirectories;
        scope.slots.inject("conversation.input.right", () => scope.slots.register({
          name: "conversation.input.right",
          id: "opencode-go-usage",
          order: 100,
          locale: NS,
          inject: (sessionId) => {
            const directory = models.directoryFor(sessionId);
            return { directory: directory.store, query, forceQuery, t };
          },
        }, UsageButton));
      });
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});