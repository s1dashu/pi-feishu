# 手动创建飞书助理

如果你不使用 onboard 里的扫码创建流程，也可以在飞书开放平台手动创建自建应用，再把 App ID / App Secret 填到 `pi-feishu onboard` 里。

## 创建应用

1. 打开开放平台：
   - 国内飞书：[open.feishu.cn](https://open.feishu.cn/app)
   - 国际版 Lark：[open.larksuite.com](https://open.larksuite.com/app)
2. 创建企业自建应用。
3. 在应用的凭证页面复制 `App ID` 和 `App Secret`。
4. 启用机器人能力。
5. 在权限管理里开通即时消息相关权限，例如接收消息、发送消息、读取机器人所在会话消息等。
6. 在事件订阅里选择长连接 / WebSocket。
7. 添加事件 `im.message.receive_v1`。
8. 按飞书后台要求创建版本并发布，使配置在租户内生效。

## 写入 pi-feishu 配置

运行：

```bash
npx @s1dashu/pi-feishu onboard
```

在飞书应用设置步骤选择：

```text
Configure an existing Feishu assistant
```

然后填写 App ID、App Secret，并选择应用区域：

- 国内飞书应用选择 `Feishu (China)`
- 国际版 Lark 应用选择 `Lark (international)`

区域必须和应用实际创建的平台一致，否则启动时可能无法获取 token。

## 常见检查项

如果启动后收不到消息，优先检查：

1. 应用是否已发布。
2. 机器人能力是否启用。
3. 事件订阅是否选择了长连接。
4. 是否已订阅 `im.message.receive_v1`。
5. 机器人是否已加入会话；群聊里通常需要 @ 机器人。
6. App ID / App Secret 是否和当前 `~/.pi-feishu/config.json` 里的配置一致。
