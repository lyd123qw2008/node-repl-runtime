# 内核边界与已知限制

> 这是一份**决定记录**，不是待办清单。内核（`@qwen-code/node-repl-mcp`）是常驻进程、绑定跨 cell 存活，
> 于是"内存会累积、cell 能起进程、内核死了谁善后"这些问题落在我们这一层。本文记录：实测到的事实、
> 两个对照实现（Qwen 同族内核、Codex code-mode）的取舍、我们**刻意不做**的部分及理由，
> 以及**什么情况下应该回头做**。

> **2026-09-28 复核结论（先读这一段，避免重议）**
>
> 内核**不自动结束**。DSH 没有可靠的结束语义（见 §5），而任何定时/空闲回收都会**静默毁掉跨 cell
> 的活对象**——浏览器、桌面自动化的全部价值就在这些活对象上（一个被丢掉的标签页能按 URL 重载，
> 一个被回收的内核绑定没有任何重建来源）。
>
> 因此现行决定是四条"不做"加两个显式杠杆：
>
> | 决定 | 一句话理由 |
> | --- | --- |
> | **不设 `--max-old-space-size`** | 会误伤合法的大 cell；且无论设不设，V8 到顶都会 abort，我们已有那条恢复路径 |
> | **不自动回收（无空闲 TTL、无 LRU、无按会话分内核）** | 没有可靠的结束信号；定时猜结束 = 拿真状态赌运气 |
> | **不做 GC** | V8 已经在做；内核每格新建 ES module 属**架构性保留**，JS 层任何 GC 都碰不到（§5.1） |
> | **不抄"Memory Saver"式的闲置自动丢弃** | 那是浏览器唯一不能抄的一条：它靠"能重载"，我们没有 |
> | **保留两个显式杠杆**：`x = null`（让对象变成垃圾）与 `js_reset`（换 generation，实测 115 ms） | 唯一知道"我用完了"的一方是模型 |
> | **可见性按需**：cell 内 `nodeRepl.getHeapStatus()`；宿主侧采样/阈值提示列为**可选、未实现** | 不喜欢"会自动说话的东西"，所以默认安静 |
>
> 代价（明写在 §5.1）：一个 DSH 进程一个内核，存活期内堆只增不减、绑定跨会话可见；
> 操作层面的回收按钮是**重启 DSH**（等价于"重启浏览器"；本轮为装修复按过一次 3100）。

## 1. 事实基础（实测，非推断）

| 事实 | 证据 |
| --- | --- |
| 内核是**每 DSH 进程一个**，不是每会话一个 | `logs/web-3094.log` 整个 run 只有一行 `[node-repl-runtime] mounted …`；bootstrap 注释自称 "process-level singleton" |
| 内核堆**没有上限**，默认由 V8 按物理内存算（两轮实测 4.19 / 4.29 GB） | cell 内 `nodeRepl.getHeapStatus()` → `heapLimitBytes: 4496293888`（另一轮 `…888` 之外测得 4.29 GB；同一机制、取值随机器状态变） |
| 绑定**跨 cell 存活**，只有 `js_reset` 或内核被替换才清 | `var` 绑定在后续 cell 可见；`js_reset` 会重启内核进程 |
| cell **可以起进程**，且无人记账 | cell 内 `await import('node:child_process')` 成功并起了一个子进程；官方 `security-policy.js` 自述 "deliberately has NO trusted-package / capability layer" |
| 内核**死于 cell 中途** → 官方报 `crashed`，新内核没有 `cap` | 杀死内核 pid 后该 cell 返回 `crashed`；未修复前下一个 cell 报 `ok` 而 `cap is undefined` |
| 内核**空闲时死** → 下一个 cell 报 `ok`，宿主**无从判断** | 同一实验的空闲变体；没有任何宿主侧信号 |
| 当前**没有孤儿进程** | 进程审计：3093/3094 各一个内核，`mspaint` 挂在 cua-driver 下 |

## 2. 两个对照实现

### Qwen `@qwen-code/node-repl-mcp`（我们用的内核）

- **常驻**内核，per-MCP 连接一个；`generation` 单调递增，旧世代的结果一律判 `crashed` + "bindings were lost"。
- 受管终止时杀**进程树**：POSIX 进程组 `kill(-pid)`、Windows `taskkill /T`；`CANCEL_GRACE 5s` → SIGKILL。
- 原始输出有上限（文本 16 MB / 128K 事件、图 64 张 / 128 MB），**没有堆上限、没有空闲回收**。
- 取消/超时的 cell，其**新建绑定不提交**（README 明文），所以失败 cell 不会泄漏绑定。

