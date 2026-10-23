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
export function discover({ kind, target, cwd } = {}) {
  const facts = [];
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
