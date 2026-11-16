# dsh-qq-companion

把 QQ 私聊接进 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的原生 Cordis 插件。

它做的事只有一件：**QQ 上有人找你 → 唤醒 DSH 里的 agent**。说不说话、说什么，全由 agent 自己决定——插件不替它转发任何文本。

零外部依赖，约 3000 行，可脱离 DSH 单独测试。

---

## 它解决什么问题

在 QQ 上装一个"AI 助手"，常见做法是跑一堆常驻进程：协议端 + 桥接 + 转发。本项目把桥接这一层收进 DSH 插件里，**只需要两个进程**：

```
SnowLuma（QQ 协议端）  ←→  dsh-qq-companion（DSH 插件）
```

> 协议端消不掉：纯 Node 的个人号协议（icqq / oicq）都已停更，单进程只能走官方 Bot 接口（身份受限）。所以是「协议端 + DSH」的两进程方案。

---

## 功能

- **收私聊消息 → 唤醒 agent**，带缓冲期合并（连发多条只唤醒一次）
- **主动苏醒**：定时醒来，由 agent 自己决定要不要找你说话（夜里不打扰）
- **收发图片**：收到的图落盘给模型看，发图支持 base64 内联
- **收发文件**：走 OneBot `upload_private_file`
- **消息不丢**：待投递落盘，DSH 崩溃后重启能捡回来
- **聊天日志**：按会话分目录，可回查

**只做私聊**，群聊不支持（有意为之）。

---

## 安装

### 1. 前置：SnowLuma

需要 [SnowLuma](https://github.com/SnowLuma/SnowLuma) 作为 OneBot v11 协议端，开启 HTTP 与 WebSocket 服务。

> ⚠️ SnowLuma 使用「源码可见非商业许可」（Source-Available Non-Commercial），不是 OSI 开源协议。请自行确认你的使用场景符合其条款。

### 2. 装插件

把本目录作为本地 bundle 装进 DSH profile：

```bash
# 在 profile 目录（如 ~/.dsh/profiles/web）
npm install --save link:/绝对路径/dsh-qq-companion
```

或在 DSH 里用 `plugin_manager` 的 `install_bundle`，target 传本目录的绝对路径。

### 3. 配置

打开 DSH 的设置页 → **QQ 伙伴**，填写：

| 字段 | 说明 |
|---|---|
| SnowLuma 地址 | HTTP 端点，如 `http://127.0.0.1:3000` |
| Access Token | SnowLuma 配置里的 `accessToken` |
| 自己的 QQ 号 | 机器人账号 |
| 主人的 QQ 号 | 谁的消息一定要唤醒 |
| 绑定 | `private:<QQ号>` → DSH 会话 id |

保存即生效，连接地址变更会自动重连。

### 4. 用上 QQ 预设（可选但推荐）

`preset/` 里带一个「QQ 伙伴」预设：标准工具集 + 大肥鱼人格 + 行为规范。装进 profile 后，给 QQ 会话选它。

---

## 设计要点

**一切皆工具**
插件只负责：收消息、决定何时唤醒、给消息快照。回复完全交给 agent 调 `qq_send_message`。早期有个 relay 会自动转发 agent 的输出，后来删了——否则同一句话会发两遍。

**忙时怎么处理，按"谁发起"分流**

| 唤醒来源 | 会话忙时 |
|---|---|
| 消息唤醒（人说话） | **照常投递**，`agent.steer` 插到最近 step 边界，必须送达 |
| 主动苏醒（自己想说话） | **直接丢弃**，不排队、不补醒 |

人说话有信息价值，丢了等于失联；自己找话说没有紧迫性，插进对话只会干扰。

**判断"忙不忙"读 DSH 的权威状态，不猜**

```js
ctx.sessionProjections.stateOf(session, 'turnBoundary').openTurnStartSeq
// 非 null ⟺ turn 还开着，与"过了多久"无关
```

不能用"turn/start 时间 + N 分钟租约"——`session/event` 只有 turn/start 和 turn/end 两种事件，turn 中间没有任何信号，跑 40 分钟的后台任务会被误判成"已经结束"。

**「未读」≠「未投递」**
`qq_mark_read` 是模型手动调用的，水位长期落后于实际情况。拿 `unread` 当"待投递"的数据源，会让每一条新消息都把历史全部重投一遍。

**水位必须持久化**
`watermark` / `deliveredSeq` / `nextSeq` 一度全是内存状态，重启清零 → 过滤器失效 → 全量重投。现在落在 `<baseDir>/state.json`。

---

## 工具

| 工具 | 作用 |
|---|---|
| `qq_send_message` | 发消息（传数组即连发多条，多个气泡） |
| `qq_send_image` | 发图片（base64 内联，上限 3 MiB） |
| `qq_send_file` | 发文件（任意类型，走 `upload_private_file`） |
| `qq_get_unread_messages` | 看未读消息与已读水位 |
| `qq_mark_read` | 推进已读水位（**同时清理待投递文件**） |
| `qq_wait_for_messages` | 长轮询等对方说完（遵守缓冲期） |
| `qq_social_state` | 看会话状态（连接、唤醒配置、缓冲） |
| `qq_chat_log_path` | 拿聊天日志路径，回查更早的对话 |

---

## 数据落在哪

```
<会话工作区>/.dsh-qq/
├── logs/<sessionId>/chat-YYYY-MM-DD.log   # 收发流水
├── images/                                # 收到的图片
├── pending/<会话键>.json                  # 待投递消息（mark_read 后删）
└── state.json                             # 已读水位 / seq（重启续上）
```

**不放系统临时目录**（会被清理，翻记录时也找不到）。

---

## 已知问题

**改过插件源码后第一次重启，预设层可能没挂上**（表现：一大批预设工具同时消失）。再重启一次即可。

**为什么**：DSH 启动时组合 profile 存在时序竞态——`link:` bundle 的依赖图需要重建，预设组合跑在它完成之前就会被静默跳过。

---

## 目录结构

```
index.js              装配 + 设置页后端 + 忙闲监听
client.js             设置页 UI
src/
  onebot.js           HTTP 发送（文字/图片/文件）+ token 发现 + CQ 转义
  ws.js               WS 收听 + 指数退避重连 + 心跳
  buffer.js           本地 seq + 去重 + 已读水位 + 磁盘恢复
  session-map.js      会话映射（fail-closed）
  message.js          消息段解析
  runtime.js          核心：缓冲 / 投递 / 主动苏醒 / 限流 / 落盘
  deliver.js          agents.resume 兜底 + 唤醒提示拼装
  media.js            图片下载落盘
  tools.js            8 个原生工具
preset/               "QQ 伙伴" agent 预设
```
