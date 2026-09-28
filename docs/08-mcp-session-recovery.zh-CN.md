# MCP 会话失效与恢复（streamable-HTTP provider）

> 这份文档回答一个实测问题：IDEA 重启后，`cap.idea.*` 为什么会**永久**报
> `MCP_CALL_FAILED: Error POSTing to endpoint: Streamable HTTP session not found`，
> 以及修复后长会话如何不再需要重启整个 DSH profile。

## 1. 现象与实测复现

DSH Web 会话存活期间重启 IDEA（MCP endpoint 不变，仍是 `http://127.0.0.1:64342/stream`）之后：

- 该 provider 的**每一次** `cap.idea.*` 调用都失败，错误固定为
  `Error POSTing to endpoint: Streamable HTTP session not found` / `Code: MCP_CALL_FAILED`；
- `cap.list()` 仍然报告 `idea`（catalog 是连接时抓的，已陈旧）；
- `js_reset()` 无效——它重建的是内核，不是宿主侧的 MCP client；
- 等待、重试、`js_reset()` 都不会恢复；只有重启整个 DSH profile 才会。

reproduce 用的是 `packages/runtime/tests/support/idea-like-server.ts`：一个真实的、
有会话的 streamable-HTTP MCP server，`restart()` 只清空 session 表、URL 与工具表不变——
这正是 IDE 重启的形状，不是桩（桩在 connector 接缝上，根本走不到 session id 这一层）。

## 2. 根因

三件事叠在一起，缺一不可：

| 层 | 事实 |
| --- | --- |
| MCP 规范 | 服务端收到自己不认识的 `Mcp-Session-Id` 时，应答 **404**；IDEA 的报错文本是 `Streamable HTTP session not found` |
| SDK 2.0 的 `StreamableHTTPClientTransport` | 只在 `client.connect()` 时握手拿 `Mcp-Session-Id`，之后一直带这个 id；**没有** 会话失效检测、没有 `terminateSession()` 的自动调用、没有重连 |
| `catalog.ts`（修复前） | `connectMcpProvider()` 只连一次，`call()` 闭包捕获同一个 `client`，不检测失效、不重连、不重试 |

于是：IDEA 重启 → 旧 session id 失效 → 客户端仍带旧 id POST → 404 → 永久失败，
直到 DSH profile 重启（重启才会重新 `connect()`）。

判定"哪种错误算会话失效"必须看 **HTTP status**，不能看 SDK 的 error code：

```ts
// packages/runtime/src/catalog.ts
export function isSessionLoss(error: unknown): boolean {
  if (status === 404) return true
  if (code === SdkErrorCode.NotConnected || code === SdkErrorCode.ConnectionClosed) return true
  return error instanceof TypeError && error.message === 'fetch failed'
}
```

原因很具体：SDK 2.0 把**所有**非 2xx 的 POST 都报成同一个
`SdkHttpError` + `SdkErrorCode.ClientHttpNotImplemented`（源码 `_send()`），
code 里没有任何会话信息，status 才是唯一可靠信号。另外两类同属"什么都没送达"，
重试安全：

- `NOT_CONNECTED` / `CONNECTION_CLOSED`：传输层已经没了（SSE 流关闭、stdio 子进程死亡）；
- `TypeError: fetch failed`：请求根本没完成（undici 把真实 errno 藏在 `cause`），
  IDE 还在启动时打来的第一个调用就是这个形状。

**服务器上工具真的失败**（`isError` 结果、500）**不在**这个集合里：那是一个结果，不是传输错误，
重试只会把一次副作用变成两次。

## 3. 设计

### 3.1 连接变成可重开的（`ProviderConnection.session`）

```ts
readonly session?: ProviderSession   // { health(): ProviderHealth; reconnect(options?): Promise<ProviderHealth> }
```

- `connectMcpProvider()` 一定提供；测试接缝（`connector`）和宿主自建的连接可以不给——
  **没有可丢的会话就说没有**，用一个"reconnect 成功但什么都没做"的假实现更糟；
- `operations` 改成 **getter**：重建过的会话可能在服务不同的工具表，
  缓存第一份的调用方会一直提供服务器已经没有的操作；
