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
- **旧 client 怎么处理取决于谁发起的**：运行时自己决定的重连（某次调用发现会话没了）**脱离**旧 client——
  它保持打开，等还在它身上飞的调用结算完自动关闭。立刻关闭会把那些调用打断，而"被 abort 的调用"与
  "请求在飞时连接断了"无法区分（`maybe-ran`），对 mutate 操作就意味着**拒绝一次本可安全进行的重试**
  （实测：不这么做时，5 个并发 mutate 里有 1 个这样失败，而服务端从未拒绝过它）。
  操作者的 `cap.reconnect(id)` 则**立即关闭**——"重置这个 provider"就是请求本身，而且 stdio 必须杀掉子进程，
  否则每次重连漏一个。
  校验新的 `url` 覆盖发生在两者之前，一个写错的 url 不能把还能用的会话一起搭进去；
- 失败时记下 `state: 'failed'` 与 `lastError`——失败原因是被保留的事实，不是日志。

### 3.2 `call()`：按"能不能证明没执行"决定是否重试

重试不是一种，而是两种——区别在于**能不能证明那次调用没被服务端执行**：

```text
call(op, args)
  ├─ classifySessionLoss(error)
  │    ├─ never-ran（可以证明没执行）→ 无条件重连一次 + 重试一次
  │    │    · HTTP 404（会话不存在：服务端直接拒绝，没跑工具）
  │    │    · SdkErrorCode.NotConnected（传输在发送前就没了）
  │    │    · Error("Not connected") —— SDK 请求路径的形态，无 code（见下）
  │    └─ maybe-ran（无法证明）→ 只有该操作 safety === 'read' 才自动重试
  │         · SdkErrorCode.ConnectionClosed（请求在飞时连接断了）
  │         · TypeError: fetch failed（undici 无法区分"没连上"和"响应中断"）
  │         └─ mutate：抛出可读错误，不重试
  │            provider idea: <原始错误> — the connection failed with the request in
  │            flight, so it may already have run; not retried automatically
  ├─ 重连也失败 → <原始错误> (reconnecting did not help: <重连错误>)
  └─ 其它错误：原样抛出（工具真的失败，不是会话问题）
```

三条依据，都不是风格问题：

- **`Error("Not connected")` 必须认**：SDK 2.0 的*请求*路径在传输已死时抛的是**普通 Error、没有 code**
  （`dist/src-D_zzAWoS.mjs:6063`，`_requestWithSchemaViaCodec`）；只有通知路径用
  `SdkErrorCode.NotConnected`（…:6181）。而 stdio 子进程一死，transport 的 `close` 处理器就清掉
  客户端的 transport，于是**下一次调用正好走这条无 code 的路**——不认它就等于
  "stdio provider 死了只能重启宿主"，和我们修 HTTP/404 前是同一个 bug。
  这条由测试盯住：杀掉 stdio fixture 的子进程，下一次调用必须透明换成新 pid。
- **mutate 不重试**：请求在飞时断连，服务端可能已经执行（一次部署变两次）。
  判据用服务端自己声明的 `annotations.readOnlyHint`（即 `ProjectedOperation.safety`），
  **缺省按 mutate 处理**：代价是少一次自动重试，绝不是多一次副作用。
  这与本文件已有的"`isError` 是结果不是传输失败"是同一条原则的延伸。
- **只重试一次**：非幂等工具重试多次就是一次副作用变三次；
- 两个失败原因都要出现在消息里："session not found" 单独出现会把读者引向客户端 bug，
  而当时真正的事实是**没有东西在监听**；
- 调用已 `abort`（cell 被取消/超时，宿主 `abandonInFlight`）时**不重连**：没人能读的答案不值得再发一次。

> 2026-09-29 补充：Pi 正式版（v0.99.0/v0.99.1，squash-merge `8562bcf66`）里的 MCP 连接层
> 采用了同样的分档——会话过期无条件重试一次（旧 client **detach 不 close**），
> **瞬时 HTTP 错误只在 readOnly 请求上重试**。我们是独立走到这条判据上的，事后对照相互印证。

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

### 3.5 让失败可读：两个上限

这两条不是恢复机制，但决定"失败"能不能被读懂，也都是正式版对照带出来的：

