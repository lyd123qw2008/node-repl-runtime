# 接入规范：把一个 MCP 服务器接进来

> 目标：**接入一个 MCP 服务器 = 一份配置，零 provider 专属代码。**
> 本规范不含"安全策略"章节，因为那不是接入方的事——见 §4。

## 1. 最短路径

```bash
node packages/runtime/dist/cli.js \
  --id idea \
  --url http://127.0.0.1:64342/stream \
  --inject projectPath=D:/path/to/project \
  --code-file packages/runtime/examples/demo-cell.js
```

实测输出（真 IntelliJ IDEA MCP 2026.2.2）：

```text
provider idea (IntelliJ IDEA) — 67 operation(s)
  host-owned, hidden from the model: projectPath

cell status: ok (523ms)
{
  "hits": 2, "more": true,
  "first": "src\\main\\java\\com\\montnets\\modules\\acct\\controller\\RcsApiAcctController.java",
  "problems": 0, "modules": 1
}
```

**没有写任何 provider 专属文件。** 这个命令本身就是全部适配器。省略 `--code-file` 则打印目录（发现步骤）。

## 2. 配置字段

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `id` | ✅ | 模型用的命名空间：`cap.<id>.<operation>` |
| `transport` | ✅ | `streamable-http`（配 `url`）或 `stdio`（配 `command`/`args`/`cwd`/`env`） |
| `label` | | 展示用名称 |
| `inject` | | **宿主拥有的常量参数**，见 §3 |
| `include` | | 可选的暴露收窄：匹配工具名的正则数组；`null`（默认）= 全部暴露 |

写在 JSON 里用 `--config <file.json>`，形状是 `{ "providers": [ {...} ] }`。

框架对每个 MCP 服务器的处理（全部机械，无分支）：

| 步骤 | 行为 |
| --- | --- |
| 发现 | `tools/list` → operations；`id` = 服务器自己的工具名；group = 名字首段 |
| 输入 schema | 服务器 schema **剔除 `inject` 的键**，envelope 收紧为 `additionalProperties: false` |
| safety | `readOnlyHint: true` → `read`，其余 → `mutate`。**仅展示，不做门禁** |
| 调用 | `tools/call`，参数 = 模型参数 + 注入常量；模型提供注入键 → 报错拒绝 |
| 结果 | **原样透传**；不改写、不截断、不回填 |

没有提交的 schema artifact、没有审查清单、没有 digest、没有漂移门禁。服务器这次广告什么，模型这次就能调什么——这就是 node_repl 的行为。

## 3. `inject`：宿主拥有的常量参数

用于"该由宿主决定、模型不该看到也不该改"的参数。典型是项目和账户。

- 它们从**模型可见的 input schema 里被删除**（实测：`search_text` 的模型可见属性是 `["q","paths","limit"]`，没有 `projectPath`）；
- 宿主在调用前合并进参数；
- **模型若自己传，报错而不是静默覆盖**：

  ```
  projectPath is host-owned and may not be supplied by the caller
  ```

这条是通用的：`projectPath` 只是它的第一个用户。

## 4. 你**不要**在接入里实现的东西

| 不要实现 | 为什么 |
| --- | --- |
| 确认 / 授权 / Brave Mode 之类 | 那是服务器自己的行为；框架只透传超时与错误，不发明闸门 |
| 权限、租约、凭据、脱敏 | 同上——凭据归属由服务器负责，框架绝不改写结果 |
| 项目身份校验 | 服务器自己知道它有哪些项目/目标；不匹配时它自己报错 |
| 能力清单 / 审查清单 | 框架从 live `tools/list` 投影，不需要你维护第二份表 |
| 工具 schema 的转写 | 服务器 schema 被直接采用，只做删键与收紧 |

判断标准：**一个改动如果换掉 provider 就作废，它大概率不该在这里。**

## 5. 模型看到什么

恒为**两个**工具，与接了几个 MCP 服务器、每个有多少操作无关：

```text
js         在常驻内核里跑 JavaScript，顶层 await
js_reset   清空内核绑定（目录会立刻重新装好）
```

实测声明成本 **约 695 tokens**（DSH 自己的长度启发式 `ceil(chars/4)+4`），与背后 67 个操作无关。

因为只有两个工具，**`js` 的描述就是 API 文档**——它必须交代清楚：`cap` 已装好、怎么发现（`capHelp()` / `cap.<p>.<op>` / `cap.describe()`）、输出必须 `nodeRepl.write`、绑定规则、以及 host-owned 参数不许传。改动 `packages/adapter-dsh/src/descriptions.ts` 等于改接口，`tests/face.test.ts` 会守住这些句子。

### 发现面的完整形状

`cap.describe(op)` 同时给出**入参**与（服务器声明了的话）**返回结构**：

