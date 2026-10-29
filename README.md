# dsh-session-message

Cross-session messaging for DeepSeek Harness: one session can send a user-role message to another session in any workspace, and the target can reply with the same tool.

一个会话给另一个会话发消息 —— 可以跨工作区。消息到了对方那里，就是一条 user 消息；对方可以用同一个工具回你。

## 安装

任选一种：

**方式一：DSH 插件页（最简单）**

插件 → 添加插件 → 粘贴 Git 地址：

```text
https://github.com/shutongX/dsh-session-message
```

**方式二：从我的插件市场索引安装（一次添加，长期可用）**

DSH → 插件 → 实验性插件 → 更多 → 开启「自定义插件市场」→ 发现 → 添加索引源：

```text
https://shutongX.github.io/dsh-plugins-index/index.json
```

之后在「发现」里点安装即可。

**方式三：命令行**

```sh
dsh plugin --profile desktop add https://github.com/shutongX/dsh-session-message
```

装完重启 DSH（或在支持 HMR 的 profile 里等它热加载）。


> 如果你以前用开发目录装过旧的 `@dsh-external/<name>` 版本，先移除旧插件，再装这里的无 scope 包；否则同一功能会同时加载两份。

## 长什么样

```text
工作区 A                          工作区 C
┌────────────┐                    ┌────────────┐
│  会话 B    │ ── session_send ──▶ │  会话 D    │
│ (发消息)   │                    │ (收到一条  │
│            │ ◀── session_send ── │  user 消息)│
└────────────┘        回复         └────────────┘
```

对方看到的消息开头：

> Agent session-xxxx 发来一条跨会话消息（标题: "……"，工作区: "……"）。
> 这不是本会话用户发的消息。只有需要对方回答或行动时才回复，别只回"收到"。
> 回复用 session_send({ "session_id": "session-xxxx", "message": "..." })。

对方空闲会被直接唤醒；正在跑就排队。冷会话会自动恢复后再投递。

## 两个工具

### session_list

列出这台 DSH 上所有能发消息的会话（跨所有工作区）。

排除：归档会话、子代理会话、自己。保留：普通会话和 fork 出来的会话。

| 参数 | 说明 |
|---|---|
| `workspace` | 按工作区标题或路径过滤（子串） |
| `query` | 按会话标题或 id 过滤 |
| `include_blank` | 是否包含还没开始聊天的空会话，默认 `true` |
| `limit` | 最多返回多少行，1–50，默认 20 |

### session_send

| 参数 | 说明 |
|---|---|
| `session_id` | 对方的会话 id（推荐） |
| `title` | 对方的会话标题，精确匹配；不知道 id 时用 |
| `workspace` | 配合 `title` 缩小范围 |
| `message` | 消息正文（必填） |
| `delivery` | `queue`（默认）或 `steer`（插到对方当前回合的下一步） |

## 注意

- 只能发给**同一个 DSH 进程**里的会话；换机器、换进程不行。
- 归档的会话不能发；子代理会话不能发（它收不了回复），让父会话发。
- 消息最多 20000 字符；不能发给自己。
- 投递成功只代表消息进了对方收件箱并落盘，不代表对方已经执行。
- 落盘没确认会报错；这时消息可能已经送达，重发前先确认。

## 开发

```sh
npm test
```

纯函数在 [lib/core.js](lib/core.js)，插件入口在 [lib/index.js](lib/index.js)，测试在 [test/](test/)。

## License

MIT