### Codex code-mode（`codex-src` @ `94174e4`，本机浅克隆）

- 同样是**会话级**存储：`SessionRuntime` 注释 "Owns all cells and shared state for one transport-neutral
  code-mode session"，里面有 `stored_values: HashMap<String, Arc<JsonValue>>`。
- 作用域规则被写进**测试名**：`stored_values_are_shared_between_cells_but_not_sessions`
  （`code-mode-runtime/src/service_tests.rs:413`）——**跨 cell 共享、不跨会话**。
- 提交时机同样讲究：`commit_completion` 只在 cell 完成时把新值写入 `stored_values`，取消则
  `CompletionCommit::Rejected` 不写（`session_runtime/mod.rs:280-296`）。
- 甚至专门测"没被 root 住"：`discarded_tool_response_is_collectible_before_cell_ends()`
  （`module_loader_tests.rs:16`，用 `Weak` 断言）。
- 资源上限是**协议的一部分**：`max_heap_size_bytes`（`code-mode-protocol/src/session.rs:30`），
  测试用 16 MB 验过；但 `InProcessCodeModeSession::with_limits()` **显式把它覆写成 `None`**
  （`code-mode-runtime/src/service.rs:46`、`:59`）——接口在、那条路径选择不用。
- 边界完全在 **OS 层**，不在 JS 层：两个专用 Windows 账号（`CodexSandboxOffline` /
  `CodexSandboxOnline`，DPAPI 存密码）、每版本一个 `codex-command-runner-*.exe`、WFP 防火墙、
  ACL/deny-read、一个常驻 Windows 服务管 provisioning（`windows-sandbox-rs` / `windows-sandbox-service`）。
- **不在开源仓里**：`node_repl.exe`（在 `runtimes\cua_node\<hash>` 下载）、`process_manager/chat_processes.json`、
  `node_repl/active_execs/`。全仓搜 `chat_processes` / `active_execs` 零命中。

### 结论

**两个模型在"值活一个会话"上完全一致**——这不是 Qwen 的怪癖，而是 code-mode 的共识。
差异不在生命周期策略，而在两处：**实例化层级**，以及**边界由谁承担**（Codex 用 OS 原语，Qwen 只给 VM context）。

## 3. 我们偏离设计意图的地方

| 偏离 | 准确说法 |
| --- | --- |
| 作用域实现在**进程级**，不是会话级 | 设计意图是"一个会话"（Codex 的测试名就是 `...but_not_sessions`），我们的 runtime 是进程级单例。后果：绑定跨会话可见、`js_reset` 是全局的、单活动槽跨会话争用。**2026-09-28：此项按决定接受、不修**——见开头那段与 §5.1（不自动结束 ⇒ 不做定时/按会话回收；作用域改会话级会让 N 个会话 = N 个永不结束的内核，比一个更贵） |
| Qwen 给了 `generation`，我们**没有消费方** | 旧世代的结果我们自己也会判 `crashed`，但"内核换了人"这件事我们只能从 cell 结局反推 |
| 没有**进程记账** | 内核与 provider 都由子进程承担，但我们这一层不登记 `osPid`，异常退出后无法核对 |

## 4. 靠机制 vs 靠纪律

| 机制保障（硬） | 纪律/文档保障（软） |
| --- | --- |
| provider 连接失败的客户端回收（有反证测试） | 大对象用完置空（尤其 `_images`） |
| 图片 MIME 白名单与预算（上游 + 入站） | 不 `detached` 起进程 |
| 内核 `crashed` → 自动重装 catalog + 可见提示（有反证测试） | 内核空闲死亡 → 调 `js_reset`（工具描述明写） |
| 失败原因对模型可见（`capHelp()` 的 `NOT ATTACHED` 区） | 一个内核被整个 DSH 进程共享 |
| 超时、受管终止时的进程树杀（Qwen 提供） | — |

右侧那几条都需要**模型知道**才成立，所以它们的归宿是工具描述而不是回收策略：唯一知道"我用完了"
的一方是模型，硬编码的回收只会猜错。整体属性因此是 **"异常可检测 + 一步可恢复"**，
而不是"机制上不可能出错"。

