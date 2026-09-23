# Code Mode、DSH PTC 与内核寿命

> 这份文档回答三个连在一起的问题：**（1）** 把 Cloudflare 的 Code Mode 搬过来值不值；**（2）** 内核的内存/资源
> 到底会不会泄漏；**（3）** 如果不用自建内核，DSH 自己的 `run_code`（PTC）能不能顶上。
> 结论都来自本机实测，不是推断。**结论先行**：泄漏的真实形状是"内核寿命接错对象"，不是"内核漏"；
> 修法不是调阈值，而是把执行交给 `ctx.ptcRuntime`、我们只保留目录投影那半。

> **2026-09-23 状态更新 —— 第 6 节那条迁移决定已被回退，本文其余结论不受影响。**
> `cap_help` / `cap_call` 的能力目录投影随实验一并在 09-23 09:45 从 web profile 移除
> （`profiles/web/cordis.patch.yml.bak-cap-catalog-removal-20260923-094552`），当天晚些的工具面精简
> 也没有把它恢复；迁移是否继续、以什么形态继续，待定。第 1–5、7 节的实测数字与判据仍然成立；
> 第 4 节的验收标准（`probe-escape-kernel.mjs` 改完后必须拿不到 `process`，**现在仍退 1**）尚未达成。

## 1. 三个 arm 的对照实验

同一个 fixture（一个 warm stdio MCP：`slow(570ms)` / `blob(150k chars)` / `shot()` 真 PNG / `boom`），
**连接全部复用**，只换执行 runtime：

| arm | 执行 runtime |
| --- | --- |
| A | 我们现在的：一个常驻内核子进程 + 一份 MCP 会话，绑定跨 cell 存活 |
| B | Cloudflare `@cloudflare/codemode@0.5.2` 的 `runCode` + 把它自己的 sandbox harness **原样移植**到每次新建的 V8 realm |
| C | 他们自己的 `DynamicWorkerExecutor`，跑在真 workerd 上（miniflare 5 + Worker Loader binding，`globalOutbound: null`） |

| workload | A 持久内核 | B 新 realm/次 | C 新 isolate/次 |
| --- | --- | --- | --- |
| 1 次执行 × 10 个 `slow(570)` | 5801 ms | 5774 ms | 5829 ms |
| 10 次执行 × 1 个 `slow(570)` | 588 ms | 583 ms | 586 ms |
| 10 次执行中位数 | **583** (578–594) | **583** (573–585) | **584** (581–586) |
| 1 次执行 × 10 × `blob(150k)`（1.5 MB） | 73 ms | 34 ms | 145 ms |
| 1 次执行 × 3 × `shot()`（721k 字符图） | 94 ms | 22 ms | 52 ms |
| `await slow(3000)` / 1000 ms 预算 | 1035 ms | 1031 ms | 1044 ms |

realm 创建 **0.64 ms/次**、整个 harness 重新编译 **0.17 ms/次**；workerd 新 isolate 首个 68 ms、之后约 3 ms。

**要纠正的一句话**：曾经有"每次新 runtime 冷启动 ~1.7 s，比内核慢 3.9×"的说法——那是**CLI 形状**的成本
（每次新进程 + 重新 MCP 握手），属于**连接**成本，不是隔离成本。连接复用之后，三种形态在真实工具延迟下打平。
**Code Mode 的"每次一个新隔离"不慢，慢的从来是连接。**

## 2. 内存与资源：实测

内核不自己把堆还回去；而且增长与"模型存不存"无关（每 20 格）：

| 实验 | 内核堆变化 |
| --- | --- |
| `var x = i`（不带载荷） | 8.48 MB → 9.04 MB（**+0.56 MB**，约 28 KB/格） |
| 每次取 150 KB，**用完就丢**（cell 局部变量） | 8.45 MB → 14.80 MB（**+6.35 MB**） |
| 上一步后跑一格制造 GC 压力 | 14.80 MB → **11.48 MB**（只收回约一半，**余 ~3 MB**） |
| 每次取 150 KB，**显式存进 `globalThis`** | 8.47 MB → 14.49 MB（**+6.02 MB**，UTF-16 全额） |
| 然后 `js_reset()` | 14.49 MB → 8.54 MB（**−5.95 MB**，回到基线 +95 KB），耗时 **115 ms** |

- **增长只与"每格搬进内核多少字节"成正比**（丢弃型 6.35 MB vs 留存型 6.02 MB），所以"提醒模型少存"无效。
- 内核**没开 `--expose-gc`**，外部无法强制回收；`js_reset` 是唯一可靠杠杆，代价 115 ms（同一条 MCP 连接，
  provider 不重连、进程不更换，走内核自己的 `node_repl_reset`）。
- 堆上限 **4.29 GB**，**没有 per-cell 上限**；最坏情况是内核崩，然后 `recoverCatalog()` 重建目录并明确告知绑定丢失。
- 资源面：**普通**子进程随内核一起被任务树杀（实测 reset 后 `alive: false`）；
  **`spawn({detached:true}).unref()` 的子进程会逃逸**（reset 后、dispose 后都活着，只能手工 `taskkill`）；
  provider 会话在 `dispose()` 时干净收掉（fixture 与内核进程都死）。

