# Qwen Node REPL 内核接管与两项优先改造方案

> **状态：源码接管与 P0-A/B 已实施，`pnpm run verify` 全量通过；sandbox 文档 09 暂缓。** 本文只记录源码来源及语义目标；不包含 sandbox 或安全隔离能力的实现，不作生产安全承诺。
>
> **优先项：** ① 用户代码末尾不必强制写 `;`；内核插入的 snapshot/commit 不得和用户源代码粘连或改变 JavaScript 语义。② 跨 cell 重复使用顶层名字，不再要求模型为避开 `SyntaxError` 改用 `var`、换名或 reset。

---

## 1. 接管结论

已接管 **Qwen 已发布 `@qwen-code/node-repl-mcp@0.1.6` 对应的 kernel 源码**，在本仓库内维护；没有从零重写 parser、cell transform、binding transport 或 worker。基线锁定 commit `b7543aeb1bd58537a2216253e8ba5020d4814c9c`，未迁入 desktop relay。完整 provenance、文件范围、patch ledger 与同步步骤见 [`packages/kernel-engine/UPSTREAM.md`](../packages/kernel-engine/UPSTREAM.md)。

本轮按“**接管源码 → 分别实现两项定制 → 保持 MCP compatibility entry 并切换 runtime**”完成；provider broker、runtime facade、DSH adapter 和 `js` / `js_reset` 工具合同保持不变。两个改造已有独立测试范围，并随本次代码变更一并提交；进一步移除 MCP 外壳属于后续工作。

Qwen 内核为 Apache-2.0；vendor 时保留版权头、LICENSE/NOTICE，并建立上游基线与 patch ledger。这个接管本身**不构成安全沙箱**，Node worker 仍按普通 Node authority 运行；sandbox 与本提案分开审批和验证。

## 2. 原始缺口与修复依据

### 2.1 分号问题（已修复）