| 字段 | 来源 | 缺省时意味着 |
| --- | --- | --- |
| `inputSchema` | 服务器的 `inputSchema`，减去 `inject` 的键 | 服务器没声明入参（罕见） |
| `outputSchema` | 服务器的 `outputSchema`，**逐字转发** | 该操作以 content block（文本）作答，而非结构化数据 |
| `safety` | 服务器的 `readOnlyHint` | 未标注 → 记为 `mutate`（只作参考，从不作为门禁） |

这一条是**真实使用中发现的缺口**：最初只投影了 `inputSchema`，于是 cell 作者只能靠猜返回结构——实测对着 IDEA 服务器猜 `search_file` 的返回键，`files`/`results`/`matches` 全错，真名是 `items`。而 IDEA 的 **67 个工具里有 42 个本来就声明了 `outputSchema`**（`lint_files` 的声明里连 `required:["filePath"]` 都有）。把服务器已经写好的契约丢掉，等于把声明变成猜谜——所以修法是转发它，而不是替它编一份文档。

## 6. 内核语义（复用来的，实测）

| 行为 | 结果 |
| --- | --- |
| 绑定跨调用存活 | ✅ |
| 跨调用改值 | ✅ |
| `var` 重新声明 | ✅ |
| **`let`/`const` 重新声明** | ❌ `SyntaxError: Identifier 'x' has already been declared` |
| 函数声明跨调用 | ✅ |
| 抛错的 cell | 错误上抛；**抛错前已声明的绑定保留** |
| `js_reset` | 清空绑定，目录自动重装 |
| cell 输出 | **只属于产生它的那次调用**，不累积 |
| 静态顶层 `import` | ❌；用 `await import()` |
| `process` | 不可见 |

`let`/`const` 那条是对标 node_repl 时**唯一的偏差**（Codex 的文档说可重声明），所以 `js` 的描述里明确要求"可能重新定义的名字用 `var`"。指引是充分的，因为 `var` 确实可重声明。

## 7. 自检清单

接入一个 MCP 服务器后，确认：

- [ ] `--code-file` 跑一次，`cell status: ok`；
- [ ] 打印的 operation 数与你对该服务器的预期一致；
- [ ] `nodeRepl.write(capHelp("<id>"))` 能列出操作；
- [ ] `inject` 的键**没有**出现在模型可见 schema 里；
- [ ] 故意传一次 `inject` 的键，得到 host-owned 报错而不是静默覆盖；
- [ ] 没有新增任何 provider 专属源文件——如果加了，先回看 §4。

## 8. 挂进 DSH profile

两个插件，缺一不可：

| 插件 | 作用 |
| --- | --- |
| `@lyd123qw2008/node-repl-dsh-bootstrap` | 读配置、连 MCP、起内核、`provide('nodeReplRuntime')` |
| `@lyd123qw2008/node-repl-dsh-adapter` | `inject: ['tools','nodeReplRuntime']`，注册 `js` / `js_reset` |

**只装 adapter 不够**：没有 bootstrap 提供 `nodeReplRuntime`，adapter 会一直 pending，一个工具都不注册（`tests/composition.test.ts` 守着这个行为）。

配置来源（按优先级）：`config.providers` → `NODE_REPL_PROVIDERS`（内联 JSON）→ `NODE_REPL_PROVIDERS_FILE`（文件路径）。**三者都没有则加载失败**，不会起一个没有能力的空壳。

隔离实例的完整步骤、以及"挂到自己真实 profile"的 patch 片段与回滚方法，见
[`../profiles/dsh-node-repl/README.zh-CN.md`](../profiles/dsh-node-repl/README.zh-CN.md)。

## 9. 当前边界（诚实声明）

