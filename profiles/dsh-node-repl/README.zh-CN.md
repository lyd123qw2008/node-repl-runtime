# Isolated DSH profile：两个工具的 node_repl 面

> 这个 profile 用来在**隔离实例**里看模型可见的工具面是不是恰好 `js` + `js_reset`，以及背后能不能驱动真实 MCP 服务器。它不碰你正在用的 profile。

## 为什么需要两个插件

| 插件 | 作用 |
| --- | --- |
| `@lyd123qw2008/node-repl-dsh-bootstrap` | 读配置、连 MCP、起内核、`provide('nodeReplRuntime')` |
| `@lyd123qw2008/node-repl-dsh-adapter` | `inject: ['tools','nodeReplRuntime']`，注册 `js` / `js_reset` |

**只装 adapter 不够**：它声明依赖 `nodeReplRuntime` 这个 service，没有 bootstrap 提供它就永远处于 pending，一个工具都不会注册（有测试守着这个行为）。

> 下文出现的 `<path-to-this-repo>` 与 `<path-to-dsh-checkout>` 是**占位符**：前者指本仓库在你机器上的位置，后者指你的 DeepSeek Harness checkout。照抄时换成实际路径。

## 隔离启动

```powershell
$home2 = 'D:\temp\nr-dsh-home'
$profile = Join-Path $home2 'profiles\acr-node-repl'
New-Item -ItemType Directory -Force (Split-Path -Parent $profile) | Out-Null
Copy-Item -Recurse '<path-to-this-repo>\profiles\dsh-node-repl' $profile
corepack pnpm --dir $profile install

# provider 配置是机器本地的，所以放环境变量、不进仓库
@'
{ "providers": [ { "id": "idea", "label": "IntelliJ IDEA",
  "transport": "streamable-http", "url": "http://127.0.0.1:64342/stream",
  "inject": { "projectPath": "D:/path/to/an/open/project" } } ] }
'@ | Set-Content (Join-Path $home2 'providers.json')

$env:DSH_HOME = $home2
$env:NODE_REPL_PROVIDERS_FILE = (Join-Path $home2 'providers.json')
node '<path-to-dsh-checkout>\apps\cli\lib\bin.js' --profile acr-node-repl --no-open --port 3099
```

启动日志里应出现一行自证：

```text
[node-repl-runtime] mounted idea=67 | host-owned args injected: projectPath
```

**没有这行**，说明 bootstrap 没跑起来；如果看到 `entries did not activate`，看它给的错误——配置缺失时会**明确抛错**而不是起一个没有能力的空壳。

## 挂到你自己真实的 profile

不要用 bundle（会和 profile 自己的 patch 抢同一个 id）。改成显式插入两个插件，配置直接写在 profile 的 patch 里：

**1. profile 的 `package.json`**

```jsonc
{
  "dependencies": {
    "@lyd123qw2008/node-repl-dsh-bootstrap": "link:<path-to-this-repo>/packages/dsh-bootstrap",
    "@lyd123qw2008/node-repl-dsh-adapter": "link:<path-to-this-repo>/packages/adapter-dsh"
  }
}
```

`corepack pnpm --dir <你的 profile 目录> install`

**2. profile 的 `cordis.patch.yml`**

```yaml
- insert:
    - id: node-repl-runtime-bootstrap
      name: '@lyd123qw2008/node-repl-dsh-bootstrap'
      config:
        providers:
          - id: idea
            label: IntelliJ IDEA
            transport: streamable-http
            url: http://127.0.0.1:64342/stream
            inject:
              projectPath: D:/path/to/an/open/project
    - id: node-repl-runtime-face
      name: '@lyd123qw2008/node-repl-dsh-adapter'
```

**3. 顺序有讲究，而且未必需要重启**

先在 profile 目录跑 `corepack pnpm install`，**然后**才改 `cordis.patch.yml`。反过来的话，`patchReload` 为 `live` 的 profile 会立刻尝试加载这两个插件，而模块还解析不到，等于在**正在运行**的 DSH 里制造一次加载错误。这一步实测过一次：先 `pnpm install`（只有那两条依赖进 lockfile）再改 patch，运行中的进程热加载成功，日志出现自证行，**当次会话立即可用 `js`**：

```text
[node-repl-runtime] mounted idea=67
```

- `patchReload: live` 的 profile（例如活动 profile `web`）：改完 patch 即生效，**不必重启**。注意这会让运行中的会话工具面变化（前缀缓存失效一次），干净做法仍是挑时间重启。
- `patchReload: startup`：改 patch 后必须重启。
- **改了插件源码**（不是 profile 配置）**一定要重启**：插件模块已被进程 import 并缓存，热加载配置不会重新 import 它。判断依据是日志里自证行出现的**位置**——启动期挂载时它在 URL 行之前，热加载则是之后追加。

