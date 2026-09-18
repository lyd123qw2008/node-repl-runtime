# 发布流程

三个包同版本锁步发布：

| 包 | 作用 |
| --- | --- |
| `@lyd123qw2008/node-repl-runtime` | 运行时本体（内核 + provider 目录投影） |
| `@lyd123qw2008/node-repl-dsh-adapter` | 两个工具的模型面（`js` / `js_reset`） |
| `@lyd123qw2008/node-repl-dsh-bootstrap` | 从配置装配运行时并 `provide('nodeReplRuntime')` |

发布顺序 `runtime → adapter → bootstrap`（后两者依赖前者），`pnpm -r publish` 会按拓扑顺序处理。

## 为什么首次必须手动

npm 规定 **trusted publisher 只能配置到已经存在于 registry 的包上**。所以第一次发布必须用传统登录方式完成，之后才能在 npm 上为三个包分别配置 OIDC 发布者，交给 `.github/workflows/publish.yml`。

## 第一次发布（手动，仅一次）

```powershell
# 1. 确认干净：工作树干净、验证全绿
git status --short
pnpm install --frozen-lockfile
pnpm run verify

# 2. 预览将要发布的内容（会改写 workspace:* 为真实版本）
pnpm -r publish --access public --no-git-checks --dry-run

# 3. 登录并发布（npm 账号需要开启 2FA）
npm login
pnpm -r publish --access public --no-git-checks
```

发布后逐个检查：

```powershell
npm view @lyd123qw2008/node-repl-runtime version dependencies
npm view @lyd123qw2008/node-repl-dsh-adapter version dependencies
npm view @lyd123qw2008/node-repl-dsh-bootstrap version dependencies
```

`dependencies` 里出现 `workspace:*` 就说明用错了命令（必须用 `pnpm publish`，不能用 `npm publish`——后者不改写 workspace 依赖）。

## 绑定 trusted publisher（每个包一次）

npmjs.com → 该包 → **Settings → Trusted publishing → GitHub Actions**：

| 字段 | 值 |
| --- | --- |
| Organization or user | `lyd123qw2008` |
| Repository | `node-repl-runtime` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

三个包都要各配一次。

## 之后的版本

1. 改三个 `packages/*/package.json` 的 `version`（保持一致），提交并推送；
2. 等 CI 绿；
3. GitHub → Actions → **Publish** → Run workflow：
   - `expected_version`：填本次版本号（可选但推荐，会在发布前校验三个包一致）；
   - `dry_run`：先跑一次 true 看清楚要发什么，再跑 false。

OIDC 不需要任何长期 token；provenance 由 npm 在用 trusted publishing 时自动生成。

## 与 DSH profile 的关系

发布不等于被使用。活动 profile 现在用 `link:` 指向本仓库源码（改完即生效，无需发布）。要用已发布的版本，把 profile 的 `package.json` 里那两条依赖换成版本号：

```jsonc
"@lyd123qw2008/node-repl-dsh-bootstrap": "0.1.0",
"@lyd123qw2008/node-repl-dsh-adapter": "0.1.0"
```

然后 `corepack pnpm --dir <profile> install`，再重启 DSH（改的是依赖而非插件源码时，`patchReload` 的行为见 `profiles/dsh-node-repl/README.zh-CN.md` 第 3 节）。
