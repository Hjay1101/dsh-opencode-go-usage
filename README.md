# dsh-opencode-go-usage

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI plugin: adds an **OpenCode Go** entry to the Settings sidebar, so you can see the three usage windows of your OpenCode Go subscription — **5h rolling / weekly / monthly** — with used percentage, progress bars and reset times.

> This repository is an independent, from-scratch implementation. The code structure, comments and implementation details are original; functionally equivalent to the plugin of the same name, with result caching added.

## Features

- Adds an **OpenCode Go** section to the Settings sidebar (`settings.section` contribution), always available
- Adds a **usage bolt button** to the composer tool row (`conversation.input.right`): when the active model is `opencode-go`, a lightning-bolt icon appears next to the model selector; hovering shows the three windows' percentages, clicking opens a standalone modal (fresh data on open, bypassing the cache)
- The modal is a **swipeable carousel** (Linear-inspired redesign via Open Design): card 0 = usage overview (large monospaced monthly figure + 5h/week rows + animated bars), card 1 = model & cap table (sticky header / hover rows / monospaced accent caps)
- Model list **and caps follow the official data live** (Host fetches the API + the repo's `models.json`, 1h cache, strict validation, falls back to a bundled snapshot on failure): API order, only models with a published cap are shown, official changes reach users **without reinstalling**; `scripts/sync-models.js` syncs the data in one command
- All visuals map to DSH theme variables (--dsw-alias-*), adapting to dark/light themes and fully compatible with appearance plugins (e.g. dsh-ui-appearance custom palettes) — no colors are hardcoded
- Host-side Typert Remote `opencodeUsage/usage`: resolves the API key and calls the official usage endpoint; supports a `force` parameter to bypass the cache
- Client usage page: percentage, progress bar, reference limit and reset time per window
- Result caching: reopening the page within 60s does not hit the endpoint again
- Precondition checks: friendly guidance (not errors) when `opencode-go` is missing from Settings → Models, or no API key is found
- API key resolution: DSH credentials seam (`OPENCODE_GO_API_KEY`) first, falling back to OpenCode's `auth.json`

- Adds an **OpenCode Go** section to the Settings sidebar (`settings.section` contribution)
- Host-side Typert Remote `opencodeUsage/usage`: resolves the API key and calls the official usage endpoint
- Client usage page: percentage, progress bar, reference limit and reset time per window
- Result caching: reopening the page within 60s does not hit the endpoint again
- Precondition checks: friendly guidance (not errors) when `opencode-go` is missing from Settings → Models, or no API key is found
- API key resolution: DSH credentials seam (`OPENCODE_GO_API_KEY`) first, falling back to OpenCode's `auth.json`

## Install

```sh
dsh plugin --profile web add github:Hjay1101/dsh-opencode-go-usage
```

The package ships a bundle patch (`dsh.bundle`); `dsh plugin add` registers the Host gateway
automatically — **no manual `cordis.patch.yml` edits required**.

> ⚠️ **Upgrading from pre-0.4.6?** Old installs used a manual insert in
> `~/.dsh/profiles/web/cordis.patch.yml`. Remove that block before upgrading — it duplicates the
> bundle patch and boot fails with `duplicate loader entry id: opencode-go-usage`:
> ```yaml
> - insert:
>     - id: opencode-go-usage
>       name: 'dsh-opencode-go-usage'
> ```

Restart `dsh web` for the host half and the client bundle to take effect. The plugin depends on the standard web composition (the `api-gateway` client Remote and the `settings.section` slot), both present in the default `dsh web` profile.

## Configuration

Host-side options go on the plugin line in `cordis.yml`:

```yaml
- id: opencode-go-usage
  name: dsh-opencode-go-usage
  config:
    baseUrl: https://opencode.ai/zen/go/v1/usage   # default
    timeoutMs: 15000                                # default
    cacheTtlMs: 60000                               # default
```

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://opencode.ai/zen/go/v1/usage` | Usage endpoint URL. |
| `timeoutMs` | `15000` | Per-request timeout (ms). |
| `cacheTtlMs` | `60000` | Result cache TTL (ms); `0` disables caching. |

## Usage endpoint

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <API_KEY>
```

`<API_KEY>` is an Anthropic-compatible OpenCode Go key (`sk-opencode-…`). The endpoint returns:

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 9,  "resetsAt": "2026-08-14T07:20:04.810Z" },
    "weekly":  { "status": "ok", "percent": 12, "resetsAt": "2026-08-17T00:00:00.810Z" },
    "monthly": { "status": "ok", "percent": 6,  "resetsAt": "2026-09-09T00:41:03.810Z" }
  }
}
```

`percent` is 0–100, `resetsAt` is ISO-8601. This endpoint is not yet part of OpenCode's public documentation.

## API key resolution order

1. DSH credentials seam / env `OPENCODE_GO_API_KEY` (`$DSH_HOME/.credentials.yaml`)
2. OpenCode `~/.local/share/opencode/auth.json` → `opencode-go` (fallback `opencode`) entry with `type: "api"`

## Platform support

**macOS, Linux, Windows all supported.** The plugin is pure ESM — no native binaries, no build step; both halves are platform-independent.

| Platform | API key resolution |
| --- | --- |
| macOS / Linux | ✅ `~/.local/share/opencode/auth.json` is exactly where the OpenCode CLI stores credentials by default |
| Windows | Prefer `OPENCODE_GO_API_KEY` (credentials seam or env); an `auth.json` at the same relative path is read if present |

Prerequisites on any platform: Node.js + [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), `opencode-go` configured under Settings → Models, and an OpenCode Go API key.

## How it works

A dual-face (Host + Client) plugin. The Host publishes the `opencodeUsage` Typert Remote service; the Client mounts it, registers `settings.section` and renders the page; the two halves communicate over the harness `/api` RPC carrier. The API key stays inside the Host process and never reaches the browser.

| File | Role |
| --- | --- |
| `index.js` | Host half — `OpencodeGoUsageGateway` (`TypertRemoteService`, service key `opencodeUsage`), with TTL cache |
| `typert.host.js` | Hand-written Typert host manifest, registered via `exports["./typert"]` |
| `client.js` | Browser bundle (`window.__ModuleLoader__.load` format) — mounts the Remote, registers the section, renders the page |
| `package.json` | Dual-face declaration: `main` + `exports["./client"]` + `exports["./typert"]` + `dsh.client` |

## Development

Pure ESM, no build step. Host files import `@deepseek-ai/*` peer dependencies; the client bundle is hand-written in the lazy-CJS format the harness client loader serves under `/plugins`. Local iteration: edit code → reinstall/relink via `dsh plugin --profile web` → restart `dsh web`.

## Known limitations

- The usage endpoint is undocumented and may change; parsing is defensive and non-200 responses show a friendly status instead of crashing.
- The limits ($12 / $30 / $60) are display-only references — they are not returned by the endpoint and may drift from your actual OpenCode Go plan.


## 💡 Known gotcha / updating DSH

This plugin is **dual-face**: `dsh.client` (browser) + `dsh.bundle.patch` (Host gateway cordis
patch that registers the `opencodeUsage` service). It therefore **belongs** in
`dsh.profile.bundles` — `dsh plugin add`'s reconcile adds it automatically, no manual edits.

> Warning: a **pure client plugin with no `dsh.bundle.patch`** that ends up in
> `dsh.profile.bundles` makes boot fail with `declares no dsh.bundle in its package.json` in
> `dsh-app-boot`. Full gotcha notes live in the sibling `DSH_PLUGIN_DEV_NOTES.md`.

## License

MIT
