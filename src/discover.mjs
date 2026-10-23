/**
 * 环境事实采集：不把"归属"写成规则，而是把**判断所需的事实**取回来交给审查者。
 *
 * 之前踩过的坑：用户说"清我的分支"，我们把 bob/x 当成普通路径放行了——
 * 然后试图在提示词里加一条"my 就要匹配 owner"的规则。这是错的方向：
 * 下次换个约定（团队前缀、LDAP 组、K8s namespace、云账号 ID），规则又得改。
 *
 * 正确做法：给审查者**事实**，让它自己判：
 *   - 我是谁（git config user.name/email、当前账号）
 *   - 这个仓库的远端是谁
 *   - 每个引用是谁提交的、多久没动
 *   - 目标路径在不在工作区、属主是谁
 *
 * 这些命令都是只读的；新约定只要能落到这些事实里，就不需要改代码。
 */
import { spawnSync } from 'node:child_process';

const TIMEOUT = 4000;
const MAX_LINES = 40;

function run(cmd, args, cwd) {
  try {
    const r = spawnSync(cmd, args, { cwd, timeout: TIMEOUT, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return '';
    return String(r.stdout ?? '').trim();
  } catch {
    return '';
  }
}

const clip = (s, n = MAX_LINES) => String(s).split('\n').slice(0, n).join('\n');

/** 我是谁：git 身份 + 系统账号 */
export function identityFacts(cwd) {
  const facts = [];
  const name = run('git', ['config', 'user.name'], cwd);
  const mail = run('git', ['config', 'user.email'], cwd);
  if (name) facts.push(`git user.name = ${name}`);
  if (mail) facts.push(`git user.email = ${mail}`);
  const who = process.env.USERNAME || process.env.USER || '';
  if (who) facts.push(`os user = ${who}`);
  return facts;
}

/** 仓库里的引用：谁提交的、最后一次提交多久以前 */
export function refFacts(cwd) {
  const out = run('git', ['for-each-ref', '--sort=-committerdate',
    '--format=%(refname:short)\t%(authorname)\t%(authoremail)\t%(committerdate:relative)'], cwd);
  if (!out) return [];
  const lines = out.split('\n').slice(0, MAX_LINES);
  return ['refs (name | author | email | last commit):', ...lines.map((l) => `  ${l.replace(/\t/g, ' | ')}`)];
}

/** 远端：仓库归属哪个组织/账号 */
export function remoteFacts(cwd) {
  const out = run('git', ['remote', '-v'], cwd);
  return out ? ['remotes:', ...out.split('\n').slice(0, 6).map((l) => `  ${l}`)] : [];
}

/**
 * 按目标种类取事实。没有对应种类的，就给通用事实（工作在不在工作区、目录里有什么）。
 * @returns {string[]}
 */
export function discover({ kind, target, cwd, dirs } = {}) {
  const facts = [];
  // 任何目标都先带一条"它在工作区记录里长什么样"的事实（通道/属主/保护标记…）。
  // 不假设文件叫 jobs.json 还是别的：只要能找到提到这个 id 的记录就摊出来。
  const scanDirs = (dirs && dirs.length ? dirs : [cwd]).filter(Boolean);
  try {
    facts.push(...recordFacts({ target, dirs: scanDirs }));
  } catch { /* 读不到就不给 */ }
  if (!cwd) return facts;
  const isRepo = run('git', ['rev-parse', '--is-inside-work-tree'], cwd) === 'true';

  if (kind === 'ref') {
    if (isRepo) {
      facts.push(...identityFacts(cwd), ...remoteFacts(cwd), ...refFacts(cwd));
      const one = run('git', ['log', '-1', '--format=%an <%ae> %ar %s', String(target)], cwd);
      if (one) facts.push(`target ref "${target}" last commit: ${one}`);
    } else {
      facts.push(`target "${target}" is a ref name; cwd is not a git repository`);
    }
    return facts;
  }

  if (kind === 'path' || kind === 'db' || kind === 'host') {
    if (isRepo) facts.push(...identityFacts(cwd), ...remoteFacts(cwd));
    return facts;
  }
  return facts;
}

/** 供审计：这次给审查者补了哪些事实 */
export function summarizeFacts(facts) {
  return facts.length ? `${facts.length} facts` : 'none';
}

export { clip };

/* ─────────── 实体元数据：从工作区里的记录文件取事实 ─────────── */

import { readdirSync, readFileSync as rf, statSync } from 'node:fs';

const MAX_FILES = 120;
const MAX_BYTES = 2 * 1024 * 1024;

/** 递归收集候选 json 文件（有界） */
function jsonFiles(root, depth = 0, acc = []) {
  if (depth > 3 || acc.length >= MAX_FILES) return acc;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = root + '/' + e.name;
    if (e.isDirectory()) jsonFiles(p, depth + 1, acc);
    else if (/\.json$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

/** 从一个任意形状的 JSON 里找出"提到该目标"的记录，把它的字段摊平 */
function recordsMentioning(value, needles, out = [], depth = 0) {
  if (depth > 6 || out.length >= 5) return out;
  if (Array.isArray(value)) {
    for (const v of value) recordsMentioning(v, needles, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    const flat = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) flat[k] = v;
    }
    const hit = Object.values(flat).some((v) => needles.includes(String(v).toLowerCase()));
    if (hit) out.push(flat);
    for (const v of Object.values(value)) {
      if (v && typeof v === 'object') recordsMentioning(v, needles, out, depth + 1);
    }
  }
  return out;
}

/**
 * 目标实体在工作区里的元数据（通道、属主、保护标记……）。
 * 不假设文件叫什么、表结构怎样——只要能找到"提到这个 id 的记录"就把它摊出来。
 */
export function recordFacts({ target, dirs = [] } = {}) {
  const facts = [];
  if (!target) return facts;
  const raw = String(target).replace(/^[a-z]+:/, '');
  const base = raw.split(/[\\/]/).pop();
  const needles = [...new Set([raw.toLowerCase(), (base ?? '').toLowerCase()].filter(Boolean))];
  if (needles.length === 0) return facts;

  for (const dir of dirs) {
    for (const file of jsonFiles(dir)) {
      let text;
      try {
        if (statSync(file).size > MAX_BYTES) continue;
        text = rf(file, 'utf8');
      } catch { continue; }
      const lower = text.toLowerCase();
      if (!needles.some((n) => lower.includes(n))) continue;
      let doc;
      try { doc = JSON.parse(text); } catch { continue; }
      const recs = recordsMentioning(doc, needles);
      for (const rec of recs.slice(0, 2)) {
        const shown = Object.entries(rec).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(', ');
        facts.push(`record in ${file.split(/[\\/]/).pop()}: ${shown}`);
      }
      if (facts.length >= 4) return facts;
    }
  }
  return facts;
}