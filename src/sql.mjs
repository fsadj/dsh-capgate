/**
 * SQL 语义：把一条语句映射到效果代数（read / write / delete）。
 *
 * 为什么需要它：
 *   没有这一层，数据库操作会掉进 `other` → 只能靠 LLM 编译器猜 → 而且表名
 *   不是路径，作用域判定失效 → 实际上"一律问人"。
 *   题目要求"文件系统 + 数据库"两种粒度，这一层就是数据库那一半的地基。
 *
 * 明确不做的事：不连数据库、不解析执行计划、不判断权限。
 * 只回答：这条语句**是什么效果**、**碰到哪些表**、**是不是无条件**。
 */

const READ = /^(select|with|show|describe|desc|explain|pragma|values)\b/i;
const WRITE = /^(insert|update|upsert|merge|create|alter|grant|revoke|comment|replace|copy)\b/i;
const DELETE = /^(delete|truncate|drop)\b/i;

const TABLE_PATTERNS = [
  /\bfrom\s+([A-Za-z_][\w.$"]*)/gi,
  /\bjoin\s+([A-Za-z_][\w.$"]*)/gi,
  /\binto\s+([A-Za-z_][\w.$"]*)/gi,
  /\bupdate\s+([A-Za-z_][\w.$"]*)/gi,
  /\btable\s+(?:if\s+(?:not\s+)?exists\s+)?([A-Za-z_][\w.$"]*)/gi,
];

function stripComments(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
}

function firstKeyword(sql) {
  const m = /^\(*\s*([A-Za-z]+)/.exec(sql);
  return m ? m[1].toLowerCase() : '';
}

/**
 * @param {string} text 可能是纯 SQL，也可能是 `psql -c "..."`
 * @returns {{op:'read'|'write'|'delete', tables:string[], whereClause:boolean,
 *            destructive:boolean, statement:string} | undefined}
 */
export function sqlEffect(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return undefined;

  // 从 -c / -e / --command 后面取语句；否则把整段当语句
  const quoted = /-c\s+(["'])([\s\S]*?)\1/.exec(raw);
  const candidate = stripComments(quoted ? quoted[2] : raw);
  const kw = firstKeyword(candidate);
  if (!kw) return undefined;
  if (!READ.test(candidate) && !WRITE.test(candidate) && !DELETE.test(candidate)) return undefined;

  const op = READ.test(candidate) ? 'read' : WRITE.test(candidate) ? 'write' : 'delete';
  const tables = new Set();
  for (const re of TABLE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of candidate.matchAll(re)) {
      const t = String(m[1]).replace(/["`]/g, '').trim();
      if (t && !/^(select|values|dual)$/i.test(t)) tables.add(t.toLowerCase());
    }
  }

  const whereClause = /\bwhere\b/i.test(candidate);
  const destructive = op === 'delete' && (/^(drop|truncate)\b/i.test(candidate) || !whereClause);
  return { op, tables: [...tables], whereClause, destructive, statement: candidate.slice(0, 300) };
}

/** 从工具参数里挑出可能含 SQL 的字段。 */
export function sqlFromArgs(args) {
  if (!args || typeof args !== 'object') return undefined;
  for (const key of ['query', 'sql', 'statement', 'command', 'cmd', 'script']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) {
      const r = sqlEffect(v);
      if (r) return r;
    }
  }
  return undefined;
}
