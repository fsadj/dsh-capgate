# Changelog

## 0.2.0

架构重写：从"计划 → 铸造 → 放行"改为"效果类 → 引文 → 放行"。

### 新增

- **效果类摊销**：`(op, scope, sensitivity, cardinality)`，首次触达问一次，同类后续确定性放行。
- **引文核对**：能力只能来自用户原话的逐字引文；动词不匹配、疑问句、越界单级路径都不算授权。
- **残余判定层**（`judgeMode: residual`）：规则认不出且无引文时，让当前会话模型判一次；
  默认只能 deny / ask，超时与解析失败一律转人工。
- **用户规则**：`ruleAllowTools` / `ruleDenyTools` / `ruleDenyKeywords` / `ruleAllowPaths` / `ruleDenyPaths`，deny 优先，非法正则不炸插件。
- **权限预设门控**：`requiredPreset`。
- **防死循环**：同类连续拒绝 N 次、同一 `(tool,args)` 重复 N 次 → 转人工。
- **`/capgate` 命令**：`status` / `rules` / `reset`。
- **Web 页面**：`client.js` 注册 Plugins 页的 Capgate 卡片（纯说明页，只依赖 slots + locale）。
- **审计**：JSONL + 秘密脱敏 + 逐会话计数。
- **Minimize**：读类结果按任务实体投影。
- **接管沙箱升级审批**：带 `sandbox_permissions` 的调用由 capgate 截获，只出一张卡（文案是 capgate 的判定），不再"capgate 一张 + 原生一张"。
- **独立权限档位**：通过 bundle patch 覆盖 `permission` 的预设表，把「Capgate 自动判定」和三档内置档并列。
- **学习与规则硬化**：按效果类累计人的批准/拒绝，`/capgate learn` 给候选，`/capgate harden` 写成持久规则；放行侧必须显式确认。
- **测试与验证**：57 条单测；`npm run demo` 的 131 调用对照（6 次打扰）；`npm run e2e` 在真实 dsh 里跑四场景；另有一套无头浏览器驱动的真机基准（9 条用例）。

### 修复

- **多行命令分段**：`parseShell` 原来只按 `;|&` 切，多行 PowerShell 会被判成"读"从而静默放行；现在换行与 `{}()` 也算分段。
- **批量识别**：只有"删除动词真的在循环里/由管道喂入"才算批量，`| Format-Table` 里的 "rm" 不再误匹配；目标抽取不再把 `if`/`{`/`Stop` 当路径。
- **不透明执行的引文授权**：用户说"跑一下"不再等于给脚本内部任何效果签字——`opaque` 一律不给引文授权。
- **命令注册**：`commands` 服务比插件晚就绪，`/capgate` 之前从未注册成功；改为轮询等待并打日志。
- **升级+敏感路径**：带 `sandbox_permissions` 的敏感读仍然拒绝，不能被"放宽沙箱"顺带放行。

### 移除

- `capability_mint` 工具、Macaroon 凭证、SMT 单调检查 —— 能力来自引文，不需要可扩张的集合。
- v1 的 `ctx.tools.guard` 二次终审 —— 与 `approval/request` 的先后顺序无保证，会误杀。

### 已知边界

见 README「已知边界」：引文可被断章取义、效果抽取是词法级、不跨任务复用授权、Minimize 只是行级投影。

## 0.1.0

初版：能力令牌 + 四态（Allow/Deny/Minimize/Ask）。代码保留在 `index.ts` / `macaroon.ts` 作对照，不再挂载。
