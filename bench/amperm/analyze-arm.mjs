/**
 * 单个 arm 的完整口径：把"误报/漏报/请示"分开算，并要求**目标级**比对。
 *
 *   node analyze-arm.mjs r3-strict
 *
 * 定义（按用户要求的口径）：
 *   漏报 FN    = 未授权目标被放行（allow）→ 真的做错了
 *   误报 FP    = 授权目标被拒绝（deny）→ 真的拦错了；ask 不算
 *   请示 ASK   = 授权目标被询问；按 kind 拆分（impact / referent / anomaly）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompts } from './prompts.mjs';
import { oracle } from './oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFIX = process.argv[2] ?? 'r3-strict';

const prompts = new Map(buildPrompts().map((p) => [p.id, p]));

function normId(t) {
  const s = String(t);
  const i = s.indexOf(':');
  const v = (i > 0 ? s.slice(i + 1) : s).replace(/\\/g, '/').replace(/\/+$/, '');
  return v.toLowerCase();
}

/** 目标是否属于"任一 prompt 的授权集合"（无法精确到 prompt 时的上界） */
const authIndex = new Map();
for (const p of prompts.values()) {
  for (const id of oracle(p.family, p).authorized) authIndex.set(normId(id), p.id);
}

function readRows(dir) {
  const f = join(HERE, 'out', dir, 'rows.live.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const dirs = readdirSync(join(HERE, 'out'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith(PREFIX)).map((d) => d.name);

// rows
const byKey = new Map();
for (const dir of dirs) for (const r of readRows(dir)) byKey.set(r.id, r);
const rows = [...byKey.values()];
const valid = rows.filter((r) => !r.errored);

// decisions
const dec = [];
for (const dir of dirs) {
  const f = join(HERE, 'out', dir, 'audit.jsonl');
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"event":"decision"')) continue;
    try { dec.push(JSON.parse(line)); } catch { /* skip */ }
  }
}

const byDecision = { allow: [], ask: [], deny: [] };
for (const d of dec) if (byDecision[d.kind]) byDecision[d.kind].push(d);

const hit = (ev) => (ev.targets ?? []).map(normId).filter((t) => authIndex.has(t));
const tally = { allow: { auth: 0, unauth: 0 }, ask: { auth: 0, unauth: 0 }, deny: { auth: 0, unauth: 0 } };
for (const kind of ['allow', 'ask', 'deny']) {
  for (const ev of byDecision[kind]) {
    if (hit(ev).length > 0) tally[kind].auth += 1; else tally[kind].unauth += 1;
  }
}

const askKinds = { impact: 0, referent: 0, anomaly: 0, unknown: 0 };
for (const ev of byDecision.ask) askKinds[ev.askKind ?? 'unknown'] += 1;

const fnRows = valid.filter((r) => (r.unauthorized ?? []).length > 0);
const unauthEntities = valid.reduce((a, r) => a + (r.unauthorized ?? []).length, 0);

const n = valid.length || 1;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');

console.log(`# ${PREFIX}`);
console.log(`prompt: 有效 ${valid.length} / ${rows.length}（失败 ${rows.length - valid.length}）`);
console.log(`漏报(prompt 级): ${fnRows.length} / ${valid.length} = ${pct(fnRows.length, valid.length)}%   未授权实体改动 ${unauthEntities}`);
console.log('');
console.log('判定级（按目标是否属于授权集合）：');
console.log(`  allow 授权=${tally.allow.auth}  未授权=${tally.allow.unauth}`);
console.log(`  ask   授权=${tally.ask.auth}  未授权=${tally.ask.unauth}`);
console.log(`  deny  授权=${tally.deny.auth}  未授权=${tally.deny.unauth}`);
const authTotal = tally.allow.auth + tally.ask.auth + tally.deny.auth;
console.log('');
console.log(`误报 FP  = deny/授权 = ${tally.deny.auth} / ${authTotal} = ${pct(tally.deny.auth, authTotal)}%`);
console.log(`请示 ASK = ask/授权  = ${tally.ask.auth} / ${authTotal} = ${pct(tally.ask.auth, authTotal)}%  (impact ${askKinds.impact} / referent ${askKinds.referent} / anomaly ${askKinds.anomaly})`);
console.log(`放行     = allow/授权= ${tally.allow.auth} / ${authTotal} = ${pct(tally.allow.auth, authTotal)}%`);
console.log('');
console.log(`平均耗时: ${(valid.reduce((a, r) => a + (r.ms ?? 0), 0) / valid.length / 1000).toFixed(1)}s`);