- **转发的错误文本有上限（2,000 字符）**：SDK 把**整个响应体**拼进错误消息
  （`Error POSTing to endpoint: ${body}`，`dist/index.mjs:5360/5382`，无上限）。我们过去原样转发，
  于是一个代理/网关回 HTML 错误页时，几 KB 会进内核堆、再进模型上下文。
  现在 `describeProviderError()` 是唯一出口（bridge 的三处 `fail(...)`、`failures`/`capHelp()` 的消息、
  以及我们自己的包装错误都走它），并在截断处标出还差多少字符——读者必须知道这不是全文；
- **stdio 子进程的 stderr 尾巴（2,000 字符）会被带进失败原因**：SDK 对"子进程退出"只说连接关闭，
  而真正的原因写在子进程的 stderr 上。我们把 transport 的 `stderr` 设成 `'pipe'`（getter 在 `start()`
  之前就可用，所以早期输出不会漏），**同时仍然把这些字节照写宿主 stderr**——捕获不能让运行中的
  服务端日志从日志里消失，只是让最后几句话能出现在 `failures`/`capHelp()` 里。

### 3.6 宿主取消：停下 cell，而不是丢下它

`js` 是一段**程序**，不是一次请求：它可以连续驱动浏览器和 IDE 好几分钟。DSH 的停止/暂停把
`ToolRunContext.signal` 交给工具，而**我们过去没有把它传下去**——`js` 的 `execute` 拿到了 `exec` 却只转发
`timeoutMs`/`title`，`KernelSession.run` 也没有 signal 参数，于是"暂停"只关掉了宿主那一侧的等待，
**cell 继续在核心里跑**（实测：一句轮询 Jenkins 的 cell 在点了暂停之后继续 navigate 到构建结束）。
另一层原因是延迟：内核一次 `node_repl_wait` 最长可阻塞 `MAX_YIELD_MS = 60 s`，不主动监听就最多 60 s 才可能察觉。

现在这条链是通的（`packages/adapter-dsh` 把 `exec.signal` 传进 `runtime.js`）：

```text
宿主 abort
  ├─ 每次内核调用都与 abort 竞争（raceAbort）→ 最长 ~2 s 内察觉
  ├─ 取消走内核 node_repl_cancel（不是丢下不管）
  │    ├─ 先快照在飞 provider 调用（取消会把它们清空，之后再取就没了）
  │    ├─ 等内核真正**释放** active-cell 槽（否则下一格被拒：
  │    │    "node_repl already has active cell …" —— 这曾是本改动的第一个 bug）
  │    └─ 用内核返回的终局结果（含被取消 cell 已经打印的输出）作为结果
  └─ 追加一行提示：谁停的、状态如何处理、哪些调用被切断
```

首调用还加了 `CANCELLABLE_FIRST_YIELD_MS = 2 s` 的上限：内核只在调用返回时才给出 cell id，
在此之前取消无处可指（这曾是第二个 bug：abort 落在首调用返回前，取消分支拿不到 id 而被跳过）；
不设上限这段"盲窗"就是最长 60 s，代价是超时的那一格多一次本地往返。

两条内核语义值得写下来（读自 `dist/runtime/kernel.mjs`，不是推测）：

- **被取消 cell 自己的赋值会回滚**：`restoreBindings(entryBindings)` 把绑定恢复到 cell 入口状态，
  所以"更早的绑定保留原值、本 cell 的赋值消失"。提示里明说了这点，否则模型会把随后的 `undefined` 当 bug；
- `clearTimersForExec()` 会清掉该 cell 的 timer，`exec.cancellationBarriers` 保证已派发的 native 工作
  到达终态后才报终局——所以取消报告的是**真实终局**，不是乐观假设。

### 3.7 其余生命周期面（审计结果）

把"宿主/内核/provider 的生命周期事件"逐个对照过一遍：**除取消这一处，其余都已处理，或是有意为之**。

