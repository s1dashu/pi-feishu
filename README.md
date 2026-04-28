# pi-feishu

[npm](https://www.npmjs.com/package/@s1dashu/pi-feishu)
[License: MIT](./LICENSE)
[Node](https://nodejs.org/)

**Languages:** [English](#english) · [中文](#中文)

---

## English

Connect **[pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)** to **Feishu / Lark**: WebSocket events, direct and group chats, session persistence. This repo is a **community project**, not affiliated with Feishu.

### Table of contents

- [Who is this for?](#who-is-this-for)
- [What you need](#what-you-need)
- [Feishu / Lark app setup](#feishu--lark-app-setup)
- [First-time setup](#first-time-setup)
- [Daily use](#daily-use)
- [npx vs global install](#npx-vs-global-install)
- [Where data lives](#where-data-lives)
- [More verbose logs](#more-verbose-logs)
- [FAQ](#faq)
- [Developing from source](#developing-from-source)
- [License](#en-license)

### Who is this for?

**Pi Agent users who want to run Pi Coding Agent inside Feishu / Lark** (as a bot).

**This package provides:** event and message handling, a session pool integrated with pi-coding-agent, and an interactive onboarding wizard.

### What you need

**Node.js 20+** with **npm**, and a **Feishu / Lark custom app** configured below (**App ID**, **App Secret**, long-connection events, IM scopes).

### Feishu / Lark app setup

This bot talks to **open.feishu.cn** (Feishu, China) or **open.larksuite.com** (Lark, international). Your wizard choice of **App region** must match where the app was created.

1. **Open the developer console**
  - Feishu (China): [open.feishu.cn → 开发者后台](https://open.feishu.cn/app)  
  - Lark (international): [open.larksuite.com](https://open.larksuite.com/app)
2. **Create a custom / self-built app** (企业自建应用) for your tenant.
3. **Get credentials**
  In the app’s **Credentials / 凭证** page, copy **App ID** and **App Secret**.  
   The secret is often shown only once when created; if lost, **reset** it in the console and update your local config.
4. **Turn on the Bot**
  Enable the **Bot** capability and complete any steps required so the app can appear as a bot in chats.
5. **Scopes / permissions**
  Add the IM permissions your bot needs (receive/send messages, groups, etc.). Exact scope names change over time—use the console’s permission list and Feishu docs for **instant messaging**.
6. **Event subscription — use long connection (required)**
  In **Events → Subscription mode**, choose **Long connection / WebSocket (长连接)**.  
   This project maintains an outbound WebSocket to Feishu;  
   Under **Added events**, click **Add event** and subscribe to `**im.message.receive_v1`** (the console may label it **Receive message v2.0 / 接收消息 v2.0**). Grant the IM scopes it lists (e.g. read user→bot DMs and group messages where the bot is @-mentioned).  
   Without this event, the process may log `event-dispatch is ready` but **never receive chats**.
7. **Publish / release**
  If the console shows a draft vs published version, **publish** the app so settings apply to your tenant.

**Model API keys (e.g. Kimi):** the wizard asks for keys such as `KIMI_API_KEY` when you pick a provider like `kimi-coding`. If that step is skipped, you may already have the variable in your shell or saved config—the wizard will say so and offer to replace it.

### First-time setup

Two steps: **configure → run the bot** (keep the terminal open).

**Step 1 — run the wizard**

```bash
npx @s1dashu/pi-feishu onboard
```

Equivalent:

```bash
npx @s1dashu/pi-feishu --onboard
```

Answer the prompts (App ID, App Secret, model provider keys, etc.). Masked input may not echo—normal.

**Step 2 — start the bot**

```bash
npx @s1dashu/pi-feishu
```

- **Leave this terminal running.** Closing it stops the process; Feishu won’t get replies. For production hosting, use your own process manager (`systemd`, Docker, etc.).
- If you kept the **default** data directory, you **don’t** need any env vars.

### Daily use

- Already configured, default dir `~/.pi-feishu`:
  ```bash
  npx @s1dashu/pi-feishu
  ```
- Re-run setup (new model / keys):
  ```bash
  npx @s1dashu/pi-feishu onboard
  ```

### `npx` vs global install

Pick one.

**A — `npx` (good for occasional use)**

- Pros: no global clutter; always uses the standard install path.  
- Cons: longer command line.

**B — global (good for daily use)**

```bash
npm install -g @s1dashu/pi-feishu
```

Then:

```bash
pi-feishu onboard
pi-feishu
```

Upgrade later with the same `npm install -g` command.

### Where data lives

- **Default:** `~/.pi-feishu` → `config.json`, `.env`, and session data managed by the app.

**Single source for bot settings:** Feishu **App ID**, **App Secret**, **region (brand)**, **model**, **tools**, etc. are read **only** from the `**profile`** object in `config.json`. Provider API keys belong in the same file’s `**env`** object (onboard writes them there); those keys are applied to `process.env` and override the shell / `.env` for the same name.

- If the wizard used **another directory**, point the same path on every start:
  ```bash
  npx @s1dashu/pi-feishu --home /path/you/chose
  ```
  or, for the current shell session:
  ```bash
  export PI_FEISHU_HOME=/path/you/chose
  npx @s1dashu/pi-feishu
  ```

Never commit secrets. Your data dir is usually outside this git repo.

### More verbose logs

```bash
PI_FEISHU_RUN_MODE=dev npx @s1dashu/pi-feishu
```

If globally installed:

```bash
PI_FEISHU_RUN_MODE=dev pi-feishu
```

### FAQ

**Slow `npx` or install prompts?** First fetch can be slow; approve when asked. Corporate networks may need an npm mirror or proxy.

`**node` / `npm` not found?** Install Node 20+, restart the terminal, try again.

`**pi-feishu: command not found` after global install?** Your global npm `bin` may be missing from `PATH`. Keep using `npx @s1dashu/pi-feishu`, or add `$(npm bin -g)` to `PATH` (OS-specific).

`**failed to obtain token`, `Lark probe failed`, or HTTP 400 on `bot/v3/info`?** The Feishu client could not get a **tenant access token**. Check **App ID** and **App Secret** (no extra spaces; reset secret if unsure), **Feishu vs Lark region** matches the app, **Bot** is enabled, and the app is **published** as required. Corporate networks must allow HTTPS to the open platform.

`**event-dispatch is ready` but no incoming messages?** In the app console, confirm `**im.message.receive_v1`** is listed under subscribed events, **long connection** is selected, required IM scopes show as enabled, the app is **published**, the bot is in the chat (DM or group), and in groups the user **@-mentions** the bot if your tenant requires it. Check that `**PI_FEISHU_HOME`** / `--home` is the directory that holds the **same** App ID as in the console (use ASCII `~` in paths; a fullwidth `～` can create a wrong folder—re-run `onboard` if you see `～` in printed paths).

**Bot silent?** Confirm the process is running, Feishu app permissions and **long-connection** event subscription (including `**im.message.receive_v1`**) are correct, and model APIs are reachable. Use `PI_FEISHU_RUN_MODE=dev` for logs.

**Windows?** Use PowerShell or WSL; adjust paths. In PowerShell, e.g. `$env:PI_FEISHU_HOME="C:\path"`.

### Developing from source

From the repo root:

```bash
npm install
npm run start:onboard
npm run start
npm run dev
npm test
npm run build
```

Smoke-test build: `node dist/cli.js`, `node dist/cli.js --onboard`.  
Release: bump `version`, then `npm publish` (runs check + build).

### License

[MIT](./LICENSE)

---

## 中文

将 **[pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)** 接入**飞书 / 国际版 Lark**：长连接事件、单聊与群聊、会话持久化。本仓库为**第三方社区项目**，非飞书官方维护。

### 目录

- [适合谁、能做什么](#zh-who)
- [开始前你要有什么](#zh-prereq)
- [飞书 / Lark 应用配置](#zh-feishu-app)
- [第一次使用（必看）](#zh-first)
- [日常使用](#zh-daily)
- [选 `npx` 还是全局安装？](#zh-npx)
- [配置存在哪、怎么换目录？](#zh-data)
- [想多看日志时](#zh-logs)
- [常见问题](#zh-faq)
- [从源码开发（维护者）](#zh-dev)
- [许可证](#zh-license)

### 适合谁、能做什么

**适合：Pi Agent 的忠实用户，希望在飞书 / Lark 里使用 Pi Coding Agent（机器人形态）。**

**本包提供：** 事件与消息处理、与 pi-coding-agent 的会话池、交互式配置向导。

### 开始前你要有什么

**Node.js 20+**（有 npm 即可）和下一节里配好的 **飞书 / Lark 自建应用**（**App ID / App Secret**、长连接事件订阅及所需 IM 权限）。

### 飞书 / Lark 应用配置

本程序访问 **open.feishu.cn**（国内飞书）或 **open.larksuite.com**（国际版 Lark）。向导里的 **App region** 必须与应用实际所在区域一致。

1. **打开开发者后台**
  - 国内飞书：[open.feishu.cn → 开发者后台](https://open.feishu.cn/app)  
  - 国际 Lark：[open.larksuite.com](https://open.larksuite.com/app)
2. **创建企业自建应用**（非商店应用）。
3. **获取凭证**
  在应用 **凭证与基础信息** 中查看 **App ID**、**App Secret**。  
   App Secret 常在首次创建时只显示一次；遗失请在后台**重置**，并同步更新本机 `config.json` / 向导。
4. **启用机器人**
  在能力里打开 **机器人（Bot）**，按提示完成配置，使应用能以机器人身份进会话。
5. **权限 / 权限范围**
  按控制台与[开放平台文档](https://open.feishu.cn/document)申请即时消息相关权限（收消息、发消息、群聊等，以当前文档为准）。
6. **事件订阅 — 必须使用长连接（重要）**
  在 **事件与回调 → 订阅方式** 中选择 **使用长连接接收事件**（WebSocket）。  
   本客户端通过**长连接**收事件；  
   在 **已添加事件** 中点击 **添加事件**，搜索并订阅 `**im.message.receive_v1`**（控制台可能显示为 接收消息 v2.0）。按提示开通所需即时消息权限（例如读取用户发给机器人的单聊、群聊中 @ 机器人的消息等）。**  
   **若未添加该事件，终端可能出现 `**event-dispatch is ready`** 但**始终收不到会话消息**。
7. **版本发布**
  若后台有「创建版本 / 申请发布」，需**发布**后租户内配置才生效（以你司后台实际流程为准）。

**大模型 API Key（如 Kimi）：** 在向导中选择 `kimi-coding` 等提供商时，会提示填写 `KIMI_API_KEY`（或对应环境变量名）。若未出现输入框，多半是 **当前 shell 或已保存配置里已有该变量**——向导会提示是否**替换**；也可先 `unset KIMI_API_KEY` 再跑一遍向导。Kimi 密钥一般在 [Moonshot 开放平台](https://platform.moonshot.cn/) 申请。

### 第一次使用（必看）

**第 1 步：向导**

```bash
npx @s1dashu/pi-feishu onboard
```

等价于：

```bash
npx @s1dashu/pi-feishu --onboard
```

按提示填写；密钥类输入可能不回显，属正常。

**第 2 步：启动机器人（终端保持打开）**

```bash
npx @s1dashu/pi-feishu
```

关掉终端即停止进程；长期使用请自行用 `tmux`、`systemd` 等托管。若未改默认数据目录，**无需**设置环境变量。

### 日常使用

```bash
npx @s1dashu/pi-feishu
```

重配：

```bash
npx @s1dashu/pi-feishu onboard
```

### 选 `npx` 还是全局安装？

**方式 A：`npx`**（偶尔使用）— 不污染全局，命令略长。  
**方式 B：全局**（常用）

```bash
npm install -g @s1dashu/pi-feishu
pi-feishu onboard
pi-feishu
```

### 配置存在哪、怎么换目录？

- 默认 **~/.pi-feishu**：`config.json`、`.env` 及会话数据。

**单一数据源：** 飞书 **App ID / Secret**、**区域（brand）**、**模型**、**工具预设** 等只从 `config.json` 的 `**profile`** 读取。大模型等 API Key 写在同文件的 `**env`**（向导会写入）；这些键会进入 `process.env` 并覆盖 shell / `.env` 中的同名变量。

- 若向导选了其他路径，每次启动需指向**同一路径**：
  ```bash
  npx @s1dashu/pi-feishu --home /你/选的路径
  ```
  或：
  ```bash
  export PI_FEISHU_HOME=/你/选的路径
  npx @s1dashu/pi-feishu
  ```

勿将含密钥的目录提交到 Git。

### 想多看日志时

```bash
PI_FEISHU_RUN_MODE=dev npx @s1dashu/pi-feishu
```

全局安装时：

```bash
PI_FEISHU_RUN_MODE=dev pi-feishu
```

### 常见问题

`**npx` 慢或反复询问安装？** 首次拉包较慢；企业网络可能需要镜像或代理。  
**没有 `node` / `npm`？** 安装 Node 20+ 后**重开终端**。  
**全局安装后 `pi-feishu` 找不到？** 检查全局 `npm bin` 是否在 `PATH`，或继续用 `npx @s1dashu/pi-feishu`。  
`**failed to obtain token`、`Lark probe failed` 或 `bot/v3/info` 返回 400？** 说明未能正确换取 **tenant_access_token**。请核对 **App ID / App Secret**（无多余空格；不确定可重置 Secret）、**飞书与 Lark 区域**是否选对、是否已启用**机器人**并完成**版本发布**；本机网络需能访问开放平台 HTTPS。  
**已显示 `event-dispatch is ready` 但收不到消息？** 在开放平台确认已订阅 `**im.message.receive_v1`**、订阅方式为**长连接**、相关 IM 权限为**已开通**、应用已**发布**；会话里已添加该机器人，群聊一般需要 **@机器人**。确认 `**PI_FEISHU_HOME` / `--home`** 下的 `config.json` 与后台是**同一套** App ID；路径请用 **ASCII 的 `~`**，不要用输入法里的全角 `**～**`（否则会落到错误目录，可重新跑 `onboard` 指定目录）。

**机器人不回复？** 确认进程在跑、权限与**长连接**及 `**im.message.receive_v1`** 事件订阅正确、模型 API 可达；可开 `PI_FEISHU_RUN_MODE=dev`。  
**Windows？** 可用 PowerShell 或 WSL；环境变量写法如 `$env:PI_FEISHU_HOME="..."`。

### 从源码开发（维护者）

```bash
npm install
npm run start:onboard
npm run start
npm run dev
npm test
npm run build
```

验证：`node dist/cli.js`、`node dist/cli.js --onboard`。发版：改 `version` 后 `npm publish`。

### 许可证

[MIT](./LICENSE)