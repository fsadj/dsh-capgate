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

/** 静态检查只覆盖我们真正看得懂的语言；其它一律不可分析（保持不透明）。 */
const ANALYZABLE = /\.(mjs|cjs|jsx?|tsx?)$/i;

/**
 * 严重 API：命中任意一条 → **否决**（即使被用户点名也问人）。
 * 这些是"脚本自己决定后果"的特征：起子进程、写/删盘、出网、动态执行。
 */
const SEVERE = [
  [/require\(\s*['"]child_process['"]\s*\)/, 'child_process'],
  [/from\s+['"](node:)?child_process['"]/, 'child_process'],
  [/\b(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/, 'spawn'],
  [/\.?(write|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|createReadStream)\s*\(/, 'fs.write'],
  [/\.?(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|truncate|truncateSync)\s*\(/, 'fs.delete'],
  [/\.?(mkdir|mkdirSync|copyFile|copyFileSync|chmod|chmodSync)\s*\(/, 'fs.write'],
  [/from\s+['"](node:)?(net|http|https|dgram|tls|dns)['"]/, 'network'],
  [/\b(fetch|http\.request|https\.request|net\.connect|axios|got)\s*[.(]/, 'network'],
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function\s*\(/, 'Function'],
  [/\bimport\s*\(/, 'dynamic-import'],
  [/\bDeno\.(run|writeFile|remove)\b/, 'deno'],
  [/process\.(exit|kill)\s*\(/, 'process'],
];

/**
 * 提示级：只说明"脚本会读文件"，不构成否决。
 * 用户点名要跑一个读文件的脚本，本来就该允许——读什么由脚本决定，
 * 但读到的内容不会因为我们没拦就离开本机（出网在上面的严重级里）。
 */
const NOTEWORTHY = [
  [/from\s+['"](node:)?fs['"]/, 'reads-files'],
  [/require\(\s*['"]fs['"]\s*\)/, 'reads-files'],
  [/\breadFile(Sync)?\s*\(/, 'reads-files'],
  [/\b(fs\.)?(readdir|stat|lstat|access)(Sync)?\s*\(/, 'reads-files'],
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
    // 语言闸门：只分析我们看得懂的脚本，其它一律保持"不透明"。
    if (!ANALYZABLE.test(String(target ?? ''))) {
      return { kind: 'risky', facts: [{ type: 'script.unsupported_language', target }], reason: '静态检查只覆盖 JS/TS 脚本，其它语言按不透明处理' };
    }
    const text = fromSession ? content : readFileSync(target, 'utf8');
    facts.push({ type: 'script.source', target, value: fromSession ? 'session-read' : 'fs' });
    const hits = [];
    for (const [re, name] of SEVERE) {
      if (re.test(text)) hits.push(name);
    }
    const notes = [];
    for (const [re, name] of NOTEWORTHY) {
      if (re.test(text)) notes.push(name);
    }
    facts.push({ type: 'script.size', target, value: size ?? Buffer.byteLength(text, 'utf8') });
    if (hits.length > 0) {
      facts.push({ type: 'script.risky_apis', target, value: [...new Set(hits)] });
      return { kind: 'risky', facts, reason: `脚本引用了 ${[...new Set(hits)].join(', ')}` };
    }
    if (notes.length > 0) facts.push({ type: 'script.reads_files', target, value: [...new Set(notes)] });
    facts.push({ type: 'script.no_severe_api', target, value: true });
    return { kind: 'ok', facts };
  } catch (err) {
    return { kind: 'unreadable', facts: [{ type: 'script.unreadable', target, value: String(err && err.message ? err.message : err) }] };
  }
}
