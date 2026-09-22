# 内核边界与已知限制

> 这是一份**决定记录**，不是待办清单。内核（`@qwen-code/node-repl-mcp`）是常驻进程、绑定跨 cell 存活，
> 于是"内存会累积、cell 能起进程、内核死了谁善后"这些问题落在我们这一层。本文记录：实测到的事实、
> 两个对照实现（Qwen 同族内核、Codex code-mode）的取舍、我们**刻意不做**的部分及理由，
> 以及**什么情况下应该回头做**。

## 1. 事实基础（实测，非推断）

| 事实 | 证据 |
| --- | --- |
| 内核是**每 DSH 进程一个**，不是每会话一个 | `logs/web-3094.log` 整个 run 只有一行 `[node-repl-runtime] mounted …`；bootstrap 注释自称 "process-level singleton" |
| 内核堆**没有上限**，默认 4.19 GB | cell 内 `nodeRepl.getHeapStatus()` → `heapLimitBytes: 4496293888`（V8 按物理内存算） |
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
| 作用域实现在**进程级**，不是会话级 | 设计意图是"一个会话"（Codex 的测试名就是 `...but_not_sessions`），我们的 runtime 是进程级单例。后果：绑定跨会话可见、`js_reset` 是全局的、单活动槽跨会话争用 |
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
| 给内核设 `--max-old-space-size` | 会**误伤合法的大 cell**（内存里处理大文件）。当前 4.19 GB 默认值在三天常驻下没出过事。这是调参，不是修 bug |
| 宿主侧进程登记 + 启动清理孤儿 | 进程审计里**零孤儿**；为没发生的故障在热路径上加状态 |
| 会话级内核（把作用域改回会话级） | 架构改动：provider 连接要跟着会话走或做共享池。**没有观察到痛点** |
| generation / cell 注册表 / 会话级清理 token | 照抄 Codex 的仪式而不承担它的约束（多租户产品、安全边界是硬需求）= cargo cult |
| OS 级沙箱（受限账号、Job Object、防火墙） | 同上，并且我们已经有 DSH 自己的 sandbox 服务可用，不需要在本内核里再建一套 |

## 6. 什么时候应该回头做（可观测扳机）

任一条出现，就是真证据，届时再动第 5 节里对应的项：

1. 日志或会话里出现过一次 `cap is not defined`；
2. 进程审计里出现孤儿（`engram` / `cua-driver` / `node` / 内核）；
3. 内核子进程 RSS 涨到 GB 级，或 `nodeRepl.getHeapStatus()` 报接近上限；
4. 你开始**同时跑多个会话**，并观察到绑定互相干扰，或 `js_reset` 清掉了别人的状态。

## 7. 如果要做，最小的三件

| 要补的 | 参照（可直接读的源码） |
| --- | --- |
| 内核换代善后 | `codex-src/codex-rs/code-mode/src/grpc_session/generation.rs`（130 行；跨代引用必须显式失败） |
| 记账与可回收 | `code-mode/src/remote_session/connection/driver/{cleanup.rs, session_registry.rs, cell_ids.rs}`（合计约 15 KB） |
| 资源天花板 | `code-mode-protocol/src/session.rs:30` + `code-mode-protocol/src/host/payload.rs`（上限如何贯通两层） |

## 8. 已经做了的部分（本轮）

- 内核 `crashed` → 自动重装 catalog，并在结果里追加
  `[node_repl kernel was replaced: bindings lost, capability catalog reinstalled]`（`packages/runtime/src/kernel.ts`）。
- 工具描述新增 "Kernel lifetime" 段：大对象用完置空、不要 `detached` 起进程、
  `cap` 为 undefined 时调 `js_reset`（`packages/adapter-dsh/src/descriptions.ts`）。

## 对应实现

- [内核会话：安装、取消、崩溃恢复](../packages/runtime/src/kernel.ts)
- [工具描述（模型可见的纪律）](../packages/adapter-dsh/src/descriptions.ts)
- [provider 生命周期与失败可见性](./04-architecture.zh-CN.md)
- [图片通路](./05-image-content-blocks.zh-CN.md)
