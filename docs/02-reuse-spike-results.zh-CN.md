# 复用内核的 spike 结果（路径 A 已验证）

> 状态：**实测完成，路径 A 可行。** 原始日志：`docs/evidence/reuse-spike.log`、`reuse-spike-first-run.log`。
> 代码：`spike/host.mjs`（宿主侧）、`spike/kernelroot/node_modules/nr-cap/index.mjs`（内核侧桥）。

## 0. 结论

**"复用内核 + 我们只写目录桥"这条路走通了，而且不需要 fork 内核。**

在真 IDEA MCP（2026.2.2，67 工具，`http://127.0.0.1:64342/stream`）上：

| 证据 | 实测 |
| --- | --- |
| provider 发现 | **67** 个工具 |
| 复用的内核工具面 | `node_repl`、`node_repl_wait`、`node_repl_cancel`、`node_repl_reset`、`node_repl_add_node_module_dir`（Qwen 的 5 个） |
| init cell | **206 ms**，`globalThis.cap` 就位 |
| **真实多步链** | **1,305 ms** → `{"hits":2,"more":true,"first":"src\\main\\java\\com\\montnets\\frame\\service\\impl\\MenuServiceImpl.java","problems":0,"modules":1}` |
| 该 cell 里有没有 `projectPath` | **没有。** 宿主注入，模型看不到也不需要传 |
| 模型可见 schema | `["q","paths","limit"]` —— **`projectPath` 已被剥掉** |
| 本地发现耗时 | **6 ms**（`cap.list()` / `cap.describe()` 走快照，不过桥） |
| 内核里可枚举 | `Object.keys(cap.idea).length === 69`（67 工具 + `list` + `describe`） |

## 1. 走通的桥设计

```text
宿主（我们）
 ├── 目录桥：TCP 127.0.0.1:随机端口 + 随机 token
 │     收到 {id, provider.operation, args} → 注入宿主常量 → MCP tools/call → 原样回传
 ├── MCP 客户端：streamable HTTP 连 IDEA，会话复用
 └── 内核：@qwen-code/node-repl-mcp（stdio 子进程，cwd = kernelroot）
         │
         └── 内核里 `await import('nr-cap')`  ← 裸包名，从 cwd/node_modules 解析
```

三个关键点，都是实测确定的：

1. **裸包名可解析**：把桥模块放在内核子进程的 `cwd/node_modules/nr-cap`，cell 里 `await import('nr-cap')` 就能加载。不需要 `node_repl_add_node_module_dir`。
2. **配置放在模块旁边，不放环境变量**：cell 看不到 `process`，而且被导入的模块不该依赖宿主怎么启动它。宿主在启动内核前把 `config.json`（endpoint/token/catalog 快照）写到桥模块目录旁。
3. **init cell 只用跑一次**：因为绑定持久，

   ```js
   globalThis.cap = (await import('nr-cap')).cap
   ```

   之后每个 cell 直接就有 `cap` —— **用内核自己的持久性把"每次都要 import"这件事消掉了**。

另外：桥里用**普通对象**而不是 Proxy 构建 `cap.idea.*`，所以 `Object.keys(cap.idea)` 能列出 67 个操作，模型可以自己探索。Proxy 会把这些藏起来。

## 2. 复用内核的语义（实测，不是读 README）

| 探针 | 结果 |
| --- | --- |
| `let counter = 1` | ✅ 持久 |
| `counter = counter + 1`（跨 cell 改值） | ✅ `counter=2` |
| **`let counter = 100`（跨 cell 重新声明 `let`）** | ❌ **`SyntaxError: Identifier 'counter' has already been declared`** |
| `function double(){}` | ✅ 持久 |
| 后续 cell 调用 `double(5)` | ✅ `10` |
| 抛错的 cell | ✅ 错误正常上抛 |
| **抛错前已声明的绑定** | ✅ `survived=yes`（检查点生效） |
| 抛错后 `cap` 仍可用 | ✅ `modules=1` |
| **`var v = 1` → `var v = 2`** | ✅ **可重声明** |
| `let L = 1` → `var L = 2` | ❌ `SyntaxError`（`var` 不能遮蔽已有 `let`） |
| `undeclared = 7`（隐式全局） | ❌ 抛错（不产生隐式全局） |

### 唯一的偏差：`let`/`const` 不能跨 cell 重声明

node_repl/Codex 的文档明确宣传 "Top-level bindings persist until `js_reset` and **can be redeclared**"。**复用的这个内核不满足这一条**——`var` 可以，`let`/`const` 不行。

这不是小事：迭代式 REPL 用法里，模型重跑一个 cell 时很自然会再写一次 `const hits = ...`，在 Codex 的 node_repl 里没问题，在这里是硬 `SyntaxError`。

三种处理，按代价排序：

| 方案 | 代价 | 说明 |
| --- | --- | --- |
| **(a) 写进工具描述引导模型**（已采用） | 零 | 明确告诉它："可能重新定义的用 `var`。`let`/`const` 每个名字只能声明一次；改值请直接赋值。" 因为 `var` 确实可重声明，这条引导是**充分**的 |
| (b) 宿主侧重试修复 | 小 | 捕获 `Identifier ... has already been declared`，用 transform 把顶层 `let`/`const` 改写成赋值后重试一次。**未采用**：选了 (a) 之后这条就没有触发场景了 |
| (c) fork 内核改 transform | 大 | 不必要 |

> 最初为 (b) 写过一个 transform（原 `packages/kernel/src/transform.ts`）。选定 (a) 之后它没有任何触发场景，属死代码，**已删除**——留着一个用不上的机制正是本项目反目标清单里禁止的事。

## 3. 这对计划的影响

- **路径 A 已验证，不需要 fork** → `packages/kernel/src/transform.ts` 继续只当 (b) 的备用件。
- **能复用的比预想更多**：内核的 5 个工具面可以直接就是我们工具面的一部分（`js` 系列），我们只需再加目录相关的 1–2 个。
- **`inject` 验证有效**：`projectPath` 从模型可见 schema 里消失、由宿主注入、模型提供即拒绝 —— 这条通用机制成立。
- **"零代码接入 MCP" 在 spike 里就是 6 行配置**（`PROVIDER_CONFIG` 里那一个对象）。

## 4. 尚未做的

1. 把 spike 产品化：`packages/runtime`（bridge server + MCP catalog + inject + kernel 管理）、`packages/adapter-dsh`（工具面）。
2. hermetic 测试（假 provider，不依赖 IDE）。
3. `integration:demo` CLI 与接入规范文档。
4. 决定 (a) 还是 (a)+(b) 处理重声明偏差。
5. 决定依赖 `@qwen-code/node-repl-mcp`（0.1.6）还是 vendor 其内核模块。
