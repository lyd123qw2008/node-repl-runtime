# 先验方案与复用决策（node_repl-runtime 的立项依据）

> 状态：**待评审。** 本文决定新项目的架构走向：哪些不自己造、哪些确实是我们的。
> 所有"实测"标注项都是我在本机跑出来的；"仅阅读"标注项来自一手资料（README / 官方文档 / 包内容）；"未核实"标注项来自搜索摘要，**未经验证，不要据此决策**。

## 0. 结论

我们本来准备造**两个轮子**，而**两个轮子都已经存在**，各自覆盖一半：

1. **持久 JS 内核**（top-level await、绑定跨调用存活、可重声明、取消/重置）→ Qwen 已做成可复用实现；Codex 已开源文档化的语义规格。
2. **把工具目录投影成代码命名空间**（一个执行工具代替几百个工具声明）→ 这是已成型的行业模式 **"Code Mode"**，UTCP 已做成库 + MCP server + CLI，**且我已用它在真 IDEA MCP 上跑通 4 调用链**。

**但是：没有任何一个现成项目同时具备这两半。** 我们的框架 = 持久内核 + MCP 目录命名空间，这个组合确实是空的。所以结论不是"别做了"，而是**只做缺的那一块，其余全部复用**。

---

## 1. 我们原本的计划 vs 现成方案

| 我原计划自己写的 | 现成的东西 | 结论 |
| --- | --- | --- |
| `transform.ts`：解析 JS、把顶层声明提升为可重声明绑定 | Qwen `cell-transform.ts`（26 KB，tree-sitter WASM 解析）；Codex 内嵌 meriyah | **不写** |
| 子进程 + NDJSON 协议 + 生命周期 | Qwen `kernel-manager.ts`（36 KB）+ `protocol.ts`（5 KB） | **不写** |
| 出错后绑定检查点 / 取消后回滚 | Qwen `cell-bindings.ts`（10 KB）+ 其 README 明文规则 | **不写** |
| MCP 客户端 + 会话复用/恢复 + 传输 | `@modelcontextprotocol/client`；UTCP `@utcp/mcp`（stdio + **http** 双传输） | **不写** |
| 工具 → 代码命名空间投影 + 渐进发现 + TS 接口 | UTCP `@utcp/code-mode` | **不写** |
| 隔离 | `isolated-vm`（code-mode 已依赖） | **不写** |
| **能力目录桥（`cap.*` 注入内核）** | **无** | **我们写** |
| **宿主常量参数注入**（如 `projectPath`） | **无** | **我们写** |
| **DSH adapter / 工具面** | 无 | **我们写** |

---

## 2. 已存在的轮子（含证据）

### 2.1 Codex `js_repl` —— 语义规格的一手来源

`openai/codex` 的 `docs/js_repl.md`（现已被 Rust 实现取代：仓库内有 `codex-rs/core/src/tools/js_repl/`、`guardian_node_repl_policy.rs`）。**仅阅读**（该文档已从 main 移除，我从 commit `8791f0a` 取到原文）。

关键内容，直接决定我们的语义目标：