| 生命周期事件 | 现状 | 依据 |
| --- | --- | --- |
| 插件/宿主卸载 | ✅ `ctx.effect` → `runtime.dispose()`：关内核、bridge、全部 provider | `packages/dsh-bootstrap/src/index.ts` |
| 内核侧 socket 断开 | ✅ bridge 中止所有在飞调用 | `bridge.ts` `socketCalls` |
| cell 预算耗尽 | ✅ 取消 + 预算提示（点名在飞调用） | §3.2 / `abandonedCallsNotice` |
| 内核 **worker** 崩溃 | ✅ `crashed` → 重装 catalog（有测试） | `runtime.test.ts` "kernel replacement" |
| provider 会话失效 / 子进程死亡 | ✅ 重连与重试 | §3.1 / §3.2 |
| **宿主取消 cell** | ✅ 本次修复 | `kernel-cancel.test.ts` |
| **内核 MCP server 进程本身死亡** | ❌ 未处理：下一次调用以 `Error("Not connected")` 失败，**不会**重建会话（只有 worker 死亡才走 `crashed`）。修法是一次单独改动：重建 `KernelSession` + 重装 catalog（绑定按定义丢失，必须如实说） | §5 边界 |
| **`js_reset` 不接宿主信号** | ⚠️ 同类遗漏的残余：reset 期间宿主 abort 不会中断（它本身很短：cancel + reset + install） | `adapter-dsh/src/index.ts` |
| cell 正常结束但仍有 fire-and-forget provider 调用 | ⚠️ **有意保留**（可能是刻意不 await 的调用）；与 Pi 相反——Pi 在脚本返回时中止并报告 cancelled | §5 边界 |

## 4. 验证

全部 hermetic（无网络、无 IDE）。四个文件：三个 provider 行为文件 21 个用例（7 + 6 + 8），加上取消 3 个：

`packages/runtime/tests/session-recovery.test.ts`（7 个）：

| 用例 | 断言 |
| --- | --- |
| server 忘掉会话 | 调用透明恢复并返回结果；新会话恰好 1 个、`tools/list` 恰好 1 次 |
| 并发 10 个调用 | 只产生 **1** 次重连（`sessions() === 2`、`listings() === 2`），且刷新后的 catalog 里能看到"停机期间新装"的工具 |
| endpoint 变更 | `cap.reconnect('idea', { url })` 后调用打到新 endpoint |
| 真的不可达 | cell 拿到可读错误（含 provider 名与原因），`cap.status()` 报 `state: "failed"` + `lastError`——**不会伪装成成功** |
| 健康面 | `cap.status()` 报 `attached: true` / `reconnectable: true` / `operations: 2` |
| 无会话的连接 | `cap.reconnect('fake')` 明确拒绝，不假装重连过 |
| 分类（纯函数） | `SdkHttpError(404)` / `NOT_CONNECTED` / `Error("Not connected")` → `never-ran`；`CONNECTION_CLOSED` / `fetch failed` → `maybe-ran`；500、普通工具错误、`undefined` → `undefined` |

`packages/runtime/tests/provider-transport-loss.test.ts`（8 个，2026-09-29 补）：

| 用例 | 断言 |
| --- | --- |
| stdio 子进程被杀 | 杀掉 fixture 子进程后**下一次调用透明恢复**，且由**新 pid** 服务（旧实现会一直报 `Not connected`） |
| 只读操作遇在飞断连 | 读操作自动重连+重试成功：`sessions()===2`、`calls()===2` |
| mutate 操作遇在飞断连 | **不重连、不重试**：错误含 `may already have run` / `not retried automatically`，`sessions()===1`、`calls()===1`（用请求计数证明没有第二次副作用） |
| 并发 mutate 遇会话失效 | 5 个并发 mutate 里有一个触发重连时，**其余 4 个必须仍被正常服务**（`ok` ×5，无 `err:`）——旧实现会关掉共享 client，把它们打断成 `maybe-ran` 而被拒（实测 5 个中 1 个） |
| stdio 启动即死 | 失败原因里带着**子进程的 stderr 尾巴**（`missing dependency: zod is not installed`），而不是只有 SDK 的 "Connection closed" |
| 网关式大错误体 | 50 KB 的 HTTP 错误体经我们转发后 **< 4 KB** 且带截断标记；500 不是会话失效，所以**不重试**（服务端只收到 1 次） |
| 错误文本上限（纯函数） | 5,000 字符的消息被截到 < 2,200 并带 `more characters` 标记；短消息原样 |
| 分类纯函数 | 上表那六种形态各自归到 `never-ran` / `maybe-ran` / `undefined` |

