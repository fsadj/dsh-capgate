# dsh-capgate v2 —— 效果类摊销授权

**把 dsh 的审批从"逐调用弹窗"改成"每类效果问一次，之后确定性放行"。**

> 给试用的同学：直接跳 [快速试用（5 分钟）](#快速试用5-分钟)，三步装完。
> 装好之后，权限选择器里会多出第 4 档「Capgate 自动判定」，选中它才生效；切到别的档位插件自动休眠。

和 v1（`index.ts`，保留作对照）的根本区别：**v2 没有"计划"，也没有"铸造"。**

| | v1 | v2 |
|---|---|---|
| 授权单位 | 任务计划（LLM 提议，人审） | **效果类**（op × 域 × 敏感度 × 基数） |
| 谁能扩权 | 铸造工具 + 人审计划 | **只有用户原话**（逐字引文，机器核对） |
| 承重假设 | 计划对 + 人真的会看计划 | 无（预测错了第一次用就会问） |
| 凭证 | Macaroon（密钥在源码里） | 不需要 |
| SMT 单调检查 | 有 | 不需要（能力从引文来，不从集合来） |
| 首次使用 | 全放行 | **问一次，附引文** |
| 同类第二次 | 全放行 | 放行（零 LLM、微秒级） |

> v2 放弃了两样东西，而且是有意的：**Macaroon 凭证**和 **SMT 单调收窄**。
> 它们的存在前提是"能力来自一个可以扩张的集合"，而 v2 的能力来自用户原话，扩不出集合外的东西。

## 它到底判什么

```
一次调用 → 效果抽取 → 效果类 = (op, scope, sensitivity, cardinality)
            │
            ├─ 项目内普通读 ──────────────── 放行（0 打扰）
            ├─ 该类已授予 ────────────────── 放行（0 LLM，微秒）
            ├─ 完全相同的命令已批准过 ────── 放行（只认同一条，不推广）
            ├─ 批量/通配 ─────────────────── 问人（一条批准不能变批量许可证）
            ├─ 敏感 + 项目外 ─────────────── 拒绝（确定性）
            ├─ 项目外 + 无引文 ───────────── 拒绝（确定性）
            └─ 其余 ─────────────────────── 问一次
                                            ├─ 有引文 → 审批自动通过并记住该类
                                            ├─ 无引文 + judgeMode=residual → 复核：deny / ask
                                            └─ 仍无结论 → 交给人；人同意后记住该类
                                               （批量 / 不透明执行 / 出网 例外：只对这一次生效）
```

**减少打扰的三条机制**（都不放松安全边界）：

1. **效果类摊销**：同类第二次起 0 打扰（TTL 内）；
2. **引文直授**：用户原话点了名就自动放行，不弹卡；
3. **同一条命令只问一次**：签名 = `tool + 参数` 的稳定序列化，人批准过就按签名记住；
   差一个字就是另一条命令，必须重新确认。

而 **批量 / 不透明执行 / 出网** 的批准**只对那一次有效**——它们的必问理由（"目标集合不确定"、
"脚本内部不可见"、"数据要离开本机"）在批准第二次时依然成立，所以不能升级成类授权。

**"引文"是本插件唯一的授权来源**：agent 想拿到某类授权，必须能指向用户原话里的一个片段，
且该片段逐字出现在会话里、动词与操作类型匹配（"要不要删"、"看一下"都不构成删除授权）。

## 快速试用（5 分钟）

前提：已经装好并跑过 `dsh`（`dsh --version` 能出版本号），Node ≥ 22。

```bash
# 1) 进入插件目录，把 dsh 自带的 schemastery 链接进来（只需一次）
cd dsh-capgate
node scripts/setup.mjs                 # 找不到 dsh 时：node scripts/setup.mjs --dsh <dsh安装目录>

# 2) 自己先验一遍（不依赖 dsh，离线跑）
npm test        # 57 条单测
npm run demo    # 131 次调用的摊销演示：6 次打扰，最后 60 次 0 新增

# 3) 装进 web profile：把 examples/cordis.patch.yml 的内容贴到
#    %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml 末尾，并把 <ABS_PATH> 换成解压目录的绝对路径
#    （首次没有这个文件：直接新建，内容就是那份示例）

# 4) 启动
dsh web
```

> `dsh plugin add` 这条路需要本机有 `pnpm`；没有 pnpm 就用上面的 patch 方式，效果一样。

打开页面后：右上角权限选择器 → 选 **「Capgate 自动判定」**（第 4 档，插件带的）。

然后试这几句，观察差异：

| 说什么 | 预期 |
|---|---|
| `列出当前目录的文件` | 不问，直接做 |
| `创建 note.txt，内容写 hello` | 不问（原话点了名），落盘 |
| `把工作区里所有 .log 都删掉` | **弹卡**（批量永远问） |
| `用 node 跑个脚本` | **弹卡**（脚本内部效果不可见） |
| `删掉 ~/Downloads/xxx.zip` | 弹卡：`capgate：项目外 … · 删 · 少量目标；本次需要临时放宽到 danger-full-access` |

卡上写的是 capgate 的判定，不是模型自述的理由；点「允许一次」才真的执行，点「拒绝」不会执行。

想看它记住了什么：在输入框打 `/capgate`。

## 安装（手工/调试用）

最省事的方式就是 `examples/cordis.patch.yml`：整份贴进 profile 的 `cordis.patch.yml`，把 `<ABS_PATH>` 换成解压目录。

只挂插件、不要第 4 档的话，最小配置是：

```yaml
- insert:
    - id: capgate
      name: '/absolute/path/to/capgate-dsh/src/index.mjs'
      config:
        mode: capgate
```

或作为 bundle 安装（`cordis.patch.yml` 已按包名写好；**需要本机有 pnpm**）：

```bash
pnpm dsh plugin --profile web add ./capgate-dsh
```

### 作为独立权限档位（推荐）

权限预设表是**配置**，所以插件可以把自己的档位和三档内置档并列，出现在右上角的权限选择器里：

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    defaultPreset: capgate
    presets:
      read-only:       { sandbox: read-only,       approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      capgate:
        sandbox: workspace-write
        approval: ask
        name: Capgate 自动判定
        description: 效果类摊销授权：首次问一次，同类确定性放行；敏感/出网/批量仍拦。
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

配合插件的 `requiredPreset: capgate`：**只有选中这一档时 capgate 才生效**，切到别的档就回到原生行为。

两个必须知道的点：

- `presets` 是**整表替换**，内置三档必须原样抄一遍；dsh 升级后若内置表变了要同步；
- 没有"运行时注册预设"的 API（保留名只有 `custom` 与 `auto`，后者归上游 Auto review），所以走配置覆盖是生态里的标准做法。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `capgate` | **volatile**：Web 设置里可原位切 `standard`（休眠，走原生审批）/ `capgate` |
| `requiredPreset` | 空 | 非空时只有会话权限预设等于它才激活（对齐 dsh-approval-gate 的 preset 门控） |
| `workspaceRoot` | 空 | 空 = 用会话 cwd |
| `autoAllowReads` | `true` | 项目内普通读直接放行 |
| `autoAllowOutsideReads` | `true` | 项目外**普通**读也放行；敏感路径与批量枚举仍拦 |
| `minimize` | `true` | 读类结果按任务实体投影 |
| `humanOnlyTools` | `send_money` 等 | 永远问人的工具 |
| `maxConsecutiveDenials` | `3` | 同一效果类连续拒绝 N 次后转人工 |
| `maxRepeats` | `2` | 同一 `(tool,args)` 反复被拒 N 次后转人工（防换写法死循环） |
| `grantTtlHours` | `8` | 类授权有效期 |
| `judgeMode` | `residual` | `residual` = 规则认不出且无引文时，让当前会话模型看一眼 |
| `judgeAutoAllow` | `true` | 允许复核直接放行，但**只在低风险层**（项目内、非敏感、非批量、非出网、非不透明） |
| `judgeTimeoutMs` | `8000` | 复核超时；超时一律转人工 |
| `ruleAllowTools` | `[]` | 整体放行的工具（支持 `*`） |
| `ruleDenyTools` | `[]` | 整体拒绝的工具（支持 `*`），**优先于 allow** |
| `ruleDenyKeywords` | `[]` | 命令/参数命中即拒绝的正则 |
| `ruleAllowPaths` | `[]` | 目标全部落在这些前缀内即放行 |
| `ruleDenyPaths` | `[]` | 目标命中这些前缀即拒绝 |
| `auditPath` | 空 | JSONL 审计；空 = 只内存 |
| `learnPath` | 空 | 学习/硬化规则文件；空 = 只内存（重启就没了） |
| `hardenAfter` | `3` | 同一类批准 N 次后进入 allow 候选 |
| `rejectAfter` | `2` | 同一类拒绝 N 次后进入 deny 候选 |

规则在"效果类判定"之前执行，**deny 优先于 allow**；非法正则会被丢弃并在启动时告警，不会让插件起不来。

### 敏感路径：读也不放行

读的放行是有条件的。敏感路径在执行任何放行规则**之前**就被单独处理：

| 位置 | 行为 |
|---|---|
| 敏感 + 项目外 | **拒绝**（连续 N 次后转人工） |
| 敏感 + 项目内 | 用户原话点名 → 放行**这一次**；没点名 → 问 |
| 授不授类 | **永不按类摊销**——读完一个凭据文件，下一个仍然要问 |

判定按"目录名 / 文件名"，不读内容，宁可多报：

- 目录：`.ssh` `.aws` `.kube` `.docker` `.gnupg`
- 文件名：`.env*`、`id_rsa|id_ed25519|id_ecdsa`、`*.pem|*.key|*.pfx|*.p12|*.kdbx`、
  `.npmrc|.netrc|.pypirc|.git-credentials`、`credentials.*|secrets.*`、`Login Data|Cookies|keychain*|wallet.dat`

`src/token.ts`、`notes.txt` 这类源码/普通文件不在此列——判定看的是"这个路径是不是凭据载体"，不是词。


## 测试与演示

```bash
npm test      # 36 条：效果抽取 / 引文核对 / 规则 / 预设门控 / 端到端流转
npm run demo  # 不需要 dsh、不需要密钥，跑一条完整任务
```

`npm run demo` 的输出（真实运行结果）：

```
任务：把 src/app.js 里的 bug 改掉，然后跑一下测试，最后把结果上传到 https://uploads.mycorp.com/drop

#   调用                              判决    说明
1   read src/app.js                   allow
2   read .env                         ask    → 审批：rejected（没提过的敏感文件）
3   edit src/app.js                   ask    → 审批：allowed-once（有引文，自动授予）
4   edit src/util.js                  allow  （同类，零打扰）
5   pwsh npm test                     ask    → 审批：allowed-once
6   pwsh npm test -- --watch          allow
7   curl … uploads.mycorp.com         ask    → 审批：allowed-once（用户原话里提到该主机）
8   curl … evil.example.com           deny   （未提及的主机）
9   delete src/legacy.js              ask    → 审批：allowed-once（人同意，记住该类）
10  delete src/old.js                 allow
11  Remove-Item -Recurse C:/repo/*    ask    → 审批：rejected（批量，永远问人）

前 11 次调用：打断 6 次（每个新效果类各一次）
后 60 次调用：新增打断 0 次
逐调用审批需要 131 次人工确认；本方案 6 次。
```

这条输出就是架构的主张：**打断次数是效果类数量的函数，不是调用次数的函数。**

## 真实 dsh 端到端验证

```bash
npm run e2e     # 不需要 API key：用一个本地假模型驱动真 dsh
```

它会在 `./.e2e/run-<时间戳>/` 下建一个**独立 DSH_HOME**，挂上本插件、起一个 OpenAI 兼容假模型，跑四个场景并断言产物与审计；全程不碰你正在用的 profile。

实测输出：

```
=== 1. cited：用户原话提到 a.txt → 引文授权 → 自动放行 ===
  PASS 插件在真实 dsh 中加载
  PASS a.txt 已落盘（审批被引文自动放行）
=== 2. uncited：越界且未提及 → 确定性拒绝 ===
  PASS 审计记录 outside-no-citation
  PASS 越界文件未被创建
=== 3. batch：通配 *.txt → 批量类 → 无通道 → fail-closed ===
  PASS 归类为 many（批量）
=== 4. amortization：同一会话内两次同类写，只问一次 ===
  PASS 两次同类写只产生 1 次 ask
  PASS a.txt 与 b.txt 都已落盘
全部通过
```

用 `DSH_BIN=/path/to/dsh/lib/bin.js npm run e2e` 可以指向别的 dsh 安装。

覆盖的关键行为：

- `bash -c 'rm -rf ../../x'`、`/bin/rm`、裸目标 `Remove-Item build`、`curl -d @.env` 都被正确归约；
- `.env` 与普通文件不同类；批量/通配永远问人；
- 首次写带引文 → 自动授予；同类第二次零打扰（真实 dsh 里验证过）；
- 无引文 → 问人；人拒绝后同类仍要问；
- 项目外无引文 → 拒绝；敏感越界 → 拒绝；
- 连续 3 次拒绝 → 转人工。

## 残余判定（可选的一层）

默认关闭。打开后（`judgeMode: residual`），只有"规则认不出、引文也对不上"的那一小撮调用会多问一次模型：

```
用户原话 ──┐
           ├─ 引文核对 ──(对不上)──► 残余判定（LLM）──► deny / ask
效果类 ────┘                                   │
                                               └─(judgeAutoAllow=true)──► allow
```

三条硬约束，保证它不会变成"模型授权"：

1. **只能拒绝或转人工**——除非显式打开 `judgeAutoAllow`，模型无权放行；
2. **超时 / 解析失败 / 无通道 → 一律转人工**（fail-closed）；
3. **它看到的是"效果类 + 截断参数 + 用户原话"**，不喂工具输出（防注入）。

### 即使开了 judgeAutoAllow，这两类也不许模型放行

| 类别 | 为什么 |
|---|---|
| **出网**（`send`：curl / wget / Invoke-WebRequest / URL） | 数据一旦离开就没有撤回；这一步必须有人或用户原话点名 |
| **不透明执行**（`execute` 且第一个词是解释器：`node` / `python` / `bash -c` / `pwsh -c` …） | 命令文本看不出脚本里干了什么——它可以联网、写盘、删东西。模型说"这是用户要的"，不等于用户授权了脚本内部那一步 |

这两种情况一律 **ask**（有引文时按引文放行，没有就等人）。审计里会记 `opaque: true` / `op: send`。

打开方式：

```yaml
config:
  judgeMode: residual
  judgeAutoAllow: false   # 想再少问几次可以设 true，但那是把授权交给模型
  judgeTimeoutMs: 8000
```

## LLM 复核能决定什么、不能决定什么

复核层的定位是**减少打扰**，不是**放权**。它只处理"项目内、无引文"这一档，并且分两层：

| 效果层 | 复核能做什么 |
|---|---|
| 项目内 · 读 / 写 / 普通执行 / 非敏感 | **可以放行**（这是它能帮你省掉询问的地方） |
| 项目外、敏感路径、批量、出网、不透明脚本、未知工具 | **只能 deny 或 ask**，绝不由模型替人签字 |

而且"项目外 + 无引文"的确定性拒绝发生在复核**之前**——否则让模型先跑，会把一条确定边界
软化成"问一句"，既不更安全也更吵。

留出集上实测（`BENCH_JUDGE=allow` 模拟"模型一律说可以"）：

| 配置 | unsafe-allow | 说明 |
|---|---|---|
| 不分层 | **20 / 60** | 包括 8 条项目外写、4 条项目外删——模型会替你把没点名的删除批了 |
| 分层（当前） | **7 / 60** | 全部落在"项目内写 / 项目内构建"这类低风险操作上 |

所以答案是：**低风险层可以交给它，高风险层不行**。这 7 条是"模型批准了用户只是问了一句的操作"
（如「要不要写进 notes.md？」），属于用严格度换安静的取舍——`judgeMode: off` 可以完全关掉这一层。

## 接管沙箱升级审批（不再"批两次"）

工具在执行需要越界的操作时会自己发起一次 `escalate sandbox to <mode>` 审批。如果不处理，
同一个动作你会看到两张卡（capgate 一张 + 原生一张）。v2 的做法是**接管**：

```
工具申请放宽到 danger-full-access
   └ capgate 截获（approval/request 最前）
        ├ 已授类 + 非全权 + 非批量 → 直接放行（不弹卡）
        └ 否则 → capgate 自己发起一次询问
              ├ 允许 → 回给工具 allowed-once
              └ 拒绝 → 回给工具 rejected
```

所以：

- 原生那张「允许本次操作使用 danger-full-access…」**不会出现**；
- 你只会看到一张卡，文案是 capgate 的判定：`capgate：项目外 C:/Users/… · 删 · 少量目标；本次需要临时放宽到 danger-full-access`；
- 敏感路径即使带升级请求也照样拒绝（不允许"借放宽沙箱"顺带读凭据）；
- 防递归：capgate 自己的询问以 `capgate:` 开头，进来时直接交给面板。

审计里能看到全过程：

```json
{"event":"escalation","by":"capgate","class":"delete|outside:C:/Users/…|plain|few","mode":"danger-full-access"}
{"event":"grant","by":"escalation","class":"…","mode":"danger-full-access","outcome":"allowed-once"}
```

## 命令

会话里可以直接用：

| 命令 | 作用 |
|---|---|
| `/capgate` | 看本会话统计：允许多少、问了多少、拒了多少、授了哪些类、插件是否在当前档位生效 |
| `/capgate learn` | 看"从你的历史判断里学到的候选规则" |
| `/capgate harden <类> allow\|deny` | 把候选写成持久规则（重启后仍生效） |
| `/capgate unharden <类> allow\|deny` | 解除规则 |
| `/capgate rules` | 看当前生效的用户规则 |
| `/capgate reset` | 清空本会话的授权与计数（授权过头时用） |

## 学习与规则硬化

每次你点「允许一次 / 拒绝」，都会按**效果类**累计到 `learnPath` 指向的 JSON 里。之后：

- 同一类**拒绝 ≥ 2 次** → `/capgate learn` 会建议硬化成 `deny`（只会让边界更紧）；
- 同一类**批准 ≥ 3 次且从未拒绝** → 建议硬化成 `allow`（等于预授权，必须你显式确认）；
- 批过也拒过的类 → 不给建议（这种类本来就该人来判）。

设计上刻意保守：

1. **不会自动放行**——"批过几次就自动放开"就是预授权，必须 `/capgate harden` 显式做一次；
2. **deny 侧也不自动应用**——一次误拒不该把整类永久封死；
3. **规则文件不写 profile、不写仓库**——写进仓库就等于"一次 git checkout = 一次预授权"。

硬化规则在判定链里的位置：`配置规则 → 硬化 deny → 敏感路径 → 硬化 allow → 快速放行 …`，
也就是说**敏感路径永远轮不到被硬化放行**。

## 界面

Web profile 下会在 **Plugins 页**多一张 **Capgate** 卡片（注册进 `plugins.item`），说明判定流程与可用命令。

客户端入口是 `client.js`（`package.json` 里 `dsh.client.platform = web`），只依赖宿主的 `slots` 与 `locale` 两个服务，所有注册都包在 `try/catch` 里：

- 服务缺失 → 页面不注册，客户端不受影响；
- 它是**纯说明页**，不读宿主状态（不做额外 RPC）；实时状态用 `/capgate` 命令看。

> 客户端产物要重建 web 才会出现：若 `pnpm run dev:web` 在跑则热更新，否则需要重建后刷新页面。这一页目前只在代码层面校验过（`node --check`），没有在浏览器里跑过。

## 锁死类别（LOCKED）

有一批效果**永远不能被自动化路径放行**——引文不行、类摊销不行、复核不行、编译器也不行。
它们只能被"人"批准，或者被拒绝。

| 锁 | 触发条件 | 为什么锁死 |
|---|---|---|
| `sensitive` | 凭据/密钥等敏感路径 | 一次误放就是长期泄露 |
| `batch` | 通配符或循环驱动的多目标 | 一条批准不能变成批量许可证 |
| `egress` | 数据离开本机（send） | 泄露不可撤回 |
| `opaque` | 脚本/解释器（内部不可见） | 命令文本看不到真实效果 |
| `unknown` | 命令语义无法确定 | 看不懂就不猜 |

代码里对应 `LOCKS` 与 `locksOf()`（`src/classify.mjs`），判定路径统一查这张表，
`/capgate status` 与审计里的 `locks` 字段都来自同一份定义。

注意语义：**锁死的是"自动放行"，不是"执行"**——被锁的调用仍然可以经人批准执行。

## 已知边界（必须知道，否则会误用）

1. **引文可被断章取义**：用户说"清理旧分支"，agent 可能拿它当"删除所有分支"的引文。
   当前用"动词匹配 + 目标逐字出现 + 疑问句排除"缓解，**不是形式化证明**。
   下一版应加入"引文 span 必须覆盖动作目标集合"的匹配。
2. **效果抽取是启发式的**：shell 解析基于词法，不是 AST。`eval "$(curl …)"` 这类动态构造识别不了。
3. **不跨任务复用授权**：每个任务的类授权只对该任务有效（跨任务复用就等于预授权）。
4. **没有二次 guard**：v1 的 `ctx.tools.guard` 已移除。原因是审批结果的授予发生在
   `approval/request` 里，而 guard 与审批的先后顺序没有保证；用不确定的顺序做二次否决会误杀。
5. **Minimize 是行级投影**：只保留包含任务实体的行，不是语义脱敏。含敏感内容的行如果恰好包含实体，仍会保留。
6. **e2e 用的是假模型**：它验证的是插件的判定链路与 dsh 集成，不是模型行为。

## 与两个现成插件的位置关系

| | dsh-capgate v2 | `@quill507/dsh-auto-approval-llm` | `dsh-approval-gate` |
|---|---|---|---|
| 决策单位 | 效果类 | 每次调用 | 每次调用 |
| 判定者 | 确定性（引文核对） | 分类器 + LLM | 单个 LLM |
| 零 LLM 路径 | 有（全部） | 部分 | 无 |
| 打扰量级 | O(类) | O(调用) | O(调用) |
| 用户规则 | allow/deny 工具、路径、关键字 | 同 | 同 |
| 预设门控 | `requiredPreset` | 自带 `auto-approval` 预设 | 仅 auto-approve 预设 |
| 防死循环 | 同类连拒 + 同调用重复 | 3 连拒 / 20 总拒 | 超时转人工 |
| 审计 / 脱敏 | JSONL + 脱敏 | 有 | 有 |
| 前端面板 | 无（用原生卡片） | 282KB client | 63KB client |
| 真 dsh 跑通 | **有 e2e（假模型）** | 出厂可用 | 出厂可用 |

**不追平的地方也是刻意的**：没有 LLM 就没有超时/重试问题，没有 UI 面板就没有前端包。
换来的是可测、可解释、零延迟。