- "`js_repl` runs JavaScript in a **persistent Node-backed kernel** with top-level `await`."
- **`js_repl_tools_only`**：开启后**模型的直接工具调用只剩 `js_repl` 和 `js_repl_reset`，其余工具全部通过内核里的 `codex.tool(...)` 访问**。——**这就是我们框架的主张，由上游实现并验证过。**
- 内核里暴露的宿主 API：`codex.cwd` / `homeDir` / `tmpDir` / **`codex.tool(name, args)`** / `codex.emitImage()`。
- **"nested `codex.tool(...)` outputs stay inside JavaScript unless you emit them explicitly"** ——嵌套调用结果默认不进模型上下文，只有显式 emit 才出去。**这正好是旧项目里结果预算问题的正解。**
- 传输："the kernel uses a **JSON-line transport over stdio**"。（我的设计假设与之一致。）
- 出错单元（failed cell）的恢复语义有**很长的边界清单**：支持"声明前直接写 `x = 1` / `x += 1` / `x++`"、非空顶层 `for...in`/`for...of`；**不支持**声明前读 hoisted function、别名/IIFE 推断、嵌套块内写、hoisted `var` 的解构恢复等。→ 说明这层"值多少钱"，也说明别自己写。
- 解析器：`codex-rs/core/src/tools/js_repl/meriyah.umd.min.js`（vendored `meriyah@7.0.0`）。**它也是用真解析器，不写正则。**
- 超时用源码首行 pragma：`// codex-js-repl: timeout_ms=15000`。
- 模块解析顺序：`CODEX_JS_REPL_NODE_MODULE_DIRS` → 配置数组 → 线程 cwd。bare import 用 REPL 级搜索路径，不相对导入文件解析。

> 我 2026-09-18 实际探测的 `node_repl.exe`（`rmcp 1.5.0`）工具面是 4 个：`js`（`{code, timeout_ms?, title?}`）、`js_add_node_module_dir`、`js_reset`、`turn_ended`。**实测项。** 它的 `nodeRepl.write` / `emitImage` / `cwd` / `homeDir` / `tmpDir` / `requestMeta` 与文档一致，只是 API 对象名从 `codex` 变成了 `nodeRepl`。

### 2.2 Qwen `@qwen-code/node-repl-mcp` —— 内核的可复用实现

- npm `@qwen-code/node-repl-mcp` v0.1.5，**Apache-2.0**，发布于 **2026-09-18**（今天）。**实测项**（registry 查询）。
- 独立 MCP server（5 工具：`node_repl` / `node_repl_wait` / `node_repl_cancel` / `node_repl_reset` / `node_repl_add_node_module_dir`），**子进程里跑真 Node 内核**。
- 语义（**仅阅读** 其 README）：显式输出（`nodeRepl.write` / `emitImage`，`console.*` 被捕获，**朴素表达式结果不返回**）；绑定跨 cell 存活且**可替换后仍被闭包读到**；禁止顶层静态 import；除 `process`/`node:process` 外 builtin 可导入；**超时/取消只终止当前 cell，已有绑定与内核进程保留，被取消 cell 的新绑定不提交**；取消后 5 秒不响应则杀掉内核并报告绑定丢失；**运行错误保留已完成语句的检查点，取消/超时把绑定恢复到 cell 入口值**（对象变更与外部副作用不回滚）。
- 它明确写：**"VM context provides lifecycle/namespace isolation, not an OS security sandbox"**。——和我们该有的诚实说法一致。
- `src` 结构（**实测**，GitHub API）：`cell-transform.ts` 26 KB、`kernel-manager.ts` 36 KB、`cell-bindings.ts` 10 KB、`protocol.ts` 5 KB、`output-adapter.ts` 11 KB、`security-policy.ts` 2.5 KB、`mcp-server.ts` 17 KB；测试 `kernel-manager.test.ts` 59 KB、`node-repl.semantics.test.ts` 19 KB。
- **关键限制（实测）**：`package.json` 的 `exports` **只暴露 `.` → `dist/index.js`（MCP server 入口）**。内核模块虽然随包发布（`dist/kernel-manager.js` 等），但**不在官方导出面内**；`dist/runtime/` 还带一个 **647 KB 的 `tree-sitter-javascript.wasm`**（说明它用 tree-sitter 解析，不是正则）。
- 依赖它的内核 = 用未导出的内部路径（脆弱）或**把内核模块 vendor 进来**（Apache-2.0 允许，需署名）。

### 2.3 UTCP `@utcp/code-mode` —— "Code Mode" 那一半的成熟实现

