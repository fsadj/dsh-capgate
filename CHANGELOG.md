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
- **测试与验证**：38 条单测；`npm run demo` 的 131 调用对照；`npm run e2e` 在真实 dsh 里跑四场景。

### 移除

- `capability_mint` 工具、Macaroon 凭证、SMT 单调检查 —— 能力来自引文，不需要可扩张的集合。
- v1 的 `ctx.tools.guard` 二次终审 —— 与 `approval/request` 的先后顺序无保证，会误杀。

### 已知边界

见 README「已知边界」：引文可被断章取义、效果抽取是词法级、不跨任务复用授权、Minimize 只是行级投影。

## 0.1.0

初版：能力令牌 + 四态（Allow/Deny/Minimize/Ask）。代码保留在 `index.ts` / `macaroon.ts` 作对照，不再挂载。
