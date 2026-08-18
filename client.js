// dsh-opencode-go-usage —— 客户端半（浏览器 bundle）。
//
// 以 lazy-CJS 格式交给客户端模块加载器：这里只注册工厂函数，
// 真正执行发生在物化（materialize）时。做的事有四件：
//   1. 挂载 opencodeUsage Typert Remote（拿到调用 Host 的通道）
//   2. 注册 settings.section 侧边栏分区「OpenCode Go」（常驻入口）
//   3. 注册 conversation.input.right 工具行控件：当会话当前模型是
//      opencode-go 时，在模型选择器旁边显示一个闪电图标按钮；
//      悬停显示用量百分比，点击弹出独立 Modal
//   4. 弹窗为左右滑动卡片（v0.3.1）：卡0 = Go 用量总览（三窗口 +
//      按配额换算已用金额）；卡1 = 官方支持的模型与限额表（静态表，
//      来自 opencode.ai/docs/go 公开文档 + /zen/go/v1/models 清单）
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
      modelCardTitle: "支持的模型与月额度",
      capCol: "月额度",
      model: "模型",
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
      modelCardTitle: "Supported models & monthly caps",
      capCol: "Cap",
      model: "Model",
    };

    // ---------- Remote 描述符 ----------
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

    // ---------- 官方配额（政策数字，用于 percent×配额换算已用金额） ----------
    const QUOTAS = { rolling: 12, weekly: 30, monthly: 60 };

    // ---------- 官方支持的模型与限额（静态表） ----------
    // 数据来源：opencode.ai/docs/go（公开文档，含每模型月额度和 5h/周/月
    // 请求上限估算）与 /zen/go/v1/models（模型清单）。无公开数据的模型
    // 显示 "—"。清单随官方调整，需更新时改这里即可。
    // 字段：id, name, monthlyUsd(月额度)
    const MODEL_LIST = [
      { id: "grok-4.5", name: "Grok 4.5", monthlyUsd: 15 },
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", monthlyUsd: 15 },
      { id: "glm-5.3", name: "GLM 5.3", monthlyUsd: 15 },
      { id: "glm-5.2", name: "GLM 5.2", monthlyUsd: 60 },
      { id: "glm-5.1", name: "GLM 5.1", monthlyUsd: 60 },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", monthlyUsd: 15 },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", monthlyUsd: 30 },
      { id: "kimi-k3", name: "Kimi K3", monthlyUsd: 15 },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", monthlyUsd: 60 },
      { id: "kimi-k2.6", name: "Kimi K2.6", monthlyUsd: 60 },
      { id: "qwen3.8-max", name: "Qwen3.8 Max", monthlyUsd: 15 },
      { id: "qwen3.7-max", name: "Qwen3.7 Max", monthlyUsd: 60 },
      { id: "qwen3.7-plus", name: "Qwen3.7 Plus", monthlyUsd: 60 },
      { id: "qwen3.6-plus", name: "Qwen3.6 Plus", monthlyUsd: 60 },
      { id: "mimo-v2.5", name: "MiMo V2.5", monthlyUsd: 60 },
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", monthlyUsd: 15 },
      { id: "minimax-m3", name: "MiniMax M3", monthlyUsd: 60 },
      { id: "minimax-m2.7", name: "MiniMax M2.7", monthlyUsd: 60 },
      { id: "minimax-m2.5", name: "MiniMax M2.5", monthlyUsd: 60 },
      { id: "hy3", name: "Hy3", monthlyUsd: 60 },
    ];

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
      // 轮播
      carouselWrap: { display: "flex", flexDirection: "column", gap: 10, padding: "2px 0 4px" },
      track: { display: "flex", gap: 12, overflowX: "auto", scrollSnapType: "x mandatory", scrollbarWidth: "none", paddingBottom: 2 },
      slide: { minWidth: "calc(100% - 44px)", scrollSnapAlign: "start", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 10 },
      dots: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10 },
      dot: { width: 7, height: 7, borderRadius: "50%", border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", cursor: "pointer", padding: 0, flex: "none" },
      dotActive: { background: "var(--dsw-alias-state-business-primary)", borderColor: "var(--dsw-alias-state-business-primary)" },
      arrow: { border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: 16, padding: "0 6px", lineHeight: 1 },
      // 模型限额表
      tableHead: { display: "flex", gap: 10, padding: "4px 12px", fontSize: 12, color: "var(--dsw-alias-label-tertiary)", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      tableRow: { display: "flex", gap: 10, padding: "7px 12px", fontSize: 12, color: "var(--dsw-alias-label-secondary)", borderBottom: "1px solid var(--dsw-alias-border-l1)", alignItems: "center" },
      tableBody: { overflowY: "auto" },
      colModel: { flex: 1.6, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" },
      colCap: { flex: 0.7, textAlign: "right" },
      colReq: { flex: 1, textAlign: "right" },
    };

    function fmtReset(resetsAt, t) {
      if (!resetsAt) return t("unknown");
      const d = new Date(resetsAt);
      if (Number.isNaN(d.getTime())) return resetsAt;
      return d.toLocaleString();
    }
    function usd(n) {
      return Number.isFinite(n) ? "$" + n.toFixed(2) : "—";
    }

    // ---------- 单个用量窗口卡片 ----------
    // quotaUsd: 该窗口的政策配额（$），用于换算已用金额。
    function WindowCard(props) {
      const { name, quotaUsd, windowData, t } = props;
      const percent = windowData && typeof windowData.percent === "number" ? windowData.percent : null;
      const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
      const used = percent === null ? null : (pct / 100) * quotaUsd;
      const cardStyle = props.grow
        ? { ...styles.card, flex: "1 1 0", minHeight: 0 }
        : styles.card;
      return React.createElement("div", { style: cardStyle },
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

    // ---------- 模型与限额表 ----------
    function ModelTable(props) {
      const { t } = props;
      const head = React.createElement("div", { style: styles.tableHead },
        React.createElement("span", { style: styles.colModel }, t("model")),
        React.createElement("span", { style: styles.colCap }, t("capCol")),
      );
      const rows = MODEL_LIST.map((m) =>
        React.createElement("div", { key: m.id, style: styles.tableRow },
          React.createElement("span", { style: styles.colModel, title: m.id }, m.name),
          React.createElement("span", { style: styles.colCap }, usd(m.monthlyUsd)),
        )
      );
      const cardStyle = { ...styles.card, flex: "1 1 0", minHeight: 0, maxHeight: 480 };
      return React.createElement("div", { style: cardStyle },
        React.createElement("h3", { style: styles.cardName }, t("modelCardTitle")),
        head,
        React.createElement("div", { style: { ...styles.tableBody, flex: "1 1 0", minHeight: 0 } }, rows)
      );
    }

    // ---------- 轮播弹窗（v0.3.1） ----------
    // 卡0：Go 用量总览；卡1：支持的模型与限额表。
    function CarouselUsage(props) {
      const { query, t } = props;
      const [state, setState] = React.useState({ kind: "loading" });
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

      const pageStep = () => {
        const el = trackRef.current;
        return el && el.clientWidth > 0 ? el.clientWidth - 44 + 12 : 0;
      };
      const slideCount = 2;
      const onScroll = () => {
        const el = trackRef.current;
        const step = pageStep();
        if (!el || step <= 0) return;
        setActive(Math.max(0, Math.min(slideCount - 1, Math.round(el.scrollLeft / step))));
      };
      const goTo = (i) => {
        const el = trackRef.current;
        const step = pageStep();
        if (el && step > 0) el.scrollTo({ left: i * step, behavior: "smooth" });
        setActive(i);
      };

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
      const slides = [
        React.createElement("div", { key: "overview", style: styles.slide },
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10, flex: "1 1 0", minHeight: 0 } },
            React.createElement(WindowCard, { grow: true, name: t("rolling"), quotaUsd: QUOTAS.rolling, windowData: usage.rolling, t }),
            React.createElement(WindowCard, { grow: true, name: t("weekly"), quotaUsd: QUOTAS.weekly, windowData: usage.weekly, t }),
            React.createElement(WindowCard, { grow: true, name: t("monthly"), quotaUsd: QUOTAS.monthly, windowData: usage.monthly, t })
          )
        ),
        React.createElement("div", { key: "models", style: styles.slide },
          React.createElement(ModelTable, { t })
        ),
      ];

      return React.createElement("div", { style: styles.carouselWrap },
        React.createElement("div", { ref: trackRef, style: styles.track, onScroll }, slides),
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
        )
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