- `reconnect()` 是 **single-flight** 的：并发调用共享同一次重连，不会抢着开多个会话；
- 先关旧 client 再开新的：stdio 不关就每次重连泄漏一个子进程；HTTP 走到这条路径时旧会话本来就已经死了。
  校验新的 `url` 覆盖发生在关闭**之前**，一个写错的 url 不能把还能用的会话一起搭进去；
- 失败时记下 `state: 'failed'` 与 `lastError`——失败原因是被保留的事实，不是日志。

### 3.2 `call()`：失效 → 重连一次 → 重试一次

```text
call(op, args)
  ├─ 会话失效（isSessionLoss）
  │    ├─ 重连（single-flight）
  │    │    └─ 重连也失败 → 抛出"两个事实都带上"的错误：
  │    │       provider idea: <原始错误> (reconnecting did not help: <重连错误>)
  │    └─ 在新会话上重试一次；再失败就原样抛出（不再重试）
  └─ 其它错误：原样抛出（工具真的失败，不是会话问题）
```

- **只重试一次**：非幂等工具重试多次就是一次副作用变三次；
- 两个失败原因都要出现在消息里："session not found" 单独出现会把读者引向客户端 bug，
  而当时真正的事实是**没有东西在监听**；
- 调用已 `abort`（cell 被取消/超时，宿主 `abandonInFlight`）时**不重连**：没人能读的答案不值得再发一次。

### 3.3 恢复要对内核可见

内核是独立进程，`nr-cap` 在 import 时读一份 `config.json` 快照；而 ESM 模块被缓存，
`js_reset()` 后的 `await import('nr-cap')` 拿回的是**同一个实例**——所以"重建"只能在原地做。

三件事：

1. **调用回包里带 catalog**：一次调用如果重建过会话，bridge 的回包多带一份
   `{providers, health, failures}`，`nr-cap` 在 resolve 之前 `applyCatalog()`。
   于是**同一个 cell 的下一条语句**就能看到新工具表——`cap.list()` 不会在恢复后继续说谎；
2. `cap.refresh()`：向宿主要一次实时 catalog（一次往返）。`cap.list()` 仍是**本地同步**的，
   日常发现不过桥这条设计没有变；
3. `cap.status()` / `cap.reconnect(id, { url })`：
   - `cap.status()` 返回每个 provider 的实时健康（`state` / `attached` / `reconnectable` /
     `operations` / `generation` / `reconnects` / `lastError` / `url`）；
   - `cap.reconnect(id, { url })` 显式重开会话（或首次接入，见 §3.4），并**可以换一个 endpoint**——
     IDE 若换了端口，不必重启 DSH profile；
4. **install 时校准**：内核每次安装 catalog（启动、`js_reset`、内核被替换后重装）都会
   best-effort 调一次 `cap.refresh()`。新内核读的是启动时的 `config.json`，
   没有这一步，运行期发生的变化（接入的 provider、重建后的工具表）会在内核重建后倒退回去。
   失败则退回文件快照——`cap.status()` 是对的照面。

回包携带而不是推送：内核只有一条 socket，它只收自己问过的东西；
而"会话刚被重建"正是它那份操作表即将开始说谎的时刻。

`catalogEntries()` 是 snapshot 与 refresh **共用的唯一构造器**：
两边一旦漂移，只有重启才看得出来——恰恰是这次要修的那一类 bug。

### 3.4 宿主启动时就不可达的 provider：运行期接入

同一类症状的第二个触发点，而且更常见：**DSH 先起、IDEA 后开**。
这时 `idea` 连"失效的会话"都没有——连接对象根本不存在，原先的 `cap.reconnect` 只会回
`unknown provider idea`，同样只能靠重启宿主。

修法不是加第二个动词，而是让 `cap.reconnect(id, { url })` 一个动词管两半：

| provider 状态 | `cap.reconnect(id)` 做的事 |
| --- | --- |
| 已连接、会话失效 | 丢弃旧会话并重开（§3.1 / §3.2） |
| 配置了、从未接上 | 用保留下来的 spec 首次接入；`url` 覆盖**直接作用于这次连接**（不会先连一次再换） |
| `disabled: true` | 明确拒绝——这是操作者的指令，不是"暂时"状态 |
| 未知 id | `unknown provider <id>` |

