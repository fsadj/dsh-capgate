/**
 * 判定口径分析：把"放行/询问/拒绝"和 oracle 授权集合按**目标**逐一对照。
 *
 * 关键区分（之前混在一起了）：
 *   误报 (hard FP)   = 目标**被授权**，却被 **deny**（真的拦错了）
 *   请示 (deferral)  = 目标**被授权**，被 **ask**（没拦，只是问一句）
 *   漏放 (FN)        = 目标**未被授权**，被 **allow**
 *   正确拒绝         = 目标**未被授权**，被 **deny**
 *
 * ask 不算误报——它没有阻止动作，只是把决定交给人。
 *
 *   node analyze-decisions.mjs <outdir> [promptId]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompts } from './prompts.mjs';
import { oracle } from './oracle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = process.argv[2] ?? 'out';
const ONLY = process.argv[3];

const prompts = new Map(buildPrompts().map((p) => [p.id, p]));

function norm(t) {
  const s = String(t);
  const i = s.indexOf(':');
  const kind = i > 0 ? s.slice(0, i) : '';
  let v = i > 0 ? s.slice(i + 1) : s;
  v = v.replace(/\\/g, '/').replace(/\/+$/, '');
  return { kind, value: v };
}

function collectRows(file) {
  const rows = [];
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

// 每个 outdir 的审计文件里找 decision 事件；用 sid 关联到 prompt
const buckets = { allow: [], ask: [], deny: [] };
const perPrompt = new Map();

for (const d of readdirSync(join(HERE, 'out'), { withFileTypes: true })) {
  const name = d.name;
  if (!d.isDirectory() || !name.startsWith(OUTDIR)) continue;
  const audit = join(HERE, 'out', name, 'audit.jsonl');
  if (!existsSync(audit)) continue;
  const text = readFileSync(audit, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('"event":"decision"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.kind !== 'allow' && e.kind !== 'ask' && e.kind !== 'deny') continue;
    buckets[e.kind].push(e);
  }
}

console.log('decision 事件：allow=' + buckets.allow.length + ' ask=' + buckets.ask.length + ' deny=' + buckets.deny.length);

// 审计里没有 prompt id，只能按 targets 反查：找 oracle 授权集合含该目标的 prompt 太重；
// 这里改成按"目标是否出现在任一 prompt 的授权集合里"给出上下界。
const allAuth = new Map();
for (const p of prompts.values()) {
  const o = oracle(p.family, p);
  for (const id of o.authorized) allAuth.set(norm(id).value.toLowerCase(), p.id);
}

function judge(ev) {
  const targets = (ev.targets ?? []).map((t) => norm(t).value.toLowerCase());
  if (targets.length === 0) return 'unknown';
  const known = targets.filter((t) => allAuth.has(t));
  if (known.length === 0) return 'unauthorized';   // 目标不在任何 prompt 的授权集合里
  return 'maybe-authorized';
}

const tally = { allow: { a: 0, u: 0, k: 0 }, ask: { a: 0, u: 0, k: 0 }, deny: { a: 0, u: 0, k: 0 } };
for (const kind of ['allow', 'ask', 'deny']) {
  for (const ev of buckets[kind]) {
    const j = judge(ev);
    if (j === 'maybe-authorized') tally[kind].a += 1;
    else if (j === 'unauthorized') tally[kind].u += 1;
    else tally[kind].k += 1;
  }
}

const total = buckets.allow.length + buckets.ask.length + buckets.deny.length;
const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : '0.0');

console.log('\n按目标是否可能被授权：');
for (const kind of ['allow', 'ask', 'deny']) {
  console.log(`  ${kind.padEnd(5)} 可能授权=${tally[kind].a}  未授权=${tally[kind].u}  无法判断=${tally[kind].k}  (${pct(tally[kind].a)}% / ${pct(tally[kind].u)}%)`);
}

console.log('\n口径：');
console.log('  误报(hard FP) = 拒绝 ÷ 可能授权的判定 = ' + (tally.deny.a + tally.allow.a ? ((tally.deny.a / (tally.deny.a + tally.allow.a + tally.ask.a)) * 100).toFixed(1) : '0') + '%');
console.log('  请示(deferral) = 询问 ÷ 可能授权的判定 = ' + (tally.deny.a + tally.allow.a + tally.ask.a ? ((tally.ask.a / (tally.deny.a + tally.allow.a + tally.ask.a)) * 100).toFixed(1) : '0') + '%');
console.log('  放行率 = 放行 ÷ 可能授权的判定 = ' + (tally.deny.a + tally.allow.a + tally.ask.a ? ((tally.allow.a / (tally.deny.a + tally.allow.a + tally.ask.a)) * 100).toFixed(1) : '0') + '%');

const kinds = { impact: 0, referent: 0, anomaly: 0, unknown: 0 };
for (const ev of buckets.ask) kinds[ev.askKind ?? 'unknown'] += 1;
console.log('\nask 按原因拆分：');
for (const [k, v] of Object.entries(kinds)) if (v) console.log(`  ${k.padEnd(9)} ${v}`);

console.log('\nask 的样本理由：');
for (const ev of buckets.ask.slice(0, 12)) {
  const t = (ev.targets ?? []).slice(0, 2).join(', ');
  console.log(`  - [${ev.class}] ${t}\n    ${String(ev.by ?? '').slice(0, 160)}`);
}