## 3. 真正的问题：寿命接错了对象

- **代码**：`packages/dsh-bootstrap/src/index.ts:64-72` 在 app 作用域创建一次 runtime 并
  `ctx.provide('nodeReplRuntime', runtime)`；唯一释放点是 app teardown 的 `ctx.effect`。
  adapter 侧 `apply(ctx)` 只注册/注销工具（`packages/adapter-dsh/src/index.ts:329-337`），**没有任何会话生命周期钩子**。
- **进程树**：`DSH 37316 (14:18, 3.7h) → kernel host 20600 → kernel worker 29032 (15:11, generation 3)`。
  实测该内核里仍能读到本轮会话 20 分钟前写的 `var candidates`。
- **现场**：这台机器上同时活着 **3 套内核树，共 213.6 MB RSS**；最老的 DSH 进程已运行 **80 小时**。
- **放大机制**：CLI 形态下留存窗口 = 一次任务（进程结束即释放）；DSH 是常驻服务，留存窗口 = **DSH 进程寿命**。
  同一进程里**所有会话共用一个内核**，所以除了内存，还有（a）新会话能看到上一个会话的 `var`、
  （b）并发会话互相踩变量名、（c）A 会话的大载荷算在 B 会话头上。

## 4. 边界：我们的不是安全边界

cell 里 `typeof process` 是 `undefined`、`require` 也没有，**但一行就能拿到**：

```
via: fetch.constructor.constructor('return process')()
pid 29032 · cwd=…\Temp\node-repl-runtime-… · home=C:\Users\liuyd · env 19 个键
fs.readFileSync ✓  C:/Windows/System32/drivers/etc/hosts 可读 ✓  ~ 可列 ✓  可写 ✓
child_process.execSync ✓  net.connect ✓
```

- 内核确实设了 `codeGeneration: { strings: false }`（对自己的函数 `Function` 构造被拒：
  `EvalError: Code generation from strings disallowed`），**但宿主注入的 `fetch` 绕过它**——逃生走的正是 `fetch`。
- 把同一套 harness 放到 `vm.createContext`（arm B）：`setTimeout.constructor.constructor('return process')()`
  同样拿到 `fs.readFileSync` / `childProcess.execSync`（pid 23172）。**`vm` 不是安全边界，隔离频率也不是。**
- 所以"每次新 runtime"在安全上是 0 收益；提供边界的只有**沙箱原语**（受限令牌 / ACL / 独立进程 / 真 isolate）。
- 补充：就算 cell 关进真 isolate，**能力层**本来就有等价于任意执行的门（`cap.idea` 的 IDE 终端、
  `cap.chrome` 的 44 个操作、cua 的键盘合成），而 Code Mode 把"一次一个、看得见、可拦"的子调用藏进了一个程序里。

## 5. DSH 自己的 `run_code`（PTC）：能顶上，但有价

机制（`packages/ptc-runtime/ptc-runtime-node/src/index.ts:126-210`）：`run()` → `ctx.subprocess.spawn(...)`
**每次一个全新受管 Node 子进程**，`confined?.argv ?? argv`（策略要求时带沙箱启动参数）、
`cwd = sandboxPolicy.workspaceRoot`、控制通道回宿主；到点 `controller.abort()` → `handle.terminate()` **真杀进程**；
输出走 `OutputLedger(maxOutputBytes)`；TS 在宿主侧 `stripTypeScriptTypes` 后送进子进程。
服务契约（`packages/ptc-runtime/ptc-runtime/src/index.ts:93`）明文要求"把程序当敌对对等体、隔离每次运行、
dispose 时终止并等待在飞运行"。子调用经 `tool/ptc-dispatch` 回到宿主工具管线（审批、守卫、spill、落日志）。

本机实测（run 从源码 checkout；"built"指 `bootstrapPath` 指向 `lib/process.js`）：

| 指标 | 我们的内核 | DSH PTC `run_code` |
| --- | --- | --- |
| 每次执行开销 | **~13 ms/格** | **~400 ms/程序**（built 中位 399，源码模式 464；裸 node 子进程仅 81–87 ms） |
| 1 次执行 × 10 × `slow(570)` | 5797 ms | 6207 ms |
| 10 次执行 × 1 × `slow(570)` | 5850 ms（585/次） | 9740 ms（974/次） |
| 跨执行状态 | 有（绑定，跨会话共享） | **无**（`globalThis.LEAK` 在下一个程序里为 `null`） |
| 同步死循环 + 1000 ms 预算 | 1007 ms 被杀 | **1031 ms 被杀**（`kind: 'timeout'`） |
| 文件边界 | 无（全权限；vm 可逃） | **策略生效**：`read-only` 下写工作区/写外部都被拒（`enforcement: 'partial'`） |
| 每次执行的上限 | 无（内核 4.29 GB，无 per-cell 限制） | **堆 512 MB/程序**、输出 64 MB、超时默认 120 s / 上限 600 s、`maxPendingCalls` 128 |
| 环境变量 | 继承（19 个键） | **空**（`envKeys: 0`） |
| 绑定失败 | cell 抛错 | 程序内可 catch（`err.message` 原样） |
| 宿主累积 | 20 格 +3~6 MB，直到 reset | 10 × 150 KB 程序后 +0.9 MB heap / +3.6 MB RSS（基本平） |
| detach 出来的子进程 | 存活（孤儿） | **也存活**（`aliveAfterProgramExit: true`，两种策略下都复现） |