上游 cell transform 在语句边界注入 snapshot commit。用户省略尾部分号时，生成代码可能把内部 identifier 接在用户最后一个 token 后，出现与用户源代码无关的 `SyntaxError`。背景为 [Issue #12167](https://github.com/QwenLM/qwen-code/issues/12167) 与 [PR #12168](https://github.com/QwenLM/qwen-code/pull/12168)。本仓库没有整份复制 PR diff，而是在每个 parsed source item 的边界于 snapshot 前生成显式分隔符，并通过 parser transform 与真实持久 kernel 测试验证 ASI、注释及 tagged-template 语义。

### 2.2 重声明问题（已修复）

接管前，[DSH `js` 工具描述](../packages/adapter-dsh/src/descriptions.ts) 会要求可能复用的名字优先用 `var`，并警告不要跨 cell 重声明旧 `let` / `const` / function / class。当前描述已更新；当前实现允许跨 cell 替换 binding，让旧 closure 观察最新值，同时保持当前 `const` assignment 与同 cell duplicate lexical declaration 的错误行为。错误继续提交已完成 checkpoint，cancel/timeout 恢复 cell-entry binding reference 状态。具体实现和回归范围见 [`packages/kernel-engine/UPSTREAM.md`](../packages/kernel-engine/UPSTREAM.md)。

## 3. 已确认的语义合同

### A. 无分号 cell

- 接受普通 JavaScript 的 ASI 用法；不再要求每条 top-level statement 必须显式以 `;` 结束。
- 内部 snapshot/commit 在任何 cell、任何合法末尾 token 后都不得粘连到用户代码。
- 转换必须保持用户语义；尤其覆盖 tagged template、换行、line/block comment、字符串/模板字符串、数字字面量、`await`、声明和表达式。
- 如果某个构造无法在不改变语义的情况下安全转换，宁可返回指明位置和修复方法的清晰错误，不得静默改义或静默丢失 binding commit。
- 该能力通过后，移除工具描述里“top-level statement 必须写分号”的强制提醒。

### B. 跨 cell 重声明

**推荐默认合同：**

- 不同 cell 之间允许重新声明已有的 top-level `var` / `let` / `const` / function / class 名称；模型不需要为避免重声明错误而换成 `var`、改名或 `js_reset`。
- 新 cell 完成提交后，后续 cell 使用该名字时应看到最新绑定。
- 同一 cell 内仍遵守正常 ECMAScript 静态语法；例如在同一 lexical scope 内重复声明 `let` / `const` 仍是语法错误。
- `js_reset` 仍清除全部 binding。运行错误、timeout/cancel 的现有 checkpoint / rollback 语义不被两项改造意外改变。

**用户已确认的细节：** 旧 cell 的 closure 在名称重声明后通过共享 live binding 观察最新值；重声明 `const` 是替换 session binding，而不是对旧 `const` 赋值。实现将 ref 的读写访问器、声明 kind 和 cell-entry/statement checkpoint 一起捕获恢复，避免 timeout/cancel/error 改坏旧引用。

## 4. 接管与实施阶段

### 阶段 0：固定基线（不改生产接线）

1. 已锁定 Qwen `0.1.6` package source revision `b7543aeb1bd58537a2216253e8ba5020d4814c9c`；未混入未发布 `0.1.7`。
2. 已导入 package source、tests、runtime assets/build setup，并保留 Apache-2.0 `LICENSE` 与 upstream copyright headers。
3. 已建立 [`packages/kernel-engine/UPSTREAM.md`](../packages/kernel-engine/UPSTREAM.md)，记录来源、包 identity、本地 patch ledger 与同步流程。
4. `pnpm run verify` 已全量通过：kernel 172 passed / 6 skipped、runtime 59、adapter 15、bootstrap 9（共 255 passed / 6 skipped）。其中一个 symlink-resolution fixture 仅在 Windows 明确缺少 symlink privilege 时 skip；这些结果会在当前提交分支上重新验证。

### 阶段 1：只接管源码

- 已将 Qwen engine 源码放入本仓库自有 `packages/kernel-engine`；`packages/runtime` 通过原 MCP compatibility entry 维持原有调用边界。
- 未混入 DSH ToolRuntime 权限改造、QuickJS Code Mode、Windows/SRT sandbox、UI/呈现重做或 Qwen desktop relay。
- 若当前 Qwen MCP server wrapper 暂时保留，只作为过渡兼容层；它不是本次长期 ownership 的边界。直接 `KernelHost` API、worker supervisor 和控制通道可另开后续阶段，避免与语义修复形成一个大 diff。

### 阶段 2：分别实现两个改造

1. **Patch A — statement-boundary commit（已实现）**：在 AST source-item 的生成 checkpoint 前加入显式分隔符；真实 kernel 测试覆盖换行 ASI、line/block comment、tagged template 和无尾分号 cell。没有直接 cherry-pick #12168。
2. **Patch B — redeclaration model（已实现）**：声明 checkpoint 对 stable binding reference 做 rebind；reference state 包含 getter/setter/kind/value，并在错误 checkpoint、timeout/cancel 入口捕获恢复。测试覆盖 `let`/`const`/`var`、function/class 替换、旧 closure 观察新值、同 cell duplicate lexical error 与 rollback。
3. 代码上两个变更保持不同区域与 patch ledger 记录；当前提交将源码接管与两项语义改造作为一个可整体审阅的工作包。

### 阶段 3：切换与清理

- 已将 runtime dependency 与 `KERNEL_PACKAGE` 切到本地 `@lyd123qw2008/node-repl-kernel-engine`；provider catalog、bridge、DSH 两工具面和兼容 MCP entry 保持不变。
- 已移除 runtime 对外部 `@qwen-code/node-repl-mcp` 的 package dependency；compatibility MCP wrapper 仍保留在自有包中。是否进一步改成 direct worker/control channel，仍需单独方案和测试。
- 已更新 `JS_TOOL_DESCRIPTION`：删除强制分号与 prefer-var workaround，保留 ASI、同 cell lexical error、const assignment 等真实限制。

## 5. 验收结果

`pnpm run verify` 已通过：kernel 172 passed / 6 skipped、runtime 59、adapter 15、bootstrap 9（共 255 passed / 6 skipped）。1 个 symlink-resolution fixture 因 Windows runner 的 symlink privilege 不足而明确 skip；其余 skipped 属于既有环境/可选能力测试。用例覆盖下列 ASI、binding、closure、rollback、reset 与整体回归要求。

### Snapshot / semicolon

- 多 cell 持久会话中，对表达式、`counter += 1`、`var`/`let`/`const` 声明、省略分号的 `await` 表达式和函数调用进行 parser-only 与真实 kernel 测试。
- 覆盖尾随 `//`、`/* ... */`、无末尾换行、字符串和 tagged template；转换前后可观察值一致，不能静默跳过 commit。
- 失败 cell 的绑定检查点、下一 cell 的状态、源码行号/错误定位均保持可解释。
- DSH 两工具描述与 kernel MCP server instructions 均不再要求模型显式添加分号。

### Redeclaration

- 跨 cell：`let x = 1` → `let x = 2`；`const x = ...` 重跑；同名 function/class 重定义；重复两次以上。
- 混合类型：先 `var` 再 `let`、先 `let` 再 `var`、`const` 再 `const`；明确预期成功/失败和诊断。
- closure：声明 helper → 重定义捕获名 → 验证 helper 看到的值符合 §3 选定合同。
- 同 cell 重复 lexical declaration 仍失败；块、loop、destructuring、多声明符按实际 JS 语义测试。
- cell 抛错/取消、reset、内核重启后，绑定提交/回滚/丢失行为与已有合同一致。
- DSH 两工具描述与 kernel MCP server instructions 均已移除“prefer var / 换名”的重声明 workaround。

### 整体回归

- 保留并运行 Qwen kernel 的 transform、cell-binding、module loader、output/protocol、kernel lifecycle/scale 测试。
- 运行本仓库 runtime、adapter、bootstrap 全部测试及真 MCP/provider 集成验证。
- 对比迁移前后：`js` / `js_reset` 工具 schema 不变，catalog/injection/reconnect/image 结果行为不退化。

## 6. 明确不在本次范围

> **与 docs/09 的关系：** 用户已决定 [sandbox 方案](09-dsh-sandbox-integration-plan.zh-CN.md)暂缓。本次已独立完成内核源码 ownership + 两项语义改造；不以前述 sandbox Phase 0 为前提。此决定不启用 sandbox、不作隔离/安全声明，也不使 docs/09 中已有的 Phase 0 历史证据失效。

- 不声称 Node REPL 变成安全沙箱；Node builtins、文件、网络和进程 authority 仍按受信任 Node 执行看待。
- 不启用或发布 `sandboxHost: 'required'`；现有 [sandbox 方案](09-dsh-sandbox-integration-plan.zh-CN.md) 的 backend × mode gates 独立处理。
- 不迁入 Qwen Computer Use SDK、browser/desktop relay、Qwen Code CLI/skill/UI。
- 不更改 DSH ToolRuntime 的审批、授权或审计架构；内核代码所有权本身不改变 `cap.*` 是否经过宿主工具管线。
- 不在本轮引入 QuickJS/Code Mode；以后可作为不同执行 backend 单独设计。

## 7. 确认记录

> **已确认：** docs/09 sandbox work 暂缓；本提案不实施 sandbox，也不作 sandbox readiness 或安全隔离声明。

- [x] 以已发布 `0.1.6` 对应源码作为 vendor 基线，并在本仓库维护 Apache-2.0 来源记录。
- [x] 两个 P0：无分号 cell 和跨 cell top-level 重声明。
- [x] closure 在 binding 重声明后看到新值。
- [x] 当前先覆盖已记录的声明重用语义；若后续发现额外的 `var` 失败形态，再补精确 cell 样例。简单跨 cell `var` 重声明目前已有通过测试。

---

## 参考

- 本仓库 [Qwen 复用实测](02-reuse-spike-results.zh-CN.md)
- 本仓库 [DSH adapter 的模型可见提示词](../packages/adapter-dsh/src/descriptions.ts)
- 本仓库 [当前 sandbox 实施提案](09-dsh-sandbox-integration-plan.zh-CN.md)
- Qwen [node-repl package](https://github.com/QwenLM/qwen-code/tree/main/packages/node-repl) 与 [npm registry](https://registry.npmjs.org/%40qwen-code%2Fnode-repl-mcp)
- Qwen [Issue #12167](https://github.com/QwenLM/qwen-code/issues/12167) / [PR #12168](https://github.com/QwenLM/qwen-code/pull/12168)
- Qwen [PR #9499：standalone persistent REPL](https://github.com/QwenLM/qwen-code/pull/9499)