- **内核是依赖来的**：`@qwen-code/node-repl-mcp`（Apache-2.0，0.1.x）。5 个工具里我们用到 `node_repl` / `node_repl_wait` / `node_repl_cancel` / `node_repl_reset`；`add_node_module_dir` 未暴露（长操作靠预算兜底）。模型面上仍然只有两个工具——wait/cancel 由运行时自己调用，不是模型的选择。
- **内核不发 `structuredContent`**：它把 5 态状态编码进 `isError` + **文本前缀** `[node_repl <status>] …`（其 `output-adapter.js` 原话："Preserve the 5-way status that MCP's boolean isError would otherwise lose"）。运行时**必须解析这个前缀**：只看 `isError` 会把内核超时报成普通 `error`，而且下面那条"放弃即取消"的规则会因此**不触发**（实测踩过一次）。相关：`node_repl` 默认 `yield_time_ms=10000`，超时先交还控制权（纯文本 + cell id），要用 `node_repl_wait` 收尾；`node_repl_reset` 在 cell 活跃时**直接拒绝**，必须先 `node_repl_cancel`。
- **cell 被放弃（timeout / cancelled / crashed / running）时必须取消在途的 provider 调用**。只停止等待不够：请求留在飞行中，对**按会话串行**的 provider（浏览器 bridge 就是）会把该会话后续所有调用堵在它后面 —— 实测一个滞留请求把整个会话的页面读取锁死，只能靠回收会话恢复。实现：`bridge.abandonInFlight()` 中止对应请求（经 SDK 发出 MCP cancellation 通知，支持取消的 provider 会真正停下），每个请求同时绑定到发起它的 socket，内核进程消失时一并中止；因此 `ProviderConnection.call` 带一个可选 `AbortSignal`。`ok`/`error` 结束的 cell **不**触发放弃 —— 它们可能故意发了不等结果的调用。
- **这个内核要求顶层语句显式写 `;`（注入的快照代码没有前导分隔符）**。已在 GH 源码层面核对（`QwenLM/qwen-code` `packages/node-repl`，`main` 的版本号就是 `0.1.6`，且 `src/runtime/*.mjs` 与安装的 dist **字节级一致**）。两处独立的成因：

  1. **语句边界注入没有前导分隔符（最常见的触发）**：`snapshotAssignments()`（`cell-transform.ts` L338-360）生成的是 `X_snapshot["name"] = {...};`，被插到每条语句的 `endIndex`。只要 `activeBindings` 非空它就非空——而**上一个 cell 的绑定会被继承**，所以除第一个 cell 外几乎总是如此。前一条语句若没有 `;`，快照标识符就直接粘在它后面：`nodeRepl.write('hi')__qwen_repl_1_0__snapshot["installed"] = {...};` → `SyntaxError`。
  2. **同一偏移的两段注入粘连**：顶层 `var`/`let`/`const` 声明末尾无 `;` 时，声明级标记（`snapshotDeclarator()` L362-380，以 `, ` 开头）与语句级 commit 落在**同一 `endIndex`**，稳定排序把前者放前，于是 `...(undefined)__qwen_repl_..._snapshot[...]`。这一条在**空内核**里也会触发。

  复现（`node --experimental-vm-modules`，直接喂 `prepareNodeReplCell()` 的输出给 `vm.SourceTextModule`）：

  | cell | 空内核 | 有继承绑定 |
  | --- | --- | --- |
  | 无声明 + 缺 `;` | ✅ 接受 | ❌ 拒绝 |
  | 顶层声明 + 缺 `;` | ❌ 拒绝 | ❌ 拒绝 |
  | 任意 + 有 `;` | ✅ | ✅ |

  上游修复只需一个字符：让 `snapshotAssignments()` 返回 `';' + assignments.join('')`（语句边界上的多余 `;` 无害，且两种情况会同时被修好）。**我们没有 patch 上游**：处理是描述里如实告知，而不是在 facade 里改写用户代码或给依赖打补丁。`js` 的描述写明规则并把 `__qwen_repl_..._snapshot` 这个错误签名一起给出，便于模型自我纠正。
- **不是安全沙箱**：`vm`/isolate 提供的是生命周期与命名空间隔离。被导入的包与 Node 内建拥有普通 Node 权限。授予谁使用要按这个前提判断。
- **`include` 是收窄而非审查**：它只按名字过滤，没有"批准"语义。
- **cell 里只有 Node 内建，没有 npm 包**（实测）：

  | 导入 | 结果 |
  | --- | --- |
  | `node:path` / `node:fs` / `node:crypto` | ✅ |
  | `zod` / `@modelcontextprotocol/client` / `playwright` | ❌ `cannot resolve package 'x' from 1 module roots` |

  原因：内核的工作目录是一个只放了 `nr-cap` 的临时 kernel root。这对我们的主用途（驱动 MCP）**不构成缺口**——能力就是 `cap.*`，处理结果是 JSON 与内置模块足够。若某个部署确实需要额外的包，正确做法是**宿主在启动时注册 module root**，而不是给模型一个自己放宽解析范围的工具。

### 为什么没有 Codex 的那两个额外工具

Codex 的 `node_repl.exe` 有 4 个工具（多出 `js_add_node_module_dir` 与 `turn_ended`）；但 Codex 文档里的 **`js_repl` 特性面本身就只暴露 `js_repl` 和 `js_repl_reset`**（其余工具走内核里的 `codex.tool(...)`）。我们对齐的是后者。

| 工具 | 我们的结论 |
| --- | --- |
| `js_add_node_module_dir` | **不暴露。** 它让模型自行放宽模块解析范围，而按 §4 的原则这类决定归宿主。真正需要额外包时由宿主注册 module root，模型面仍是 2 个工具。 |
| `turn_ended` | **不需要。** 它服务于 Codex 的 "trusted libraries + turn 生命周期" 子系统（Qwen 的移植版明确移除了这一层）。我们没有内核侧订阅者，加了就是一个没有消费方的工具。 |