- npm `@utcp/code-mode` v1.2.13，**MPL-2.0**，2026-08-25；`@utcp/mcp` v1.2.0 **MPL-2.0**，2026-09-15；`@utcp/code-mode-mcp` v1.2.1 **MIT**。**实测项**。
- `@utcp/mcp` 的 README（**仅阅读**，就在 `node_modules` 里）：**同时支持 `stdio` 与 `http`（streamable HTTP）**，带会话复用与自动恢复、OAuth2、`register_resources_as_tools`、`$defs` 解析。
- `@utcp/code-mode` 的 README 自称："**Instead of exposing hundreds of tools directly, give them ONE tool that executes TypeScript code with access to your entire toolkit**"，并引用 Cloudflare 的 Code Mode 白皮书与 Anthropic 的 code-execution-with-MCP 文章（**未核实**：那两篇原文我没读）。

#### 我对真 IDEA MCP 的实测（这是本节最重要的部分）

在 `D:\temp\code-mode-probe` 用 `@utcp/code-mode` + `@utcp/mcp` 直连 `http://127.0.0.1:64342/stream`：

| 观测 | 结果 |
| --- | --- |
| 发现 | `Discovered 67 tools from server 'idea'`，注册成功 |
| 渐进发现 | `searchTools('search text in project')` → 67 个里返回 10 个相关工具 |
| 隔离 | 错误栈显示 `<isolated-vm>`；`pnpm` 忽略了 `isolated-vm` 的 build script 但仍可用 |
| **真实 4 调用链** | `search_text` → `get_file_problems` → `get_project_modules` → `get_project_dependencies`，**5,111 ms 成功**，返回值 `{hits:2, more:true, first:"src\\main\\java\\...PaymentsConfig.java", problems:0, modules:1, dependencies:204}` |
| 会话复用 | 日志逐次显示 `Reusing existing MCP session` |
| 沙箱内处理 | `console.log` 被捕获进 `logs`，只有 `return` 的摘要离开内核 |
| 命名约定 | 沙箱内是 `idea.idea_search_text(...)`（命名空间 = manual 名，成员 = `<server>_<tool>`） |
| **绑定持久性** | ❌ **不持久。** 连续 cell 实测：`let n = 41` 后读 `n` → `"GONE"`；`globalThis.__probe` → `"GONE"`；抛错前的 `before` → `"GONE"`；真实调用后写的 `globalThis.modCount` → `"GONE"`。**每个 cell 是全新 isolate。** |
| 宿主参数注入 | ❌ 无。生成的 TS 接口里 `projectPath` 是普通参数，**模型必须每次传**。 |
| 生命周期 | 必须显式 `client.close()`，否则进程挂住（我第一次探针就是这么超时的） |

---

## 3. 谁有哪一半

| 能力 | `@utcp/code-mode` | Qwen `node-repl-mcp` | Codex `js_repl` |
| --- | --- | --- | --- |
| 绑定跨调用持久 | ❌ | ✅ | ✅ |
| 可重声明 / 冲突不炸 | n/a | ✅ | ✅ |
| top-level await | ✅（单 cell 内） | ✅ | ✅ |
| 出错后检查点恢复 | ❌ | ✅ | ✅（有边界清单） |
| 取消 / 等待 / 重置 | 仅超时 | ✅ wait/cancel/reset | ✅ reset |
| **工具目录 → 代码命名空间** | ✅（全部意义所在） | ❌（只有 npm 包） | ✅ 但仅限 Codex 自家工具 |
| **任意 MCP 服务器零代码接入** | ✅（stdio + http） | n/a | 部分（`codex.tool` 面向 Codex 工具） |
| 渐进发现 / TS 接口 | ✅ | n/a | ❌ |
| 许可证 | MPL-2.0 | **Apache-2.0** | Apache-2.0（但集成在 Codex 内部，不可复用） |
| 可复用性 | ✅ 库 + MCP server + CLI | 内核模块**未导出**，需 vendor | ❌ 不可复用 |

