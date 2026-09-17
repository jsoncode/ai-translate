<div align="center">

# AI Web Translator · Browser Extension

**Translate any web page with the LLM you configure yourself — no middleman server.**

[中文](./README.md) · English

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/)
[![antd](https://img.shields.io/badge/antd-6-1677FF.svg)](https://ant.design/)

</div>

---

## What it is

A Chrome / Edge extension that translates **whole pages** from Chinese into your target language. Requests go from the
extension's service worker **straight to the model you configure** (any OpenAI-compatible `/chat/completions`:
OpenAI, DeepSeek, Zhipu GLM, Moonshot, Qwen, local Ollama…). No proxy server, no vendor account, no quota of ours.

Unlike word-selection translators, it is built for **page-level, structure-aware translation**:

- Scans the whole page, requests in **viewport-sized batches**, re-scans incrementally on scroll / route change
- Preserves DOM structure: `<img>`, icons, `￥`, inline `<span>` and other non-text nodes are left untouched
- Switching back to Chinese **restores the original text exactly** — no mismatched text, no English left behind

```
┌────────────────────────────────┐
│ 译  AI Web Translator   [ ●]   │   ← one switch (off = restore Chinese)
│     English                    │
├────────────────────────────────┤
│ Target lang [ English      ▾]  │
│ Model       [ DeepSeek     ▾]  │
│ deepseek-chat · api.deep…/v1   │
├────────────────────────────────┤
│ [ ⚡ Translate ] [ ↻ Restore ]  │
├────────────────────────────────┤
│ Auto-translate on load    [ ●] │
│ Debug logs                [ ○] │
├────────────────────────────────┤
│ ⚙ Models & settings   ✓ 42 done│
└────────────────────────────────┘
```

## Features

- **Direct model access** — the API key lives in `chrome.storage.local` and is only read by the service worker;
  page scripts can never see it
- **Any OpenAI-compatible endpoint** — presets for DeepSeek / OpenAI / Zhipu / Moonshot / Qwen / Ollama, plus custom
- **Whole page + on demand** — full scan on load, viewport-priority requests, incremental re-scan on scroll/resize
- **Structure preserving** — composite blocks are written back segment by segment
  (`<span>营业时间</span>&nbsp;9:00-16:30` → only the Chinese part is replaced, the time stays intact)
- **Exact restore** — every node remembers the original text it replaced, so reverting is per-node exact even when
  tabs/lists reuse the same DOM with different copy
- **Stable under rapid language toggling** — aborted requests are not counted as failures, items are never
  permanently blacklisted, and duplicate requests are avoided
- **Dedup & tolerance** — identical texts in one batch are sent once; a single-item response missing the `[index]`
  prefix is auto-completed; stream chunk boundaries cannot glue entries together
- **Visual configuration** — popup for on/off, language, model and progress; options page for model CRUD and a
  built-in connectivity test
- **No telemetry** — nothing is collected, no analytics, no first-party reporting

## Quick start

```bash
git clone <this-repo>
cd ai-translate
pnpm install
pnpm build          # emits dist/
```

Then in the browser:

```
chrome://extensions  →  enable "Developer mode"  →  "Load unpacked"  →  pick the dist/ folder
```

> ⚠️ Load **`dist/`**, not the repository root (the root holds TS/React sources).

First run:

1. Click the extension icon → **Models & settings**
2. Add a model: `Base URL`, `model name`, `API key`
3. Hit **Test connection** until the model replies
4. Save, then flip the switch in the popup (choosing a target language turns it on automatically)

## Model configuration

Anything that implements `POST {baseUrl}/chat/completions` with `stream: true` works:

| Provider | Base URL | Example model |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Qwen (DashScope) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5:7b` |
| Self-hosted gateway | your own URL | your model |

Notes:

- **Base URL** stops at `/v1`; `/chat/completions` is appended (a missing scheme gets `https://`)
- **temperature** defaults to `0.2` — keep it low for translation
- **System prompt** is optional; leave it empty to use the built-in line-based `[index]译文` protocol. If you
  customize it, keep that format or the engine cannot map results back to the DOM

## How it works

```
page ── content.js ──┬── translation engine (scan / apply / restore)
                     │        │ batch of "[index]source" lines
                     │        ▼
                     └── long-lived port ── background service worker ── your model (streaming)
                                                    │
                                            plain-text deltas back
```

1. `content.js` loads the config and tells the engine to either translate or restore Chinese
2. The engine groups page text into `[index]原文` lines and hands them to the transport
3. The service worker issues a **streaming** request to your model and forwards deltas verbatim
4. The engine parses the stream and writes the DOM back (composite blocks aligned per segment, media untouched)
5. Turning the switch off / switching to Chinese restores each node to its own remembered original

Model protocol (enforced by the default system prompt):

```
input   [0] 你好
        [1] 营业时间
output  [0] Hello
        [1] Business hours
```

## Project layout

```
public/manifest.json            # MV3 manifest (copied into dist)
public/icons/                   # 16/48/128 icons
src/background/index.ts         # service worker: model calls + streaming relay (only place the key is used)
src/content/index.ts            # content script: config + transport wiring, popup messaging
src/engine/ai-translate-engine.js  # the translation engine (generated — do not edit)
src/lib/config.ts               # config defaults / validation / languages / presets
src/lib/storage.ts              # thin chrome.storage wrapper (mockable in tests)
src/lib/model-client.ts         # OpenAI-compatible client (SSE parsing, connectivity test)
src/lib/types.ts                # shared types (engine API, port message protocol)
src/popup/                      # React + antd toolbar popup
src/options/                    # React + antd settings page
scripts/build.mjs               # builds the three targets / watch mode
tests/                          # vitest unit tests
tools/                          # engine generator, icon generator, jsdom smoke test
```

## Development

| Command | What it does |
| --- | --- |
| `pnpm build` | build pages / background / content into `dist/` |
| `pnpm watch` | rebuild all three on change (reload the extension + refresh the page) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest unit tests |
| `pnpm test:smoke` | jsdom end-to-end against the built `dist/content.js` |
| `pnpm verify` | typecheck → test → build → smoke |
| `pnpm icons` | regenerate the icons |

### Why three build targets

MV3 entry points have different constraints, so `vite.config.ts` switches on `--mode`:

| Target | Output | Format | Why |
| --- | --- | --- | --- |
| `pages` | `dist/popup/index.html`, `dist/options/index.html` | ESM | extension pages support module scripts |
| `background` | `dist/background.js` | ESM | `"type": "module"` in the manifest |
| `content` | `dist/content.js` | **single-file IIFE** | content scripts cannot be ES modules |

### About the engine

`src/engine/ai-translate-engine.js` is a **generated artifact**. `tools/build-engine.mjs` rewrites a self-developed
page-translation engine (plain JS, hardened against many real-world DOMs) in a surgical way: it strips the
site-specific wiring and swaps the transport layer, while keeping the scanning / composite-block / cache /
re-apply / restore logic intact.

- The artifact is committed, so **you never need to regenerate it**
- To sync upstream fixes: `node tools/build-engine.mjs <path-to-upstream>` (or set `UPSTREAM_ENGINE`)
- Every rewrite is anchor-asserted: if the upstream structure changes, the script fails loudly instead of silently
  emitting a broken engine

### Tests

```bash
pnpm verify
```

- `tests/` — config normalization/validation and the model client (SSE parsing, streaming assembly, HTTP errors,
  abort, non-streaming fallback): 24 checks
- `tools/smoke-test.mjs` — runs the built content script in jsdom: stays Chinese when off → translates plain text,
  composite blocks (keeping `<img>`) and fragment-style composite blocks when on → restores every node to Chinese
  when off: 8 checks

## Privacy & security

- **API key** lives in `chrome.storage.local` (**not encrypted**, like most translation extensions) and is read only
  by the service worker. `storage.sync` is not used, so it never leaves your machine
- **Network** — only your configured provider receives page text; there are no other outbound requests, no telemetry
- **Least privilege** — `storage` / `activeTab` / `scripting` / `tabs` plus host permissions for pages and gateways.
  If you use a single provider, narrow `host_permissions` to that domain, e.g. `https://api.deepseek.com/*`
- **Auditable** — all source lives in this repo and the build is reproducible (`pnpm build`)

## Known limitations

- Chinese → target language only (it collects text containing CJK ideographs)
- No HMR for content scripts: use `pnpm watch`, then reload the extension and refresh the page.
  If you want HMR, consider WXT / CRXJS (they take over manifest generation and add framework constraints)
- Tabs that were already open before installing need a refresh; restricted pages (`chrome://`, …) cannot be translated
- On heavily repainting pages it relies on MutationObserver + debounced rescans — best effort

## Roadmap

- [ ] Selection / paragraph translation (without touching the whole page)
- [ ] Local translation cache to avoid paying twice for the same text
- [ ] UI for glossaries and a "do not translate" allow-list
- [ ] Firefox / Safari support
- [ ] Screenshots and a demo GIF

## Contributing

Issues and PRs are welcome:

1. Fork and branch (`feat/xxx`, `fix/xxx`)
2. Keep `pnpm verify` green (typecheck + tests + build + end-to-end)
3. When changing translation behaviour, edit `tools/build-engine.mjs` (or the upstream engine) — never
   `src/engine/*.js` directly
4. In the PR, describe the motivation, the blast radius, and the scenarios you verified (DOM shapes, switch timing…)

## License

[MIT](./LICENSE) © 2026 ai-translate contributors

MIT is one of the most permissive licenses: use, modify, distribute, sublicense and sell freely, as long as the
copyright and license notice are retained.

> **Maintainer note before publishing**: `src/engine/ai-translate-engine.js` is generated from an external,
> self-developed engine. Before releasing this repo under MIT, make sure you are allowed to license that upstream
> engine this way (e.g. get permission if it is a company asset, or document its separate license here and in
> `LICENSE`). The copyright holder in `LICENSE` can also be replaced with your name or organization.
