# Wingman-X —— AI 推特 / X 回复机器人，人在回路（Human-in-the-Loop）

[English](./README.md) · **简体中文**

> **一个由 AI 驱动的 Twitter / X 回复机器人：它会基于你自己的 Obsidian 知识库
> 起草「像你说话」的回复，然后交给 _你_ 审阅、由你按下发推按钮。
> 100% 本地运行，绝不自动发帖。**

Wingman-X 是一个 **Chrome 扩展 + 本地 AI Agent** 的组合：它替你找到值得回复的
推文，用 **Obsidian** 笔记和语气指南起草一条「你的口吻」的回复，再把它交给你
确认。它兼容 **Claude Code**、**OpenAI Codex**、**Gemini CLI**，或任何
**MCP** Agent —— 不绑定任何厂商。

与其在信息流里刷个不停、每条回复都从零想起，不如让系统扫描出与你专业领域匹配
的推文，从你的知识库里起草回复，再交给你审阅。你来编辑、批准、按下发推 —— 永远
是你。

把它理解成一个 **懂你怎么思考的 AI 回复助手**，而不是一个垃圾刷屏机器人。每一条
草稿都只是建议，每一次发布都由你决定。

[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![Manifest](https://img.shields.io/badge/chrome-MV3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Tests](https://img.shields.io/badge/tests-214%20unit%20%2F%2014%20e2e-success)](#测试与覆盖率)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

- 📚 **Obsidian 驱动** —— AI 会读取你本地的知识库（`tone.md` + `library/*.md`），
  在起草任何内容之前，先理解你的专业、观点，以及你说话的方式。
- 🙋 **人在回路** —— 每条草稿都只是起点。你来编辑、批准、按下发推。
  **永不自动发帖。**
- 🤖 **Agent 无关** —— 守护进程（daemon）与扩展之间用一份纯 HTTP 契约通信，
  把 Claude Code 换成 Codex / Gemini / 你自己的脚本都无需改动任何一端。
- 🔒 **100% 本地** —— 候选推文、草稿、知识库全部存在本地磁盘。唯一的网络流量，
  是你的 Agent 调用它自己的 LLM 接口。
- 🧪 **测试完备** —— 214 个单元/集成测试（daemon 覆盖率 94.83%）+ 14 个
  Playwright 端到端用例（针对本地 fixture）。见 [测试与覆盖率](#测试与覆盖率)。

---

## 它到底是做什么的

Wingman-X 把你的 Obsidian 仓库变成一种社交互动的「超能力」。下面是一次典型会话，
从头到尾：

1. **填充你的知识库。** 把 `packages/sample-kb/` 复制到 `~/.wingman-x/kb/`，
   然后编辑 `tone.md`，写入你的语气、主题、回复习惯。在 `library/*.md` 下补充
   话题笔记 —— 这些就是 AI 在判断「回复什么」和「怎么回」时所依据的素材。
2. **运行发现（discovery）。** 你的 Agent（Claude Code、Codex 等）扫描信息流
   或一个账号列表，找到与你知识库主题匹配的推文，并用你的笔记和语气指南起草回复。
3. **AI 把这批候选推送给守护进程。** 每个候选都包含：起草好的回复、它引用了哪些
   知识库文件、以及一个匹配理由 —— 这样你能看清 AI 为什么认为这条值得你花时间。
4. **你来审阅。** 点开扩展的弹窗（popup）即可看到所有活跃候选。每张卡片展示原始
   推文、起草的回复，以及它参考了哪些知识库文件。
5. **一键填充。** 点一个候选 → 它在新标签页打开，停靠组件（Dock）出现，按下
   ✍️ → 草稿被填入 Twitter 原生输入框。需要的话再改。
6. **由你按下发推。** 扩展永远不会替你提交。人，始终是最后一步。

任何时候你都可以忽略一个候选（🗑️），或让 Agent 重新生成（♻️）。

---

## 快速开始（≈10 分钟）

> 完整步骤见 [`docs/getting-started.md`](./docs/getting-started.md)，本节是精简版。

**前置条件**

- Node.js **≥ 20** 与 npm **≥ 10**（本仓库使用 npm workspaces）。
- 一个支持 MV3 的 **Chromium 内核浏览器**（Chrome、Brave、Edge —— 2023 年底
  及之后的版本）。
- 一个带浏览器自动化 MCP 的 **MCP Agent 宿主**：
  - Claude Code · OpenAI Codex CLI · Gemini CLI · 任意 MCP 宿主
  - `chrome-devtools` MCP（首选）**或** Playwright MCP（等价）
- 一个 **已登录的 Twitter / X 账号**，登录在你将要使用的 Chrome 配置文件里。
  登录是一次性的手动步骤，不在 Agent 的职责范围内。

### 1. 克隆并安装

```bash
git clone https://github.com/stone16/wingman-x
cd wingman-x
npm install
```

`npm install` 会一次性引导所有 workspace（`daemon`、`extension`、`agent-kit`、
`sample-kb`）。

### 2. 启动守护进程

```bash
npm --workspace @wingman-x/daemon run dev
# [daemon] listening on port 53827
```

守护进程会先尝试 `53827`，端口被占用时自动向上递增直到 `53836`。让它在自己的
终端里一直运行。

从另一个终端做健康检查：

```bash
curl -s http://localhost:53827/health
# → {"status":"ok","version":"0.1.1"}
```

### 3. 构建并加载扩展

```bash
npm --workspace @wingman-x/extension run build
```

然后在 Chrome 中：

1. 打开 `chrome://extensions`。
2. 打开右上角的 **开发者模式**。
3. **加载已解压的扩展程序** → 选择 `packages/extension/dist/`。
4. 扩展的 Service Worker 状态应变为 **active（活跃）**。

重新运行 `build` **不会**自动重载已加载的扩展 —— 每次重新构建后，记得点扩展
卡片上的 ↻ 图标。

### 4. 填充你的知识库

```bash
mkdir -p ~/.wingman-x/kb
cp -R packages/sample-kb/* ~/.wingman-x/kb/
```

编辑 `~/.wingman-x/kb/tone.md`，让它贴合你真实的回复方式：你总是避免的措辞、
偏好的长度、惯用的类比、「绝不这么做」清单。这个文件写得越丰富，草稿就越不像
模板。

`packages/sample-kb/library/*.md` 展示了 Agent 在挑选回复对象时所参考的话题
笔记长什么样。

### 5. 运行发现

**前置 —— 启动 Wingman-X 专用 Chrome 配置文件。** Agent 需要一个已登录的
Chromium 来读取你的时间线。仓库内置了一个辅助脚本，会启动一个带远程调试、
长期保存 Cookie 的专用 Chrome：

```bash
npm run launch-chrome
```

它会读取 `.env` 中的 `CHROME_EXECUTABLE`、`CHROME_PROFILE_DIR`、
`CHROME_REMOTE_DEBUGGING_PORT` —— 见 [通过 `.env` 配置](#通过-env-配置)。
首次运行会要你登录一次 twitter.com，之后该配置文件会保持登录状态。如果该端口
上已有一个可调试的 Chrome，脚本会干净退出（不会重复启动）。

如果你的 `chrome-devtools` MCP 已配置 `--browserUrl http://127.0.0.1:9223`
（它会接管同一个实例），或者你更喜欢用 `--isolated` 临时浏览器并愿意每次都登录，
可以跳过此步。

然后选择你的 Agent 宿主：

**Claude Code** —— 本仓库附带了一个参考 skill：

```
/discover-twitter-candidates
```

Skill 源码：[`.claude/skills/discover-twitter-candidates/SKILL.md`](./.claude/skills/discover-twitter-candidates/SKILL.md)。

**Codex CLI / Gemini CLI / 任意其他 MCP 宿主** —— 按
[`docs/agent-workflow.md`](./docs/agent-workflow.md) 中与 Agent 无关的步骤操作。
每个宿主都通过同一份 `@wingman-x/agent-kit` TypeScript 客户端与守护进程通信。

### 6. 完成一次完整的回复循环

- 点扩展的 **浏览器操作图标** → 弹窗打开，列出活跃候选。
- 点一个候选 → 推文在标签页打开，Dock 出现在右侧边缘。
- 点 ✍️ → 草稿被填入 Twitter 输入框。
- 编辑后，由你点 Twitter 的 **发推（Tweet）** 按钮。

完成。

---

## 工作原理

三个本地组件。任何东西都不会离开 localhost —— 你 Agent 的 LLM 调用显然会去往
你为该 Agent 配置的地方，但守护进程和扩展从不「回家上报」。

```
┌────────────┐  POST /candidates    ┌────────────┐   GET /suggestion  ┌──────────────┐
│ Agent 宿主 │ ───────────────────▶ │  Daemon    │ ◀──────────────── │ Content      │
│ (Claude    │                      │            │                    │ script +     │
│  Code /    │ ◀── GET /events ──── │  Fastify   │ ── SSE ──────────▶│ Dock widget  │
│  Codex /   │   (轮询重新生成)      │  :53827    │                    │ (*/status/*) │
│  Gemini…)  │                      │            │                    └──────────────┘
└────────────┘                      │ Candidate  │                           ▲
      │                             │  pool +    │  GET /candidates   ┌──────────────┐
      │  通过 chrome-devtools /     │ state.json │ ─────────────────▶│ Popup +      │
      │  Playwright MCP             │            │ ◀── POST :id/      │ background SW│
      │  驱动 Chrome                │            │      action        │ (角标、系统  │
      ▼                             └────────────┘                    │  通知)       │
┌────────────┐                                                         └──────────────┘
│ Browser    │
│ (读取推文) │
└────────────┘
```

### 组件

| 包 | 职责 | 关键依赖 |
|---|---|---|
| [`packages/daemon`](./packages/daemon) | 运行在 `localhost:53827`（自动递增到 53836）的 Fastify HTTP 服务。持久化候选池，居中转发所有 Agent ↔ 扩展 的流量。 | Fastify 5、Zod、Node ≥ 20 |
| [`packages/extension`](./packages/extension) | Chrome MV3 扩展。后台 SW 负责端口发现 + 角标 + 由 SSE 驱动的系统通知。Content script 在推文详情页渲染 Dock。Popup 列出活跃候选。**不含任何 LLM 逻辑、不含任何 Agent 厂商代码。** | `@types/chrome`、Playwright（E2E） |
| [`packages/agent-kit`](./packages/agent-kit) | 带类型的 HTTP 客户端 + 经 Zod 校验的 `Candidate` schema，任何 MCP Agent 都能用。外加 `scripts/` —— 参考用的 CDP / 抓取 / 流程脚本。 | Zod |
| [`packages/sample-kb`](./packages/sample-kb) | 示例知识库（`tone.md` + `library/*.md`）。复制到 `~/.wingman-x/kb/` 后编辑。 | — |

### 为什么是三个组件，而不是一个？

- **换 Agent 无需重新构建：** 不同的 Agent 宿主只要指向守护进程的 localhost 端口
  即可。扩展不知道、也不关心是哪个 LLM 起草了某条候选。
- **扩展保持厂商中立：** 任何 LLM API key 都不会离开 Agent 一侧；扩展里没有任何
  机密信息。
- **守护进程拥有状态：** 候选、忽略记录、重新生成请求都存放在守护进程下的
  `state.json`。扩展只负责渲染；Agent 只负责写入。所有权清晰 = 没有同步 bug。

---

## 支持的 Agent 宿主

任何带浏览器自动化 MCP 的 MCP 宿主都能用。已测试过的参考实现：

| 宿主 | 浏览器 MCP | 状态 | 说明 |
|---|---|---|---|
| Claude Code | `chrome-devtools` MCP | 参考实现 | 仓库内附带 [`.claude/skills/discover-twitter-candidates/SKILL.md`](./.claude/skills/discover-twitter-candidates/SKILL.md)。 |
| OpenAI Codex CLI | `chrome-devtools` MCP | 已支持 | 按 [`docs/agent-workflow.md`](./docs/agent-workflow.md) 操作；无需任何厂商专属代码。 |
| Gemini CLI | `chrome-devtools` MCP | 已支持 | 与 Codex 相同，宿主间工具名一致。 |
| 其他任意 MCP 宿主 | `chrome-devtools` 或 Playwright MCP | 已支持 | 线协议就是 HTTP + `Candidate` schema。在你的脚本里直接用 `@wingman-x/agent-kit`。 |

Agent 的要求归结为：

1. 在一个已登录的 Chrome 里打开 `https://x.com/home`（或某个账号主页）。
2. 走过一段有界的信息流窗口（如 ≤ 30 条推文），提取
   `{tweet_id, tweet_url, author_handle, tweet_text}`。
3. 对每条与知识库匹配的推文，用语气指南起草一条 ≤ 280 字的回复。
4. `POST /candidates` 提交这批数据。结束。

在 MVP 阶段，Agent 不做轮询 —— 发现是一次显式的一次性调用。

---

## HTTP 契约（守护进程 API）

基础 URL：`http://localhost:<port>`，其中 `<port>` 在 `53827..53836` 范围内
自动发现（探测 `/health`）。

| 方法 | 路径 | Body / 查询 | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/health` | — | `{status:"ok", version}` | 用于端口发现。 |
| GET | `/config` | — | `{port, kb_dir}` | 告诉 Agent 知识库在哪。 |
| GET | `/candidates` | — | `{candidates: Candidate[]}` | 全部候选，不论状态。Popup 在客户端过滤。 |
| POST | `/candidates` | `{candidates: CandidateInput[]}` | `{stored: number}` | 按 `tweet_id` 合并。重新起草会更新 `suggested_reply` 而不重新通知。 |
| GET | `/suggestion?tweet_id=…` | — | `Candidate` \| 404 | Content script 用它拉取当前打开推文的草稿。 |
| POST | `/candidates/:id/action` | `{action: "filled" \| "dismissed" \| "saved" \| "regen_requested"}` | `Candidate` | 修改状态 + `status_updated_at`。 |
| GET | `/events` | — | `text/event-stream` | SSE 广播 `candidate_added` 帧。20 秒心跳注释。由后台 SW 消费。 |

`Candidate` 只在
[`packages/agent-kit/src/candidate.ts`](./packages/agent-kit/src/candidate.ts)
中声明一次，并在
[`packages/daemon/src/schemas.ts`](./packages/daemon/src/schemas.ts)
服务端再次校验。拿不准时，以那里的类型为准。

### 最小 agent-kit 示例

```ts
import { createDaemonClient } from "@wingman-x/agent-kit";

const client = createDaemonClient(53827);

// 1. 发现知识库在哪。
const { kb_dir } = await client.getConfig();

// 2. 在你完成打分 + 起草后，提交一批。
const { stored } = await client.postCandidates([
  {
    id: crypto.randomUUID(),
    tweet_id: "1790000000000000001",
    tweet_url: "https://x.com/alice/status/1790000000000000001",
    author_handle: "@alice",
    tweet_text: "the thing I thought",
    suggested_reply: "一条不超过 280 字、贴合你口吻的回复",
    match_reason: "matches KB topic 'foo'",
    match_category: "topic",
    kb_refs: ["library/topic-foo.md", "tone.md"],
  },
]);

console.log(`stored ${stored} candidate(s)`);
```

---

## 配置与状态

所有状态都是 **本地的**，默认存放在 `~/.wingman-x/` 下。

| 路径 | 用途 |
|---|---|
| `~/.wingman-x/state.json` | 候选池、上次绑定的端口、配置快照。每次变更都会重写。 |
| `~/.wingman-x/kb/tone.md` | 你的语气指南 —— 对回复质量最关键的文件。 |
| `~/.wingman-x/kb/library/*.md` | Agent 打分候选时用到的话题笔记。可自由增删。 |
| `~/.wingman-x/kb/selected-handles.txt` | 可选。按层级排序的账号列表，供按账号抓取的脚本遍历。 |

### 通过 `.env` 配置

个人配置（Chrome 路径、配置文件目录、调试端口、守护进程端口）放在仓库根目录一个
被 gitignore 的 `.env` 里，提交进仓库的
[`.env.template`](./.env.template) 作为参考。复制一次再编辑：

```bash
cp .env.template .env
```

**加载优先级**（从高到低）：

1. 真实进程环境变量 —— `CDP_URL=... npm run dev`、CI、shell 覆盖
2. `.env.local` —— 可选的二级覆盖（同样被 gitignore）
3. `.env` —— 主要个人配置
4. 代码中的硬编码默认值

加载器是 [`scripts/load-env.mjs`](./scripts/load-env.mjs)，作为
`packages/daemon/bin/dev.ts` 以及 `packages/agent-kit/scripts/` 下每个
CDP/守护进程脚本的第一个副作用导入。`dotenv.config()` 不会覆盖已设置的变量，
因此真实进程环境变量始终优先。

含空格的值（如 macOS 上的 Chrome 路径）请加引号，这样 Node 的 `dotenv` 和
bash 的 `source`（`scripts/launch-chrome.sh` 用到）都会把它解析为单个 token。

### 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `PORT` | `53827` | 守护进程首先尝试的端口；冲突时向上递增到 `53836`。 |
| `WINGMAN_X_STATE_DIR` | `~/.wingman-x` | 覆盖状态目录（用于临时 / CI / 按配置文件隔离）。 |
| `WINGMAN_X_EXT_ALLOWED_IDS` | *(未设置)* | 逗号分隔的 Chrome 扩展 ID。设置后，CORS ACAO 会被固定到这些扩展来源，其他来源的请求会被 403。**在共享 / 不可信开发机上推荐设置。** |
| `DAEMON_PORT` | `53827` | 供 `agent-kit/scripts/*` 定位运行中的守护进程。 |
| `CDP_URL` | `http://127.0.0.1:9223` | 供基于 CDP 的 Agent 脚本附着到浏览器。必须与 `CHROME_REMOTE_DEBUGGING_PORT` 一致；优先用 IPv4 回环地址，因为某些主机会把 `localhost` 解析成 `::1`，而 Chrome 只在 IPv4 上绑定调试端口。 |
| `CHROME_EXECUTABLE` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | 供 `npm run launch-chrome` 使用。Linux：`/usr/bin/google-chrome`；Windows：`C:\Program Files\Google\Chrome\Application\chrome.exe`。 |
| `CHROME_PROFILE_DIR` | `$HOME/.wingman-x/chrome-profile` | 存放 Twitter Cookie 的专用 user-data-dir。**不是**你的默认 Chrome 配置文件。 |
| `CHROME_REMOTE_DEBUGGING_PORT` | `9223` | 传给 Chrome 的 `--remote-debugging-port`。 |
| `WATCHER_DRAFT_TIMEOUT_MS` | `60000` | 单次 LLM 起草的最长时间，超时则 watcher 终止该子进程。 |
| `WATCHER_SCRAPE_TIMEOUT_MS` | `60000` | 单次抓取运行的最长时间，超时则 watcher 终止该子进程。 |
| `WATCHER_FETCH_TIMEOUT_MS` | `10000` | watcher 向守护进程发起 POST/ack 调用的最长时间，超时则记录网络超时。 |

### 扩展侧设置

| 设置 | 存储 | 默认 | 作用 |
|---|---|---|---|
| 复用已有的 Twitter 标签页 | `chrome.storage.local` | `true` | 点候选时复用：(第 1 档) 上一个助手标签页，(第 2 档) 任意已打开的 twitter.com/x.com 标签页（最近访问，Chrome 121+），(第 3 档) 新开一个。可在弹窗页脚切换。 |

---

## 仓库级脚本

```bash
npm test            # 跨 workspace 运行 vitest 并统计覆盖率
npm run typecheck   # 跨 workspace 运行 tsc --noEmit
npm run build       # 按 workspace 构建；根部会自动 bump patch 版本号
npm run build:no-bump   # 同上，但不改动版本号
npm run bump:patch  # 把根版本号传播到所有 workspace 的 package.json
npm run bump:minor  # 同上
npm run bump:major  # 同上
npm run bump:sync   # 把各 workspace 版本同步到根目录当前版本
```

版本管理是集中式的：根 `package.json` 是唯一事实来源；
`scripts/bump-version.mjs` 把版本传播到所有 workspace；构建扩展时
`copy-assets.ts` 会把该版本注入 `dist/manifest.json`。`src/manifest.json`
保持在 `0.1.0` 作为模板 —— 永远不要手动改它来升版本。

### 扩展端到端测试（Playwright）

```bash
npm --workspace @wingman-x/extension run test:e2e
```

它针对一个 **本地 fixture**（不是真实的 twitter.com）跑完整的 Dock 填充循环，
因此确定、可重复且无外部依赖。见
[`packages/extension/test/e2e/full-pipeline.spec.ts`](./packages/extension/test/e2e/full-pipeline.spec.ts)。

> ⚠️ **重要：** 端到端用例会加载 `dist/`，所以务必先 `npm run build` **再**
> `test:e2e`。陈旧的 `dist/` 是个知名陷阱。

---

## 测试与覆盖率

| Workspace | 单元 / 集成 | E2E | 覆盖率门槛 |
|---|---|---|---|
| `@wingman-x/daemon` | 65（含 5 个 SSE） | — | ≥ 85%（当前 **94.83%**） |
| `@wingman-x/agent-kit` | 58 | — | ≥ 85% 分支覆盖率 |
| `@wingman-x/extension` | 91 单元 | 14 Playwright E2E | 本地 fixture |
| **合计** | **214** | **14** | — |

测试与各包同目录（`<pkg>/test/` 或 `<pkg>/test/e2e/`）。在仓库根目录用
`npm test` 跑全套。

---

## 安全考量

- **守护进程绑定在 `127.0.0.1`，不是 `0.0.0.0`。** 它在局域网内不可达。
- **CORS** 默认对 `chrome-extension://…` 来源放行。在共享 / 不可信开发机上，
  设置 `WINGMAN_X_EXT_ALLOWED_IDS=<你的扩展ID>`，让守护进程 403 掉其他任何扩展
  的请求。
- **一个守护进程身份头**（`x-twitter-helper-daemon: 1`）为扩展请求把关 ——
  恶意页面脚本无法在不先通过 CORS 预检的情况下用 fetch 冒充扩展。
- **扩展里没有任何机密。** 所有 LLM 凭证都在 Agent 一侧。丢了一个扩展安装 ≠
  丢了一个 API key。
- **知识库内容对 Agent 而言是不可信输入** —— Agent 把它们当作提示，不当作代码。
  知识库里的任何内容都不会被守护进程或扩展 `exec`。
- 扩展只申请它实际使用的权限：`storage`、`alarms`、`notifications`，以及对
  `twitter.com`、`x.com`、`localhost` 的主机权限。见
  [`packages/extension/src/manifest.json`](./packages/extension/src/manifest.json)。

如果你发现安全问题，请通过 GitHub 的私有 advisory 提交，而不是公开 issue。

---

## 参与贡献

欢迎贡献。几条能省下审查往返的基本规则：

1. **开 PR 前先跑 `npm run build && npm test && npm run typecheck`。**
   扩展 E2E 需要一份新鲜的 `dist/`。
2. **Schema 只定义一次。** `Candidate` 在 `@wingman-x/agent-kit`；
   `ActionBody` / `SuggestionQuery` 在 `@wingman-x/daemon`。不要复制分叉 —— 复用导出。
3. **守护进程和扩展里永不调用 LLM。** 那是 Agent 的活儿。给这两端加厂商 SDK 的
   PR 会因架构原因被拒。
4. **Content script 的导入要登记进 `CONTENT_BUNDLE_ORDER`。** content script
   引用的任何新 `src/` 文件都必须登记到
   [`packages/extension/scripts/copy-assets.ts`](./packages/extension/scripts/copy-assets.ts)，
   否则打包会静默漏掉被引用的符号。
5. **行为变更先写测试。** 守护进程单元覆盖率门槛为 85%。扩展 E2E 覆盖填充
   happy path 与 regen 循环。

---

## 许可证

[MIT](./LICENSE) —— 自由 fork、折腾、发布。如果你在它之上做出了有意思的东西，
我很想听听。

---

## 项目状态

**0.1.x** —— 上述 MVP 已功能完整。已知缺口：

- 针对真实 twitter.com 的每日 smoke 测试不在范围内（发布门槛由手动 QA 脚本覆盖）。
- 暂无多账号方案（每个开发配置文件一个 `~/.wingman-x/`）。并行场景请覆盖
  `WINGMAN_X_STATE_DIR`。
- 无云同步 —— 这是有意为之。若想让另一台机器看到相同候选，复制 `state.json` 过去即可。

下一批候选特性（未排期）：多账号、带 diff 视图的更丰富 regen 体验、可选的草稿
回复存档以便自我复盘。
