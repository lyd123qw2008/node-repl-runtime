# 证据：`run_code`（PTC）的 dispatch 呈现（2026-09-28）

这份截图集记录的是"把本仓库的能力目录按 `cap_help` / `cap_call` 投影进 DSH PTC"那次实验在**界面上的样子**。
它对应的决定见 [`docs/07 §6` 的 2026-09-28 注](../../07-codemode-ptc-and-kernel-lifetime.zh-CN.md)：
**不迁移 PTC** 的两条理由里，第二条（呈现丢失程序流程）就是这些图。

| 文件 | 拍的是什么 | 说明什么 |
| --- | --- | --- |
| `1-run-code-dispatch-list.png` | `run_code` 下面平铺的 dispatch 清单（9 条 `工具调用 · cap_help/cap_call · <第一个参数>`） | 每行只有工具名 + 第一个参数，没有任何指向程序位置的锚点 |
| `2-run-code-vs-js.png` | 同一次"列出 provider 并截图三个站点"巡检的 A/B：上面是 `run_code` 的 9 条 `子工具` 行；下面是同一个任务用 `js` 一行（`ok (2517 ms)`）+ cell 按顺序写出的输出 | 程序、叙事、结果在 `js` 面是同一个单元；在 `run_code` 面被拆成"脚本卡片 + 卡片外的调用清单" |
| `3-run-code-script-card.png` | `run_code` 的调用卡片本身：脚本（带行号）+ 程序自己的 `输出`；dispatch 清单在**卡片外面**的 `⌄ 查看` 之下 | 程序是显示了的；丢的是"哪一行发起了哪次调用" |

## 来源与处理

- 原始截图来自 2026-09-28 的本机会话（DSH Web GUI，`cap_help` / `cap_call` 投影实验）。
- 三张都**只裁出工具区域**：原图左侧的会话/仓库列表（`oracle-arm`、`5g-os-server`、`rcoc-…` 等）已裁掉，
  因为这个仓库是公开的。
- 除裁剪外未做任何修改（没有重绘、没有改字）。裁剪方式：Windows GDI+ `DrawImage` 取源矩形后另存 PNG。
- **这是本仓库第一批入库的证据图**，所以放在 `docs/img/` 而不是 `docs/evidence/`——后者在 `.gitignore` 里
  （机器本地材料，只留日志类）。这三张图已不含本机绝对路径或会话列表，可以公开。