## 5. 明确不做（及理由）

| 不做 | 理由 |
| --- | --- |
| 给内核设 `--max-old-space-size` | 会**误伤合法的大 cell**（内存里处理大文件）。当前 4.19 GB 默认值在三天常驻下没出过事。这是调参，不是修 bug。另注：不设上限 ≠ 不会崩——V8 到默认天花板（我们两次实测 4.19 / 4.29 GB，由物理内存算出）仍会 abort，那正是 `crashed → 重装 catalog` 覆盖的情形 |
| 宿主侧进程登记 + 启动清理孤儿 | 进程审计里**零孤儿**；为没发生的故障在热路径上加状态 |
| 会话级内核（把作用域改回会话级） | 架构改动：provider 连接要跟着会话走或做共享池。**没有观察到痛点**；而且若同时不做空闲回收，N 个会话 = N 个永不结束的内核，比一个更贵（§5.1） |
| generation / cell 注册表 / 会话级清理 token | 照抄 Codex 的仪式而不承担它的约束（多租户产品、安全边界是硬需求）= cargo cult |
| OS 级沙箱（受限账号、Job Object、防火墙） | 同上，并且我们已经有 DSH 自己的 sandbox 服务可用，不需要在本内核里再建一套 |
| **自己实现 GC / 内存回收** | V8 已经在做分代 GC，我们做不出更好的；而且增长中有相当一部分**不在 JS 可达层**——内核每格 `loader.createCell()` 生成 `.qwen_node_repl_cell_<generation>_<execId>.mjs` 并 import（`kernel.mjs:940-948`），这是"绑定跨 cell 存活、`var` 可重声明"的实现基础，也是模块注册表里收不掉的部分：实测"用完就丢"的 cell 20 格仍 **+6.35 MB**，制造 GC 压力只收回约一半、余 ~3 MB（[docs/07 §2](./07-codemode-ptc-and-kernel-lifetime.zh-CN.md)）。唯一能释放它的是换 generation（`js_reset`） |
| **空闲 TTL / LRU 自动回收内核** | 没有可靠的"结束"或"空闲"语义可用：DSH **有** `session/created` / `session/disposed`（`core/session/src/index.ts:53,63`，session-controller 订阅它们维护 API 列表），但 disposal 是**显式动作而非自然终结**（用户可能永不删除，只能等宿主重启）；客户端的"退场"是前端内存策略（`client/sessions/manager.ts` 的 `retainedIds` / `engagedSessions` / `retireScope`），宿主侧 grep 不到任何回收策略。实测现场也印证：最老 DSH 进程 80 小时、同时 3 套内核树 213.6 MB |
| **"Memory Saver"式闲置自动丢弃 + 回来重载** | 这是浏览器唯一**不能抄**的一条。Chrome 敢自动 discard，是因为被丢弃的标签页能**按 URL 重新加载**（[Memory Saver](https://support.google.com/chrome/answer/12929150)、[Tab Discarding](https://developer.chrome.com/blog/tab-discarding)）；内核里的绑定没有重建来源。其余浏览器式做法都可以抄：任务管理器 = 可见性、关标签页 = `x = null`、重启浏览器 = `js_reset` / 重启 DSH |
| 宿主侧采样 + 阈值提示 + 粗归因 | **可选、尚未实现**：内核每格 stats 只有 `durationMs / generation / pid / rawTextBytes / imageCount`（`kernel-manager.js:813-821`），**不含堆**；要采就得额外一次小 cell（实测 ~13 ms/格）。按"不喜欢会自动说话的东西"的先例，留作备选而非默认 |

## 5.1 为什么 CLI 不痛、痛在我们（形态差异，不是实现差异）

| 宿主形态 | 作用域从哪来 | 每次执行成本 | 谁在里面见过这个问题 |
| --- | --- | --- | --- |
| `codex exec`（一次性 CLI） | **进程边界，免费**：退出即全清 | — | 没人需要解决 |
| Codex 长命 TUI + code-mode | **一个 code-mode session**（`SessionRuntime` 注释、测试名 `stored_values_are_shared_between_cells_but_not_sessions`）；另有 `turn_ended` 工具作为轮次信号 | — | 上游**自造**了边界，不是白拿 |
| DSH PTC | **每次程序**一个受管子进程（`--max-old-space-size=512`、输出 64 MB、超时、在飞调用 128） | **~400 ms/程序** | 安全但慢，细粒度试探 1.7×；呈现上另有一条不迁移的理由（调用清单脱离程序、丢流程），见 [docs/07 §6 的 2026-09-28 注](./07-codemode-ptc-and-kernel-lifetime.zh-CN.md) |
| **我们（内核接在 DSH 进程上）** | **无边界** | **~13 ms/格** | 只有我们，因为只有我们把同一个内核接进了**常驻服务** |

对照实现的资源策略（都指向同一个结论：**没人靠"限制 JS 堆"解决这个问题**）：

- **Qwen**：worker 的真实启动参数是 `--no-warnings --experimental-vm-modules --experimental-import-meta-resolve kernel.mjs`（本会话进程审计），**没有堆参数**；它给的是**边界定价**——模型可见文本 10,000 token、错误 16 KB、图片 ≤4 MB/张 ≤8 张 ≤8 MB 总，原始文本 16 MB / 128K 事件 / 图 64 张，加上多级超时与"取消后 5 s 不响应就换内核"。
- **Codex**：`max_heap_size_bytes` 是**协议的一部分**（`code-mode-protocol/src/session.rs:30`），但 `InProcessCodeModeSession::with_limits()` **显式覆写成 `None`**；边界完全在 OS 层（受限账号、`codex-command-runner`、防火墙）。本机 `node_repl.exe` 二进制里也没有 `max-old-space-size` / `rlimit` / `memory_limit` 字符串，但有 `sandbox` / `CODEX_CLI_PATH` / `guardian` / `active_execs`。
- 真正设了内存上限的两家都是**每次新执行**的形态：Pi 的 QuickJS（同进程 wasm VM，`memoryLimitBytes`）与 DSH PTC（每程序 512 MB）。

**结论**：CLI 里这个问题不存在，是因为那里**不需要做决定**；我们把它接进常驻服务，就必须自造作用域或接受它。我们选择**接受**，理由是活对象就是价值。这条取舍是第一段那张表的全部含义。

## 6. 什么时候应该回头做（可观测扳机）

任一条出现，就是真证据，届时再动第 5 节里对应的项：

1. 日志或会话里出现过一次 `cap is not defined`；
2. 进程审计里出现孤儿（`engram` / `cua-driver` / `node` / 内核）；
3. 内核子进程 RSS 涨到 GB 级，或 `nodeRepl.getHeapStatus()` 报接近 `heapLimitBytes`；
4. 你开始**同时跑多个会话**，并观察到绑定互相干扰，或 `js_reset` 清掉了别人的状态；
5. **`js_reset` 丢绑定的代价开始明显小于继续跑的代价**（例如浏览器/桌面会话里，活对象价值被堆压力反复打断）——那时才谈天花板或提示，而不是现在。反过来，第 3 条的量化（`heapUsedBytes` / `heapLimitBytes`）也说明这不是"感觉快满了"，得有数字。

## 7. 如果要做，最小的三件

| 要补的 | 参照（可直接读的源码） |
| --- | --- |
| 内核换代善后 | `codex-src/codex-rs/code-mode/src/grpc_session/generation.rs`（130 行；跨代引用必须显式失败） |
| 记账与可回收 | `code-mode/src/remote_session/connection/driver/{cleanup.rs, session_registry.rs, cell_ids.rs}`（合计约 15 KB） |
| 资源天花板 | `code-mode-protocol/src/session.rs:30` + `code-mode-protocol/src/host/payload.rs`（上限如何贯通两层） |

## 8. 已经做了的部分（历史记录，2026-09-18 那一轮）

- 内核 `crashed` → 自动重装 catalog，并在结果里追加
  `[node_repl kernel was replaced: bindings lost, capability catalog reinstalled]`（`packages/runtime/src/kernel.ts`）。
- 工具描述新增 "Kernel lifetime" 段：大对象用完置空、不要 `detached` 起进程、
  `cap` 为 undefined 时调 `js_reset`（`packages/adapter-dsh/src/descriptions.ts`）。

## 对应实现

- [内核会话：安装、取消、崩溃恢复](../packages/runtime/src/kernel.ts)
- [工具描述（模型可见的纪律）](../packages/adapter-dsh/src/descriptions.ts)
- [provider 生命周期与失败可见性](./04-architecture.zh-CN.md)
- [图片通路](./05-image-content-blocks.zh-CN.md)