两条必须说清的话：

1. **它修掉的正是我们担心的**：无常驻对象、无跨程序状态、每次执行的堆/输出/时长上限、文件策略真正生效、
   空环境变量、子调用进管线可审计、跑飞可被杀。第 3 节那些"日积月累"在它这里不存在。
2. **它没修的**：detach 孤儿（**两边都漏**，实测），以及每次程序约 **400 ms** 的底座成本
   （来源是受管子进程 + 控制通道 + 通道收尾，不是 TS 类型擦除：换成 built bootstrap 只省 65 ms）。
   所以**不能**用"每次一个程序"代替"每格一个 cell"做细粒度多轮试探：585 ms → 974 ms 是 1.7×。

## 6. 决定

| 决定 | 理由 |
| --- | --- |
| **不搬 Cloudflare 的 isolate-per-execution** | 那一层是 workerd 平台能力，搬不过来；能搬的只有形状，而形状不提供边界也不提供安全 |
| **不搬 `truncateResult` / `state.*`** | 模型自己就能控制结果大小；我们主动裁剪反而限制手脚。留作备选，不设阈值 |
| **图片附件名保持常量**（扩展名跟 `mediaType`） | DSH 的图片按**内容寻址**存储（`objects/<sha256>` + 摘要校验去重，`attachment-local/src/store.ts:51-54`、`204-228`），`name` 只是展示元数据，不参与路径也不参与查找，同名既不冲突也不覆盖；按 `title` 派生 slug 属于给没观察到的痛点加机制。唯一改正的是扩展名：jpg/webp 曾经也叫 `node-repl.png`，名字和自己的字节矛盾 |
| **执行交给 `ctx.ptcRuntime`，我们只保留目录投影** | 把 149 个 provider 操作投影成 2–3 个泛化工具（`cap_help` / `cap_call`），目录进不了系统提示；执行落在 DSH 的受管子进程里，寿命 = 一次程序 |
| **内核的回收问题不靠阈值解决** | 迁移后不存在常驻对象；在此之前，`js_reset`（115 ms）是唯一杠杆，"可见 + 提示"优先于自动复位 |
| **detach 纪律保留** | 两边都收不掉，`descriptions.ts` 的"Do not spawn a detached process"继续是唯一防线 |

**什么情况下回头做**（可观测扳机）：

1. 迁移到 PTC 后，出现"一个程序做十几次工具调用"成为常态而模型仍需要细粒度多轮 → 考虑保留内核作为低延迟交互路径；
2. 进程中再次出现非本实验制造的孤儿 → 那才是真证据（此时两侧都要修，DSH 侧修 Job Object / breakaway）；
3. 内核 RSS 或 `getHeapStatus()` 在**没有迁移**的前提下逼近上限 → 届时把会话边界复位做进接线层。

## 7. 证据与复现

本机实验目录 `D:\liuyongdan\code\playground\cf-codemode-exp\`：

| 文件 | 作用 |
| --- | --- |
| `run-all.mjs` / `summary.mjs` / `results/latest.json` | 三个 arm 一把跑完 + 原始数据（含 sync-loop 结论：A 1007 ms 被杀、B 宿主观测杀、C 15 s 不返回） |
| `realm-executor.mjs` | Cloudflare harness 的移植（注释逐条列出与 `DynamicWorkerExecutor` 的差异） |
| `probe-leaks.mjs` | 第 2 节全部数字；退出前清掉自己起的进程 |
| `probe-escape-kernel.mjs` | 第 4 节的验收标准：改完之后必须拿不到 `process`（现在退 1） |

DSH checkout 里的 spike：`packages/ptc-runtime/ptc-runtime-node/tests/spike-cap-namespace.spec.ts`
（第 5 节那张表；把它当可复跑的对照，不是要留下的测试）。

## 对应实现

- [内核会话：安装、取消、崩溃恢复](../packages/runtime/src/kernel.ts)
- [工具描述（模型可见的纪律）](../packages/adapter-dsh/src/descriptions.ts)
- [内核边界与已知限制](./06-kernel-boundaries.zh-CN.md)（本文修正其中"OS 级沙箱不需要"的落点：DSH 侧已有现成实现可挂）
- [provider 生命周期与失败可见性](./04-architecture.zh-CN.md)