**结论：`@utcp/code-mode` 缺持久内核；Qwen 缺目录桥；Codex 两样都有但拿不出来。**

---

## 4. 三条路径

### 路径 A（推荐）：内核用 Qwen，目录桥我们写

```text
DSH / 宿主
  │  js / js_reset / capability_catalog / capability_status
  ▼
我们的 runtime（薄）
  ├── 目录桥：cap.* → MCP tools/call（会话复用、inject、失败分类）
  └── 内核：@qwen-code/node-repl-mcp 子进程（持久绑定、取消、重置）
```

**`cap` 怎么进内核**：Qwen 内核允许 `await import('bare-package')`，且支持 `node_repl_add_node_module_dir` 注册 `node_modules` 目录、内核继承服务器 env。所以我们做一个**桥接包**：内核里 `await import('nr-cap')` → 通过环境变量给出的 socket 连回我们宿主 → 宿主转发到 MCP。**并且**因为绑定持久，启动时先跑一个 init cell：

```js
globalThis.cap = (await import('nr-cap')).cap
```

之后每个 cell 直接 `await cap.idea.searchText({...})` 就有了 —— **用持久性把"要 import"这件事消掉**。

- 我们写的量：桥接包（内核侧）+ 宿主侧桥服务 + MCP 目录 + inject + DSH adapter。**几百行量级。**
- 风险：依赖一个**今天刚发布的 0.1.5** 包；socket 通道要设计；若其 `security-policy.ts` 挡住我们需要的 import 路径就麻烦。

### 路径 B（自持）：内核自己写

用 acorn/tree-sitter 做 transform，照 Codex 文档的语义实现持久 + 可重声明 + 重置。**代价**：Qwen 那 ~90 KB 内核 + ~100 KB 测试的活要重做，且 Codex 列出的出错恢复边界清单会是一段长期尾巴。
**只有在路径 A 的 spike 失败时才选它。**

### 路径 C（不推荐）：直接用 `@utcp/code-mode` 当引擎

目录那一半白拿，但**没有持久内核**——而持久内核正是我们要对标 node_repl 的定义性属性。等于买到一半。

---

## 5. 待你决定

1. **走路径 A 吗？**（内核复用 Qwen，我们只写目录桥 + inject + adapter）——我建议先做一个**两小时的 spike**：桥接包 + init cell，在真 IDEA 上跑到 `cap.idea.searchText(...)` 成功；跑通再定。
2. **是否接受依赖 0.1.5 的第三方内核**，还是宁可 vendor 内核源码进我们仓库（Apache-2.0 可，需署名）？我倾向**先 spike，跑通后 vendor**——避免被 0.1.x 的 breaking change 拖住，同时保留升级路径。
3. **MPL-2.0 相关**：若将来要参考/改动 `@utcp/code-mode`，MPL 是**文件级** copyleft，改动其文件需回馈。只当依赖用则无碍。要不要把它列进"只依赖、不 fork"的清单？

---

## 6. 归类诚实声明

- **实测**：`@utcp/code-mode` 对真 IDEA 的全部行为（发现 67、渐进发现、4 调用链 5.1s、会话复用、持久性 ❌、注入 ❌、必须 close）；`node_repl.exe` 的 4 工具面与其 schema；两个包的版本/许可证/发布日；Qwen 包 `exports` 只暴露 server 入口、其 `dist` 文件清单与 tree-sitter wasm。
- **仅阅读（一手）**：Codex `docs/js_repl.md`（commit `8791f0a`）；Qwen README 的语义规则；`@utcp/mcp` README 的传输支持。
- **未核实（搜索摘要，勿据此决策）**：`mcpcodeserver`、`mcp-v8` / `r33drichards/mcp-js`、`tool-sandbox-mcp`、`node-code-sandbox-mcp`、`repl-sandbox`、`isolated-vm` 的具体能力；"Code Mode 比传统工具调用快 67–88%"那组基准数据。