- 失败的 spec 被**保留**（`failures` 从"只记一句错误"变成"spec + 最新原因"），晚到的服务端才接得回来；
- 并发 `cap.reconnect` 共用一次接入（single-flight）；
- `cap.status()` 把未接入的也列出来（`attached: false` + `lastError`）——
  "去哪了"必须能回答，这是本仓库一贯的发现面原则；
- 接入成功后该条立即从 `failures` 移除，`capHelp()` 与内核命名空间随回包一起更新。

## 4. 验证

全部 hermetic（无网络、无 IDE），共 12 个用例，分两个文件：

`packages/runtime/tests/session-recovery.test.ts`（7 个）：

| 用例 | 断言 |
| --- | --- |
| server 忘掉会话 | 调用透明恢复并返回结果；新会话恰好 1 个、`tools/list` 恰好 1 次 |
| 并发 10 个调用 | 只产生 **1** 次重连（`sessions() === 2`、`listings() === 2`），且刷新后的 catalog 里能看到"停机期间新装"的工具 |
| endpoint 变更 | `cap.reconnect('idea', { url })` 后调用打到新 endpoint |
| 真的不可达 | cell 拿到可读错误（含 provider 名与原因），`cap.status()` 报 `state: "failed"` + `lastError`——**不会伪装成成功** |
| 健康面 | `cap.status()` 报 `attached: true` / `reconnectable: true` / `operations: 2` |
| 无会话的连接 | `cap.reconnect('fake')` 明确拒绝，不假装重连过 |
| 分类（纯函数） | 404 / `NOT_CONNECTED` / `CONNECTION_CLOSED` / `fetch failed` → true；500、普通错误、`undefined` → false |

`packages/runtime/tests/provider-attach.test.ts`（5 个）：

| 用例 | 断言 |
| --- | --- |
| 服务端晚到、端点不变 | 启动时 `attached: false` + `lastError`、`cap.idea` 为 `undefined`；服务端起来后 `cap.reconnect("idea")` 接入（**恰好 1 个会话**），同 cell 内即可调用 |
| 服务端晚到、端点变了 | `cap.reconnect("idea", { url })` 直接连到新端点（仍然是 1 个会话） |
| 接入失败 | `MCP_ATTACH_FAILED` + 可读原因；`runtime.failures()` 与 `capHelp()` 仍如实报告未接入 |
| `disabled` / 未知 id | 分别以"configured with disabled: true"和"unknown provider"拒绝 |
| 内核被替换后 | 运行期接入的 provider 与 `capHelp()` 都不会倒退到启动快照（覆盖 §3.3 第 4 点） |

回归：`packages/runtime` 44 个、`adapter-dsh` 15 个、`dsh-bootstrap` 7 个测试全绿（`pnpm run verify`），
stdio provider 与内核路径行为未变。修复实测前后的对比是同一份复现用例：
修复前 cell 报 `MCP_CALL_FAILED: Error POSTing to endpoint: Streamable HTTP session not found`
（与生产现场逐字一致），修复后返回结果。

## 5. 没有做的（明确的边界）

- **内核自身的 stdio 连接**（`kernel.ts` 里连 `node-repl-mcp` 的那个 client）仍没有重连骨架。
  内核子进程被杀时 runtime 走既有语义（`crashed` → 重装 catalog，见
  [`docs/04-architecture.zh-CN.md`](04-architecture.zh-CN.md)）；内核**空闲时**死掉的盲区同样还在。
  两处的差别是：内核会话没有 session id 可失效，它的失效信号是"子进程没了"，
  重开意味着重建整个 `KernelSession`（含 install cell），值得单独一次改动。
  这次做掉的是它的**可见性**：重装失败不再被吞掉，cell 会看到
  `[node_repl kernel was replaced and the capability catalog could not be reinstalled: <原因>]`，
  而不是一个没有解释的 `cap is not defined`；
- **没有对重连/接入做退避（backoff）**：每次调用最多触发一次重连，连续失败会连续尝试。
  provider 长期不可达时，`cap.status()` 的 `lastError` 是判断依据；
- **provider 的增删仍不发生在运行期**：只有启动时*配置过*的 provider 才能被接入
  （spec 在启动时读入）。运行期新增一个 provider 依然需要重启宿主——那是另一个层次的事；
- **`disabled` 的 provider 不出现在 `cap.status()` / `capHelp()` 里**：它们不是失败，也不是能力，
  只出现在 profile 配置里。这是刻意留白的边界，不是遗漏。
