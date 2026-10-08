# node-repl-runtime

一个 **node_repl 形状的能力运行时**：一个常驻 JS 内核，把任意 MCP 服务器当作能力目录注入进去。

```text
DSH 模型
 │  js / js_reset                     ← adapter 恒为两个工具
 ▼
node-repl-runtime-face                ← 注册 DSH 工具
 │  nodeReplRuntime
 ▼
CapabilityRuntime                     ← catalog + host bridge
 │                         ▲
 │                         │ tools/call
 ▼                         │
@lyd123qw2008/node-repl-kernel-engine │ ← 自有维护的常驻 JS kernel
 │  nr-cap / cap.*          │
 └────────── bridge ────────┘
              │
              ▼
外部 MCP provider（IDEA、Chrome、Cua、Blender……）
```

完整组件边界、provider 生命周期和调用路径见
[`docs/04-architecture.zh-CN.md`](docs/04-architecture.zh-CN.md)。

## 已实测

| 项 | 实测 |
| --- | --- |
| 模型可见工具 | **2**（`js` / `js_reset`），与接了几个 MCP、每个多少操作无关 |
| 两个工具的声明成本 | **约 592 tokens** |
| **真 IDEA 端到端**（67 工具，四步链） | **523 ms**，且 cell 里**没有 `projectPath`**（宿主注入） |
| 模型可见 schema | `["q","paths","limit"]` —— `projectPath` 已剥掉 |
| 本地发现（`capHelp()` / `cap.describe()`） | 6 ms，不过桥 |
| 会话失效恢复（服务端重启后忘记 session id） | 透明重连 + 重试一次；并发 10 个调用只重连 **1** 次 |
| 启动时不可达的 provider | spec 保留，`cap.reconnect(id)` 运行期接入（恰好 1 个新会话），不必重启宿主 |
| 测试 | **259 passed / 5 skipped**（kernel-engine 173 + runtime 62 + adapter 15 + bootstrap 9）；5 个是当前 Windows runner 无 symlink privilege 的 N-API fixture；无 IDE/外部服务依赖 |

内核源码已在 `packages/kernel-engine/` 接管并维护（Apache-2.0，Qwen `0.1.6` 基线）：支持普通 ASI/省略分号、跨 cell 重复声明顶层 `var`/`let`/`const`/function/class，并让旧 closure 观察最新 binding；同 cell lexical 重复声明与对当前 `const` 赋值仍遵守错误语义。

## 文档

先读 **[`docs/01-prior-art-and-reuse.zh-CN.md`](docs/01-prior-art-and-reuse.zh-CN.md)**（现成方案、许可证、两半的缺口矩阵），再看 **[`docs/02-reuse-spike-results.zh-CN.md`](docs/02-reuse-spike-results.zh-CN.md)**（spike 实测与语义表）；架构看 **[`docs/04-architecture.zh-CN.md`](docs/04-architecture.zh-CN.md)**，接管来源与 patch ledger 看 **[`docs/10-qwen-kernel-ownership-and-redeclaration-plan.zh-CN.md`](docs/10-qwen-kernel-ownership-and-redeclaration-plan.zh-CN.md)**，接入用 **[`docs/03-integration-spec.zh-CN.md`](docs/03-integration-spec.zh-CN.md)**。

```text
docs/01-prior-art-and-reuse.zh-CN.md     先验方案与复用决策（含实测证据与归类）
docs/02-reuse-spike-results.zh-CN.md     复用内核的 spike 结果（路径 A 已验证）
docs/03-integration-spec.zh-CN.md        接入规范 + 挂进 DSH profile 的方法
docs/04-architecture.zh-CN.md            组件边界、调用链与 provider 生命周期
docs/05-image-content-blocks.zh-CN.md    cell 与 provider 图片作为内容块的通路与预算
docs/06-kernel-boundaries.zh-CN.md       内核边界**决定记录**：不做 GC / 不自动回收 / 不设天花板及其理由
docs/07-codemode-ptc-and-kernel-lifetime.zh-CN.md  Code Mode / DSH PTC / 内核寿命的三方对照实测
docs/08-mcp-session-recovery.zh-CN.md    provider 会话失效（404 / 传输层死亡）与自动恢复
docs/10-qwen-kernel-ownership-and-redeclaration-plan.zh-CN.md  Qwen 内核接管基线与语义 patch ledger
docs/evidence/reuse-spike*.log           原始 spike 日志
spike/                                   最初的可行性 spike（保留为证据）
packages/runtime/                        宿主侧：目录桥 + MCP 目录 + inject + 内核管理 + CLI
packages/kernel-engine/                  自有维护的 Qwen-derived Apache-2.0 kernel 与 upstream patch ledger
packages/runtime/assets/nr-cap/          内核侧桥模块（`cap.*` 命名空间）
packages/adapter-dsh/                    DSH 工具面：js + js_reset
packages/dsh-bootstrap/                  提供 `nodeReplRuntime` service 的 Cordis 插件
profiles/dsh-node-repl/                  隔离 profile + 挂到真实 profile 的步骤
```

## 快速验证

```bash
corepack pnpm install
corepack pnpm run verify

# 接任意 MCP 服务器（无需写任何 provider 代码）
node packages/runtime/dist/cli.js --id idea --url http://127.0.0.1:64342/stream \
  --inject projectPath=D:/path/to/project \
  --code-file packages/runtime/examples/demo-cell.js
```

挂进 DSH profile（隔离实例，或你自己真实的 profile）：
[`profiles/dsh-node-repl/README.zh-CN.md`](profiles/dsh-node-repl/README.zh-CN.md)。

接入一个 MCP provider 只是在 Profile 的 `node-repl-runtime-bootstrap` 配置里新增一项；**runtime、adapter 和 bootstrap 三个 npm 包不依赖该 provider 的 npm 包**。例如 Chrome provider 只启动已安装的 `pi-control-chrome` MCP adapter，IDEA provider 只连 IDEA 已开启的 MCP endpoint——Profile 决定其命令、URL 和本地版本，运行时不引入 provider-specific dependency。

## 复用清单

**不自己写**：JS transform / 解析器、内核子进程与协议、绑定检查点与取消回滚、MCP 客户端与会话恢复、隔离运行时。

**只写缺的**：能力目录桥（`cap.*` 注入内核）、宿主常量参数注入、两个工具的面、hermetic 测试、接入规范。