> 注意：如果按上面的写法注入 `projectPath`，它会被写进你的 profile 配置。那是机器本地值，写在那里是**合理的**（profile 本来就是机器本地的），但要清楚它在那里。

### 两种 provider 配置，选一个

| 配置 | 好处 | 代价 |
| --- | --- | --- |
| **注入 `projectPath`**（上面的写法，隔离实例用的就是它） | cell 里不必每次带路径；`projectPath` 从模型可见 schema 里消失，调用方也无法改指别的项目 | 这个 profile 的 IDEA 调用**固定**指向该项目：该路径没在 IDEA 打开时就报错；两个项目都开着时永远选它 |
| **不注入**（我们的活动 profile 采用的） | 项目无关：多仓库会话不会指错项目；每个会话在自己的 cell 里传自己的项目 | 每个项目级调用都必须自己传 `projectPath` |

不注入那条有一个**实测出来的坑**，值得单独记下：`projectPath` 在 IDEA 的 schema 里是**非必填**属性，但项目级调用不带它会直接失败——

```text
Error: Unable to determine the target project for the current MCP tool call.
You may specify the project path via `projectPath` parameter when calling a tool.
Currently open projects: {"projects":[{"path":"D:/..."}]}
```

所以"schema 没标 required"**不等于**"调用时不需要"。不注入时正确的 cell 是
`await cap.idea.get_project_modules({ projectPath: 'D:/path/to/project' })`。
这条指引故意**没有**写进 `js` 的工具描述：它是 IDEA 特有的，换一个 provider 就失效，按 §"换掉 provider 后是否作废"的判断标准不属于 facade。恢复信息由服务器自己的错误消息给出（它连当前打开的项目都列了出来）。

## 验收清单

标注 ✅ 的项目已在活动 profile（`profiles/web`，3093）上实测通过。

- [x] ✅ 启动日志有 `[node-repl-runtime] mounted idea=67`；
- [x] ✅ 模型可见工具**恰好两个**：`js`、`js_reset`（没有 `mcp__*`，没有任何 IDEA 原始工具名）；
- [x] ✅ `nodeRepl.write(capHelp())` → `idea (IntelliJ IDEA) — 67 operation(s)`；
- [x] ✅ `nodeRepl.write(capHelp("idea"))` → 列出操作；
- [x] ✅ `cap.describe("idea.search_file")` → 给出入参 schema 与服务端声明的**返回结构**（实测 42/67 有声明）；
- [x] ✅ 多步真实调用（glob 找 controller → `read_file` → `get_file_problems`）全部走通；
- [x] ✅ `js_reset` 清空绑定且 `cap` 自动重装（`marker=undefined, cap=object, ideaOps=67`）；
- [ ] 注入模式专用：cell 里**不要**传 `projectPath`（上面的注入写法），故意传应报 host-owned 类错误而不是静默覆盖；
- [x] ✅ 工具声明成本：两个工具约 **695 tokens**，与 67 个操作无关。

一个不在清单上、但值得知道的现象：**内核会截断过长的输出**并在结果里标注（实测 `…100 lines truncated…`）。所以 cell 里应该先汇总、只 `nodeRepl.write` 需要的那部分——`js` 的描述也是这么写的。

## 回滚

删掉 profile patch 里那两条 `insert`，并从 `dependencies` 与 `bundles` 里移除两个包，重启即可。隔离实例则直接删掉 `D:\temp\nr-dsh-home`。

## 已知边界

- **顶层语句必须显式写 `;`**。内核在每条语句的边界注入快照代码、且**没有前导分隔符**，缺分号时那个标识符就粘在上一条语句后面，整个 cell 报 `SyntaxError: Unexpected identifier '__qwen_repl_..._snapshot'`。因为绑定会跨 cell 继承，**除第一个 cell 外几乎总会踩到**。已在 GH 源码核对（`QwenLM/qwen-code` `packages/node-repl`，`main` 即 `0.1.6`，`src/runtime/*.mjs` 与 dist 字节级一致），上游尚未修、也未发现已有 issue；一个字符就能修（`snapshotAssignments()` 前加 `;`）。我们不打补丁，`js` 的描述里已写明规则并给出这个错误签名。
- **`let`/`const` 不能跨 cell 重声明**（`var` 可以）。`js` 的描述里已写明引导模型用 `var`。
- **`wait` / `cancel` 未暴露**：长 cell 只能等超时（默认 30s，可用 `timeoutMs` 调）。超时只停当前 cell，内核与已有绑定保留。
- **不是安全沙箱**：内核子进程与 MCP 会话有普通 Node 权限。这是可信环境下的运行时。
- **每次 profile 加载都会连一次 MCP**（`tools/list` 元数据），不做任何工具调用。
