// dsh-opencode-go-usage —— 客户端半（浏览器 bundle）。
//
// 以 lazy-CJS 格式交给客户端模块加载器：这里只注册工厂函数，
// 真正执行发生在物化（materialize）时。做的事有四件：
//   1. 挂载 opencodeUsage Typert Remote（拿到调用 Host 的通道）
//   2. 注册 settings.section 侧边栏分区「OpenCode Go」（常驻入口）
//   3. 注册 conversation.input.right 工具行控件：当会话当前模型是
//      opencode-go 时，在模型选择器旁边显示一个仪表盘图标按钮；
//      悬停显示用量百分比，点击弹出独立 Modal 看三个窗口明细
//   4. 渲染用量页面：三个窗口的进度条 / 百分比 / 限额 / 重置时间
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
    const { useCallback, useEffect, useState, useSyncExternalStore } = React;
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
      unknown: "未知",
      footnote: "限额为展示参考，以 OpenCode Go 实际套餐为准。",
      short5h: "5h",
      shortW: "周",
      shortM: "月",
      openUsage: "查看 OpenCode Go 用量",
      noData: "暂无用量数据",
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
      unknown: "unknown",
      footnote: "Limits shown for reference only; follow your OpenCode Go plan.",
      short5h: "5h",
      shortW: "W",
      shortM: "M",
      openUsage: "View OpenCode Go usage",
      noData: "No usage data yet",
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

    // 展示用限额（接口不返回限额字段，仅供直观参考）。
    const LIMITS = { rolling: "$12", weekly: "$30", monthly: "$60" };

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
      button: { alignSelf: "flex-start", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "transparent", borderRadius: 6, padding: "5px 12px" },
      // 工具行小按钮：无边框幽灵按钮，跟随主题色。
      toolButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", borderRadius: 4 },
    };

    function fmtReset(resetsAt, t) {
      if (!resetsAt) return t("unknown");
      const d = new Date(resetsAt);
      if (Number.isNaN(d.getTime())) return resetsAt;
      return d.toLocaleString();
    }

    // ---------- 单个用量窗口卡片 ----------
    function WindowCard(props) {
      const { name, limit, windowData, t } = props;
      const percent = windowData && typeof windowData.percent === "number" ? windowData.percent : null;
      const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
      return React.createElement("div", { style: styles.card },
        React.createElement("div", { style: styles.cardHead },
          React.createElement("h3", { style: styles.cardName }, name),
          React.createElement("p", { style: styles.cardMeta }, t("limit") + ": " + limit)
        ),
        React.createElement("div", { style: styles.barTrack },
          React.createElement("div", { style: { ...styles.barFill, width: pct + "%" } })
        ),
        React.createElement("div", { style: styles.row },
          React.createElement("span", null, percent === null ? t("unknown") : percent + "%"),
          React.createElement("span", null, t("reset") + ": " + fmtReset(windowData && windowData.resetsAt, t))
        )
      );
    }

    // ---------- 仪表盘图标 ----------
    // 表盘弧 + 指针：指针角度 = 用量百分比（0% 在左下，100% 在右下），
    // 用量越高指针越偏右，一眼看到余量。
    function GaugeIcon(props) {
      const { percent, size = 16 } = props;
      const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
      // 屏幕坐标（y 向下）：弧从 210° 经正上方到 330°，表盘开口朝下。
      const angle = 210 + 1.2 * p;
      const rad = (angle * Math.PI) / 180;
      const tipX = 8 + 5 * Math.cos(rad);
      const tipY = 8 + 5 * Math.sin(rad);
      return React.createElement("svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("path", { d: "M2.804 5 A 6 6 0 0 1 13.196 5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", opacity: 0.4 }),
        React.createElement("line", { x1: 8, y1: 8, x2: tipX.toFixed(3), y2: tipY.toFixed(3), stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" })
      );
    }

    // ---------- 用量主体（设置页与弹窗共用） ----------
    // query: () => Promise<result.value>；组件内部管理 loading / 错误 / 数据态。
    function UsageBody(props) {
      const { query, t, title } = props;
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
          React.createElement("button", { style: styles.button, onClick: load }, t("refresh"))
        );
      }

      const value = state.value || {};
      if (value.configured !== true) {
        const msg = value.reason === "no-api-key" ? t("noApiKey") : t("notInModels");
        return React.createElement("div", { style: styles.wrap },
          React.createElement("p", { style: styles.error }, msg),
          React.createElement("button", { style: styles.button, onClick: load }, t("refresh"))
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
          React.createElement("button", { style: styles.button, onClick: load }, t("refresh"))
        );
      }

      const usage = value.usage || {};
      return React.createElement("div", { style: styles.wrap },
        title ? React.createElement("h2", { style: styles.title }, title) : null,
        React.createElement(WindowCard, { name: t("rolling"), limit: LIMITS.rolling, windowData: usage.rolling, t }),
        React.createElement(WindowCard, { name: t("weekly"), limit: LIMITS.weekly, windowData: usage.weekly, t }),
        React.createElement(WindowCard, { name: t("monthly"), limit: LIMITS.monthly, windowData: usage.monthly, t }),
        React.createElement("p", { style: styles.hint }, t("footnote")),
        React.createElement("button", { style: styles.button, onClick: load }, t("refresh"))
      );
    }

    // 从用量结果里取滚动窗口百分比（工具行按钮/悬停提示用）。
    function rollingPercent(usage) {
      const w = usage && usage.rolling;
      return w && typeof w.percent === "number" ? w.percent : null;
    }

    // 悬停提示文案：三个窗口的紧凑百分比。
    function tooltipText(usage, t) {
      if (!usage) return t("noData");
      const fmt = (w) => (w && typeof w.percent === "number" ? w.percent + "%" : "—");
      return t("short5h") + " " + fmt(usage.rolling) + " · " + t("shortW") + " " + fmt(usage.weekly) + " · " + t("shortM") + " " + fmt(usage.monthly);
    }

    // ---------- 工具行控件（conversation.input.right） ----------
    // 仅当当前会话模型 provider 为 opencode-go 时渲染；悬停显示用量，
    // 点击弹出独立 Modal（打开即强制刷新）。
    function UsageButton(props) {
      const { directory, query, forceQuery, t } = props;
      const [open, setOpen] = React.useState(false);
      const [usage, setUsage] = React.useState(null);

      // 订阅会话模型目录：当前选择的提供方变化时驱动显隐。
      const state = useSyncExternalStore(
        (fn) => directory.subscribe(fn),
        () => directory.getSnapshot()
      );
      const isOpencode = !!(state && state.current && state.current.provider === "opencode-go");

      // 可见时用缓存查询拉一次用量（Host 60s 缓存，成本可忽略）。
      useEffect(() => {
        if (!isOpencode) return;
        let alive = true;
        query().then((r) => { if (alive && r && r.value) setUsage(r.value.usage); }).catch(() => {});
        return () => { alive = false; };
      }, [isOpencode, query]);

      // 弹窗关闭后回同步一次，让指针/提示跟上最新数据。
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
            React.createElement(GaugeIcon, { percent: rollingPercent(usage) })
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
          React.createElement(UsageBody, { query: forceQuery, t })
        )
      );
    }

    // ---------- 插件装配 ----------
    function apply(ctx) {
      // 挂载 Remote：调用 Host 的 usage() 前必须先等它就绪。
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
      }, (props) => React.createElement(UsageBody, { query, t: props.t, title: t("title") })));

      // 入口 2：会话工具行的仪表盘按钮（仅 opencode-go 模型时出现）。
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
