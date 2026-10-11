# dsh-capgate

**Capability-based auto-approval enhancement for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

把 dsh 的审批模式从"逐调用弹窗/allowlist"重构为**摊销授权**:任务时一次铸造能力令牌(策略∩计划),运行时微秒级确定性复核,未覆盖调用走一次性升级,规则文档从每次 Ask/Deny 中学习。

## 它做什么

| 状态 | 行为 | LLM 调用 |
|---|---|---|
| **Allow** | 调用在铸造能力集内 → 直接过 | 0 |
| **Deny** | 策略外/规则命中 → 拒 + 义务说明 | 0 |
| **Minimize** | 允许的宽读 → 结果投影到任务实体(最小充分视图) | 0 |
| **Ask** | 能力缺失的策略内工具 → 一次性批准 → 执行 | 0 |

核心主张:**安全判断里凡是可以确定性封闭的部分就不交给 LLM**。本插件零 LLM 调用——铸造/验证/执法/投影全部确定性,同输入必同输出。

## 快速开始

前提:[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 已安装(`pnpm install` 完成)。

```bash
# 1) 克隆本仓库到任意位置
git clone https://github.com/you/dsh-capgate.git
cd dsh-capgate

# 2) 链接 dsh 的 tools 包(插件需要 defineTool)
mkdir -p node_modules/@deepseek-ai
ln -s /path/to/deepseek-harness/packages/core/tools node_modules/@deepseek-ai/dsh-tools

# 3) 在 dsh profile 里注册插件
#    编辑 $DSH_HOME/profiles/<你的profile>/cordis.patch.yml:
```

```yaml
- insert:
    - id: capgate-plugin
      name: '/absolute/path/to/dsh-capgate/index.ts'
      config:
        mode: 'capgate'
        protectedTools: ['write', 'edit', 'bash']
        protectedPrefixes: ['mcp__']
        memberTools: ['write', 'edit', 'bash', 'send_email', 'send_money']
        approvalMode: 'auto'     # auto=一次批准自动授 / manual=一律问人 / deny=一概拒
        ttlMinutes: 480
        rulesPath: './rules_doc.json'
```

```bash
# 4) 运行
pnpm dsh --profile <你的profile> "你的任务"
```

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `'capgate'` | `'standard'` = 插件休眠,走 dsh 原生审批 |
| `protectedTools` | 写类+破坏类 | 需要能力令牌的工具名列表 |
| `protectedPrefixes` | `['mcp__']` | 前缀匹配的受保护工具(全部 MCP 工具默认纳管) |
| `memberTools` | 常用读写 | 可走一次性批准的工具集(策略内) |
| `minimizeReads` | `['read','read_logs','read_file']` | Minimize 投影的读类工具 |
| `approvalMode` | `'auto'` | `auto`=策略内一次批准自动授 / `manual`=走 UI 人工 / `deny`=一概拒 |
| `ttlMinutes` | `480` | 能力令牌有效期(分钟) |
| `rulesPath` | 插件目录 | 规则文档落盘路径 |

## 工作原理

```
任务开始 → capability_mint(策略∩计划) → 能力令牌(Macaroon,HMAC-SHA1)
    ↓
每次工具调用:
    守卫(单调,µs):tool ∈ permits ? → Allow / Deny
    未覆盖 → 一次性批准(answerer,策略内 auto/策略外拒)
    读类结果 → Minimize 投影(最小充分视图)
    规则文档学习(allow 侧长能力 / deny 侧单例立案)
```

三条设计原则:
1. **人审不是提权通道**——批准仅授本次,持久能力只能经铸造面
2. **deny 侧单例立案**——一次拒绝即学习,同模式下次零打扰直拒
3. **基线变化 → deny 记忆失效**——重铸后旧拒绝不再误伤

## 消融旋钮(A/B 测试)

```bash
CAPGATE_DISABLED=1   # 插件休眠(裸 dsh 对照)
CAPGATE_MINIMIZE=0   # 关 Minimize 投影
CAPGATE_LEARN=0      # 关规则文档学习
CAPGATE_APPROVAL=deny  # 强制一概拒姿态
```

## 文件

| 文件 | 说明 |
|---|---|
| `index.ts` | 插件本体(四态执法+铸造工具+审批 answerer) |
| `macaroon.ts` | Macaroon 令牌(HMAC-SHA1,第一方 caveat,~40 行) |
| `experiments/agentdojo_bridge.py` | AgentDojo→MCP 桥(消融实验用,插件运行不需要) |

## 消融实验初步数据(AgentDojo banking,3 臂 × 任务)

| 臂 | utility | 攻击拦截 | 打断次数 |
|---|---|---|---|
| 裸 dsh(无插件) | 取决于 agent | 无 | 0 |
| 一概拒(无铸造) | 0% | 100% | 0 |
| **本插件** | **取决于任务** | **100%** | **O(任务)而非 O(调用)** |

*初步数据基于 qwen27b + AgentDojo banking 套件,详见 24 号文档。*

## License

MIT
