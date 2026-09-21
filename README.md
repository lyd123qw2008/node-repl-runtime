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
@qwen-code/node-repl-mcp   │          ← 常驻 JS kernel
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
| 测试 | **33 个** hermetic（18 runtime + 9 adapter + 6 bootstrap），无网络无 IDE |

复用内核的语义：持久 ✅、改值 ✅、函数持久 ✅、抛错检查点 ✅；**`let`/`const` 不能跨 cell 重声明（`var` 可以）**——这是对标 node_repl 时唯一的偏差，已写进 `js` 的描述引导模型。

## 文档

先读 **[`docs/01-prior-art-and-reuse.zh-CN.md`](docs/01-prior-art-and-reuse.zh-CN.md)**（现成方案、许可证、两半的缺口矩阵），再看 **[`docs/02-reuse-spike-results.zh-CN.md`](docs/02-reuse-spike-results.zh-CN.md)**（spike 实测与语义表），架构看 **[`docs/04-architecture.zh-CN.md`](docs/04-architecture.zh-CN.md)**，接入用 **[`docs/03-integration-spec.zh-CN.md`](docs/03-integration-spec.zh-CN.md)**。

```text
docs/01-prior-art-and-reuse.zh-CN.md     先验方案与复用决策（含实测证据与归类）
docs/02-reuse-spike-results.zh-CN.md     复用内核的 spike 结果（路径 A 已验证）
docs/03-integration-spec.zh-CN.md        接入规范 + 挂进 DSH profile 的方法
docs/04-architecture.zh-CN.md            组件边界、调用链与 provider 生命周期
docs/evidence/reuse-spike*.log           原始 spike 日志
spike/                                   最初的可行性 spike（保留为证据）
packages/runtime/                        宿主侧：目录桥 + MCP 目录 + inject + 内核管理 + CLI
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