反向验证（三处改动都不是摆设）：把 `Error("Not connected")` 那支注释掉、只读门反过来，**4 个断言同时变红**
（stdio 那条直接报 `Not connected`，mutate 那条**重试后成功**——正是要避免的双重副作用）；
把 `stderr` 换回 `'inherit'`、去掉错误文本上限各让对应用例变红。

`packages/runtime/tests/kernel-cancel.test.ts`（3 个，2026-09-30 补）：

| 用例 | 断言 |
| --- | --- |
| 宿主取消一个在睡的 cell | 立刻（``< 15 s`` 而不是 30 s 睡眠或 60 s 预算）返回 `cancelled`，输出含"宿主取消了这一格"；随后**内核仍可用**：更早的 `var kept = 41` 仍在、被取消 cell 里的 `var inside = 1` 已回滚成 `undefined`、`cap` 仍在 |
| 取消切断的 provider 调用 | 在飞调用被点名（`idea.slow (… s)` + `has been cancelled`），且不出现 cell 自己写的 finished |
| 提示文案（纯函数） | 含"谁停的"与"本 cell 赋值已回滚"，并列出被切断的调用 |
`packages/runtime/tests/provider-attach.test.ts`（6 个，含并发连接）：

| 用例 | 断言 |
| --- | --- |
| 服务端晚到、端点不变 | 启动时 `attached: false` + `lastError`、`cap.idea` 为 `undefined`；服务端起来后 `cap.reconnect("idea")` 接入（**恰好 1 个会话**），同 cell 内即可调用 |
| 服务端晚到、端点变了 | `cap.reconnect("idea", { url })` 直接连到新端点（仍然是 1 个会话） |
| 接入失败 | `MCP_ATTACH_FAILED` + 可读原因；`runtime.failures()` 与 `capHelp()` 仍如实报告未接入 |
| `disabled` / 未知 id | 分别以"configured with disabled: true"和"unknown provider"拒绝 |
| 内核被替换后 | 运行期接入的 provider 与 `capHelp()` 都不会倒退到启动快照（覆盖 §3.3 第 4 点） |

回归：`packages/runtime` **62 个**、`adapter-dsh` 15 个、`dsh-bootstrap` 9 个测试全绿（`pnpm run verify`，共 86 个），
stdio provider 与内核路径行为未变。修复实测前后的对比是同一份复现用例：
修复前 cell 报 `MCP_CALL_FAILED: Error POSTing to endpoint: Streamable HTTP session not found`
（与生产现场逐字一致），修复后返回结果。

## 5. 没有做的（明确的边界）

- **内核自身的 stdio 连接**（`kernel.ts` 里连 `node-repl-mcp` 的那个 client）仍没有重连骨架。
  内核子进程被杀时 runtime 走既有语义（`crashed` → 重装 catalog，见
  [`docs/04-architecture.zh-CN.md`](04-architecture.zh-CN.md)）；内核**空闲时**死掉的盲区同样还在。
  两处的差别是：内核会话没有 session id 可失效，它的失效信号是"子进程没了"，
  重开意味着重建整个 `KernelSession`（含 install cell），值得单独一次改动；**worker 死（已处理）与 server 进程本身死（未处理）的区分见 §3.7**。
  这次做掉的是它的**可见性**：重装失败不再被吞掉，cell 会看到
  `[node_repl kernel was replaced and the capability catalog could not be reinstalled: <原因>]`，
  而不是一个没有解释的 `cap is not defined`；
- **没有对重连/接入做退避（backoff）**：每次调用最多触发一次重连，连续失败会连续尝试。
  provider 长期不可达时，`cap.status()` 的 `lastError` 是判断依据；
- **provider 的增删仍不发生在运行期**：只有启动时*配置过*的 provider 才能被接入
  （spec 在启动时读入）。运行期新增一个 provider 依然需要重启宿主——那是另一个层次的事；
- **`disabled` 的 provider 不出现在 `cap.status()` / `capHelp()` 里**：它们不是失败，也不是能力，
  只出现在 profile 配置里。这是刻意留白的边界，不是遗漏。
