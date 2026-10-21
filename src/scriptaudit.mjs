/**
 * 脚本可读化：把"不透明执行"降级成"可判断"。
 *
 * 现状：`node scripts/build.mjs` 一律当作 opaque → 必问。
 * 但 agent 干活时大量在跑脚本（构建、测试、demo），这一类是打扰的最大来源。
 *
 * 这里做的是**降低不确定度**，不是证明安全：
 *   - 有界读取（默认 64KB），只做静态扫描；
 *   - 看到任何危险 API（写盘/删文件/子进程/网络/动态执行）→ 仍然不透明；
 *   - 一个都没有 → 标记 readOnly，作为"事实"交给策略，由策略决定是否放行。
 *
 * 明确不做的事：不执行脚本、不模拟运行、不相信注释。
 */
import { readFileSync, statSync, existsSync } from 'node:fs';

export const DEFAULT_MAX_BYTES = 64 * 1024;

/** 危险 API：命中任意一条，就**不再**认为脚本是只读的。 */
const DANGEROUS = [
  [/require\(\s*['"]child_process['"]\s*\)/, 'child_process'],
  [/from\s+['"]node:child_process['"]/, 'child_process'],
  [/\bexecSync?\s*\(/, 'exec'],
  [/\bspawnSync?\s*\(/, 'spawn'],
  [/\.(write|writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/, 'fs.write'],
  [/\.(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync)\s*\(/, 'fs.delete'],
  [/\bfs\.(mkdir|mkdirSync|copyFile|copyFileSync|chmod|chmodSync)\s*\(/, 'fs.write'],
  [/from\s+['"](node:)?(fs|net|http|https|dgram|tls|dns)['"]/, 'network-or-fs'],
  [/\b(fetch|http\.request|https\.request|net\.connect)\s*\(/, 'network'],
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function\s*\(/, 'Function'],
  [/\bimport\s*\(/, 'dynamic-import'],
  [/\bDeno\.(run|writeFile|remove)\b/, 'deno'],
  [/process\.(exit|kill)\s*\(/, 'process'],
];

/**
 * 检查一个脚本文件。
 * @returns {{kind:'ok'|'risky'|'unreadable'|'not-a-file', facts:object[], reason?:string}}
 */
export function inspectScript(target, { maxBytes = DEFAULT_MAX_BYTES, content } = {}) {
  const facts = [];
  try {
    const fromSession = typeof content === 'string';
    let size;
    if (!fromSession) {
      if (!target || !existsSync(target)) return { kind: 'unreadable', facts: [{ type: 'script.missing', target }] };
      const st = statSync(target);
      if (!st.isFile()) return { kind: 'not-a-file', facts: [{ type: 'script.not_a_file', target }] };
      if (st.size > maxBytes) {
        return { kind: 'risky', facts: [{ type: 'script.too_large', target, value: st.size }], reason: '脚本过大，不做静态检查' };
      }
      size = st.size;
    }
    const text = fromSession ? content : readFileSync(target, 'utf8');
    facts.push({ type: 'script.source', target, value: fromSession ? 'session-read' : 'fs' });
    const hits = [];
    for (const [re, name] of DANGEROUS) {
      if (re.test(text)) hits.push(name);
    }
    facts.push({ type: 'script.size', target, value: size ?? Buffer.byteLength(text, 'utf8') });
    if (hits.length > 0) {
      facts.push({ type: 'script.risky_apis', target, value: [...new Set(hits)] });
      return { kind: 'risky', facts, reason: `脚本引用了 ${[...new Set(hits)].join(', ')}` };
    }
    facts.push({ type: 'script.read_only', target, value: true });
    return { kind: 'ok', facts };
  } catch (err) {
    return { kind: 'unreadable', facts: [{ type: 'script.unreadable', target, value: String(err && err.message ? err.message : err) }] };
  }
}
