<div align="center">

# AI 网页翻译 · 浏览器插件

**用你自己配置的大模型，直接翻译网页——不经过任何中间服务端。**

中文 · [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/)
[![antd](https://img.shields.io/badge/antd-6-1677FF.svg)](https://ant.design/)

</div>

---

## 这是什么

一个 Chrome / Edge 扩展，把网页上的中文**整页翻译成你指定的语言**。翻译请求由浏览器后台**直接发给你自己配置的模型**
（任何 OpenAI 兼容的 `/chat/completions`，如 OpenAI、DeepSeek、智谱、Kimi、通义、本地 Ollama），
没有中转服务器，也不依赖任何厂商的账号或额度。

和常见"划词翻译"不同，它面向的是**页面级、结构性翻译**：

- 扫描整页文案，按**可视区**分批请求，滚动/切页时增量补扫
- 保留 DOM 结构：`<img>`、图标、`￥`、行内 `<span>` 等非文案节点不会被破坏
- 切回中文时**精确回滚**成原文，不会张冠李戴、也不会把英文卡在页面上

> 界面示意（欢迎 PR 补充真实截图到 `docs/screenshot.png`）

```
┌────────────────────────────────┐
│ 译  AI 网页翻译         [ ●]   │   ← 一键开关（关 = 回滚中文）
│     英语                       │
├────────────────────────────────┤
│ 目标语言   [ 英语 English   ▾] │
│ 使用模型   [ DeepSeek       ▾] │
│ deepseek-chat · api.deep…/v1   │
├────────────────────────────────┤
│ [ ⚡ 翻译此页 ] [ ↻ 恢复中文 ]  │
├────────────────────────────────┤
│ 打开页面自动翻译         [ ●]  │
│ 控制台调试日志           [ ○]  │
├────────────────────────────────┤
│ ⚙ 模型与设置      ✓ 已翻译 42 项│
└────────────────────────────────┘
```

## 特性

- **模型直连**：API Key 只存在本机 `chrome.storage.local`，仅扩展的 service worker 读取使用，页面脚本拿不到
- **任意 OpenAI 兼容服务**：内置 DeepSeek / OpenAI / 智谱 GLM / Moonshot / 通义 / 本地 Ollama 预设，也可完全自定义
- **整页 + 按需翻译**：首屏全量扫描，可视区优先请求；滚动、`resize`、`visualViewport` 变化都会补扫
- **保留结构**：复合块按段回写（`<span>营业时间</span>&nbsp;9:00-16:30` 只替换中文那一段，时间不动）
- **精确回滚**：每个节点记住"写入前的原文"，切回中文时逐节点还原；标签页/列表复用同一 DOM 也能各归各位
- **高频切换稳定**：中英来回切不会把条目"拉黑"、不会重复请求，被中断的请求不计入失败重试
- **请求去重与容错**：同批次同文案只发一条；单条请求缺少 `[index]` 前缀会自动补齐；流式分片边界不会粘连
- **可视化配置**：popup 里开关 / 切语言 / 切模型 / 看进度，设置页里增删改模型并一键测试连通性
- **无遥测**：不采集任何数据，没有自建上报

## 快速开始

### 从源码构建（当前唯一方式）

```bash
git clone <this-repo>
cd ai-translate
pnpm install
pnpm build          # 产出 dist/
```

然后在浏览器中：

```
chrome://extensions  →  打开「开发者模式」  →  「加载已解压的扩展程序」  →  选择 dist 目录
```

> ⚠️ 加载的是 **`dist/`**，不是仓库根目录（根目录是 TS/React 源码）。

### 首次配置

1. 点扩展图标 → 「**模型与设置**」
2. 新增/编辑一个模型：填 `Base URL`、`模型名`、`API Key`
3. 点「**测试连通性**」，看到模型回复即配置成功
4. 保存 → 回到 popup 打开开关（或选一个目标语言，会自动打开）

## 模型配置

任何兼容 `POST {baseUrl}/chat/completions` 且支持 `stream: true` 的服务都能用：

| 服务 | Base URL | 模型名示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |
| 自建网关 | 你自己的地址 | 你的模型名 |

字段说明：

- **Base URL**：填到 `/v1` 为止（脚本会自动拼 `/chat/completions`；没写协议会补 `https://`）
- **temperature**：默认 `0.2`，翻译任务建议保持低温
- **系统提示词**：留空使用内置的逐行 `[index]译文` 协议；自定义时必须保持该格式，否则引擎无法回显

## 工作原理

```
页面 ── content.js ──┬── 翻译引擎（扫描 / 回显 / 回滚）
                     │        │ 一批 [index]原文
                     │        ▼
                     └── 长连接端口 ── background service worker ── 你的模型（流式）
                                                │
                                         纯文本增量回传
```

1. `content.js` 读配置 → 引擎决定"翻译"或"回滚中文"
2. 引擎把文案按 `[index]原文` 逐行拼成一批，交给传输层
3. 后台用配置的模型发起**流式**请求，增量原样回传
4. 引擎复用自身流式解析写回 DOM（复合块按段对齐，媒体节点保持不动）
5. 关闭开关 / 切回中文 → 按"节点身份"逐节点精确还原

模型侧协议（系统提示词已约束）：

```
输入  [0] 你好
      [1] 营业时间
输出  [0] Hello
      [1] Business hours
```

## 项目结构

```
public/
  manifest.json                 # MV3 清单（构建时原样拷进 dist）
  icons/                        # 16/48/128 图标
src/
  background/index.ts           # service worker：模型请求 + 流式回传（API Key 只在这里用）
  content/index.ts              # 内容脚本：读配置、接传输层、响应 popup
  engine/ai-translate-engine.js # 翻译引擎（生成物，勿手改）
  lib/config.ts                 # 配置模型：默认值/校验/语言/模型预设
  lib/storage.ts                # chrome.storage 薄封装（便于测试替换）
  lib/model-client.ts           # OpenAI 兼容客户端（SSE 流式、连通性测试）
  lib/types.ts                  # 共享类型（引擎 API、端口消息协议）
  popup/                        # React + antd 工具栏面板
  options/                      # React + antd 设置页
scripts/build.mjs               # 三个构建目标 / watch
tests/                          # vitest 单测
tools/                          # 引擎生成、图标生成、端到端冒烟测试
```

## 开发

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 构建 pages / background / content 到 `dist/` |
| `pnpm watch` | 三个目标 watch 重建（改完在扩展页点「重新加载」+ 刷新页面） |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest 单测 |
| `pnpm test:smoke` | jsdom 端到端（跑 `dist/content.js`） |
| `pnpm verify` | typecheck → test → build → smoke 一条龙 |
| `pnpm icons` | 重新生成图标 |

### 为什么有三个构建目标

MV3 三类入口的要求不同，`vite.config.ts` 用 `--mode` 区分：

| 目标 | 产物 | 格式 | 原因 |
| --- | --- | --- | --- |
| `pages` | `dist/popup/index.html`、`dist/options/index.html` | ESM | 扩展页面支持 module script |
| `background` | `dist/background.js` | ESM | manifest 里 `"type": "module"` |
| `content` | `dist/content.js` | **IIFE 单文件** | 内容脚本不支持 ESM |

### 关于翻译引擎

`src/engine/ai-translate-engine.js` 是**生成物**：由 `tools/build-engine.mjs` 对一份自研页面翻译引擎
（原生 JS，含大量真实站点打磨出来的 DOM 处理）做**定点改写**——剥离站点耦合、把请求换成插件传输层，
DOM 扫描 / 复合块 / 缓存 / 回显 / 回滚逻辑原样保留。

- 生成物已提交进仓库，**日常开发无需重新生成**
- 需要同步上游修复时：`node tools/build-engine.mjs <上游文件路径>`（或设 `UPSTREAM_ENGINE`）
- 脚本对每处改写都有锚点断言：上游结构变化会明确报错，而不是静默生成坏文件

### 测试

```bash
pnpm verify
```

- `tests/`：配置收敛与校验、模型客户端（SSE 解析、流式拼装、HTTP 错误、abort、非流式兜底）共 24 项
- `tools/smoke-test.mjs`：把构建产物放进 jsdom，验证「关闭保持中文 → 打开后普通文案 / 复合块（保留 `<img>`）/
  片段型复合块正确翻译 → 关闭后逐项回滚中文」共 8 项

## 隐私与安全

- **API Key**：存于 `chrome.storage.local`（**未加密**，与多数翻译类扩展一致），仅 service worker 读取；
  不使用 `storage.sync`，因此不会同步到浏览器账号
- **网络**：只有你配置的模型服务商收到页面文案；没有其他出网请求，无遥测、无统计
- **最小权限**：`storage` / `activeTab` / `scripting` / `tabs` + 页面与网关所需的 host 权限。
  若只用一个服务商，建议把 `host_permissions` 收窄成该域名，例如 `https://api.deepseek.com/*`
- **代码可审计**：全部源码在本仓库，构建产物可复现（`pnpm build`）

## 已知限制

- 只做「中文 → 目标语言」（只采集含中日韩统一表意文字的文本）
- 没有内容脚本 HMR：改内容脚本需 `pnpm watch` + 扩展页「重新加载」+ 刷新页面
  （想要 HMR 可考虑 WXT / CRXJS，代价是接管 manifest 生成并引入框架约束）
- 安装扩展前已打开的标签页需刷新一次；`chrome://` 等受限页面无法翻译
- 页面频繁重绘时依赖 MutationObserver + 防抖补扫，属于尽力而为

## Roadmap

- [ ] 划词 / 段落翻译（不改整页）
- [ ] 翻译结果本地缓存，减少重复计费
- [ ] 术语表与"不翻译"白名单的 UI 配置
- [ ] Firefox / Safari 适配
- [ ] 界面截图与演示 GIF

## 贡献

欢迎 Issue 与 PR：

1. Fork → 新建分支（`feat/xxx`、`fix/xxx`）
2. 保持 `pnpm verify` 全绿（类型检查 + 单测 + 构建 + 端到端）
3. 改动翻译引擎时请**改 `tools/build-engine.mjs` 或上游文件**，不要直接编辑 `src/engine/*.js`
4. PR 描述里说明动机、影响面，以及你验证过的场景（页面结构、切换时序等）

## 开源协议

[MIT](./LICENSE) © 2026 ai-translate contributors

MIT 是最宽松的协议之一：可自由使用、修改、分发、商用与再许可，只需保留版权与许可声明。

> **维护者发布前请注意**：`src/engine/ai-translate-engine.js` 由外部自研引擎生成。
> 以 MIT 开源本仓库前，请确认该上游引擎的版权归属与授权允许（例如属于公司资产时需先取得许可，
> 或在 README / LICENSE 中标注其独立授权）。`LICENSE` 里的版权人也可替换成你的名字或组织。
