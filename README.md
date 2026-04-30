# pi-feishu

`pi-feishu` 是最快速在飞书里使用 [Pi Coding Agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) 的方案。

它把 Pi Coding Agent 接到飞书 / Lark 机器人上，处理飞书消息、长连接事件、单聊 / 群聊会话和本地会话持久化。你只需要 Node.js 20+，按向导扫码创建飞书助理，然后启动进程，就可以在飞书里和 Pi Coding Agent 对话。

本项目是第三方社区项目，不是飞书官方项目。

## 如何快速创建飞书助理

运行 onboard 向导：

```bash
npx @s1dashu/pi-feishu onboard
```

也可以写成：

```bash
npx @s1dashu/pi-feishu --onboard
```

向导里选择 `Create a new Feishu assistant`，终端会显示飞书 / Lark 授权二维码和链接。用飞书或 Lark 扫码授权后，向导会自动创建助理应用，并写入本地配置。

之后按提示选择模型 Provider、模型 ID、Thinking Level，并填写对应模型的 API Key。默认配置目录是：

```text
~/.pi-feishu
```

配置会写入这个目录下的 `config.json`，会话数据也会保存在这里。不要把这个目录提交到 Git。

如果你已经有飞书自建应用，也可以在向导里选择 `Configure an existing Feishu assistant` 手动填写 App ID / App Secret。手动创建应用的详细步骤见：[手动创建飞书助理](./docs/manual-feishu-app.md)。

## 如何启动飞书助理

配置完成后启动：

```bash
npx @s1dashu/pi-feishu
```

保持这个终端运行。终端关闭后，飞书助理进程也会停止。

如果你想全局安装：

```bash
npm install -g @s1dashu/pi-feishu
pi-feishu onboard
pi-feishu
```

如果 onboard 时使用了自定义目录，启动时也要指向同一个目录：

```bash
npx @s1dashu/pi-feishu --home /path/to/your/pi-feishu-home
```

需要更多日志时：

```bash
PI_FEISHU_RUN_MODE=dev npx @s1dashu/pi-feishu
```
