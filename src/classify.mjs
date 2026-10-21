/**
 * 效果抽取与效果类判定（纯函数，无 DSH 依赖，可单测）。
 *
 * 设计要点：判定单元是"效果类"而不是"工具名"、也不是"计划"。
 *   类 = (op, scope, sensitivity, cardinality)
 * 首次触达某类 → 问一次；同类后续免费。预测错了没有代价，因为第一次用就会问。
 */

/**
 * 敏感路径：凭据、密钥、浏览器配置、密钥库。
 * 只按"目录名 / 文件名"判定（不读内容），并且刻意**宁可多报**：
 * 误报的代价是一次确认，漏报的代价是凭据泄漏。
 */
const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.kube', '.docker', '.gnupg', '.git-credentials.d']);

const SENSITIVE_BASENAME = new RegExp(
  '^(' + [
    '\\.env(\\..*)?',                    // .env / .env.local
    'id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?',
    '[^/]*\\.(pem|key|pfx|p12|kdbx)',    // 私钥 / 证书 / 密钥库
    '\\.(npmrc|netrc|pypirc|git-credentials)',
    '(credentials|secrets?)(\\..*)?',    // credentials.json / secrets.yaml
    '(Login Data|Cookies|keychain[^/]*|wallet\\.dat)',
  ].join('|') + ')$',
  'i',
);

/**
 * 命令动词按"每段命令的第一个词"判定，而不是全文关键词匹配。
 * 否则 `Get-Content cordis.patch.yml` 会因为文件名里有 "patch" 被判成写。
 */
const CMD_SETS = {
  send: new Set(['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'scp', 'sftp', 'ssh', 'send-mailmessage']),
  delete: new Set(['rm', 'del', 'erase', 'remove-item', 'rmdir', 'rd', 'unlink', 'shred']),
  write: new Set(['set-content', 'add-content', 'out-file', 'tee', 'new-item', 'touch', 'mkdir', 'cp', 'copy', 'mv', 'move', 'cp', 'rsync']),
  execute: new Set(['npm', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pip', 'cargo', 'go', 'make', 'pytest', 'jest', 'vitest', 'tsc', 'docker', 'kubectl', 'terraform', 'gradle', 'mvn', 'git']),
  read: new Set(['cat', 'type', 'get-content', 'head', 'tail', 'less', 'more', 'rg', 'grep', 'find', 'dir', 'ls', 'get-childitem', 'read', 'view', 'show', 'jq']),
  /** 解释器：命令文本看不出真实效果（可联网、可写盘、可删），一律按"不透明执行"处理。 */
  interpreter: new Set(['node', 'python', 'python3', 'deno', 'bun', 'ruby', 'perl', 'php', 'pwsh', 'powershell', 'bash', 'sh', 'cmd', 'wsl', 'osascript']),
};

/** 取一段命令的第一个词（去掉路径前缀与 .exe/.cmd 后缀）。 */
function firstWord(segment) {
  const token = String(segment).trim().split(/\s+/)[0] ?? '';
  const bare = token.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? '';
  return bare.toLowerCase().replace(/\.(exe|cmd|ps1|sh)$/, '');
}

const REDIRECT_RE = /(^|\s)>{1,2}(\s|$)/;

/**
 * 命令分段：`;` `|` `&` 之外，**换行也算分段**。
 * 多行 PowerShell 脚本是最常见的形态；不按换行切，
 * 整段会被当成"一个以 $变量 开头的命令"，动词永远判不出来。
 */
const SEGMENT_SPLIT = /[;|&\n\r]+/;

/** 块作用域：`{ ... }` / `( ... )` 里的内层命令也要单独看。 */
const BLOCK_SPLIT = /[{}()]+/;

const SHELL_WRAP = /\b(?:bash|sh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-c|-command|\/c)\s+(["'])([\s\S]*)\1/i;

/** 归一化路径为 `C:/a/b` 形式（不做真实文件系统解析）。 */
export function normalizePath(p, cwd = 'C:/') {
  if (p === undefined || p === null || p === '') return String(cwd ?? '').replace(/\\/g, '/');
  let s = String(p).trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  // 展开常见环境变量：$env:NAME / $NAME / %NAME%（只展开进程里真实存在的）
  s = s.replace(/(?:\$env:|\$)USERPROFILE/gi, (process.env.USERPROFILE ?? 'C:/Users/me').replace(/\\/g, '/'));
  s = s.replace(/%USERPROFILE%/gi, (process.env.USERPROFILE ?? 'C:/Users/me').replace(/\\/g, '/'));
  s = s.replace(/(?:\$env:|\$)HOME/gi, (process.env.HOME ?? process.env.USERPROFILE ?? 'C:/Users/me').replace(/\\/g, '/'));
  s = s.replace(/%HOME%/gi, (process.env.HOME ?? process.env.USERPROFILE ?? 'C:/Users/me').replace(/\\/g, '/'));
  if (s.startsWith('~')) s = (process.env.USERPROFILE ?? 'C:/Users/me').replace(/\\/g, '/') + s.slice(1);
  if (/^[A-Za-z]:/.test(s)) { /* absolute */ }
  else if (s.startsWith('/')) s = 'C:' + s;
  else s = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + s;
  // 盘符单独保存，`..` 只能回退到盘符根，不能把盘符弹掉
  const drive = /^[A-Za-z]:/.exec(s)?.[0] ?? '';
  let rest = drive ? s.slice(drive.length) : s;
  const out = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  const joined = out.join('/');
  return drive ? `${drive}/${joined}`.replace(/\/+$/, '') || `${drive}/` : joined;
}

export function isSensitivePath(p) {
  const norm = String(p).replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);
  if (segments.some((s) => SENSITIVE_DIRS.has(s.toLowerCase()))) return true;
  const base = segments[segments.length - 1] ?? '';
  return SENSITIVE_BASENAME.test(base);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

function looksLikePath(t) {
  return /^[A-Za-z]:[\\/]/.test(t) || /[\\/]/.test(t) || t === '*' ||
    /^\.[\w.-]+$/.test(t) || /\.\w{1,8}$/.test(t);
}

/** 解析一条 shell 命令为效果；`depth` 防止无限拆包。 */
export function parseShell(command, cwd, depth = 0) {
  let text = String(command ?? '');
  const wrapped = depth < 4 && SHELL_WRAP.test(text);
  if (wrapped) text = text.replace(SHELL_WRAP, (_m, _q, inner) => String(inner));

  // `cmd /c del ...`、`powershell -c "..."`：内层命令带不带引号都要拆开，
  // 否则整条会被当成一个叫 cmd 的执行、把里面的删除藏起来。
  const UNQUOTED_WRAP = /^\s*(?:cmd(?:\.exe)?\s+\/[ck]|(?:powershell|pwsh)(?:\.exe)?\s+(?:-c|-command)|bash\s+-c)\s+([\s\S]+)$/i;
  if (depth < 4) text = text.replace(UNQUOTED_WRAP, (_m, inner) => String(inner));

  // 按段取第一个词判动词：`Get-Content cordis.patch.yml` 是读，不是写
  const verbs = text
    .split(SEGMENT_SPLIT)
    .flatMap((seg) => seg.split(BLOCK_SPLIT))
    .map(firstWord)
    .filter(Boolean);
  const hasVerb = (set) => verbs.some((v) => set.has(v));
  const redirects = REDIRECT_RE.test(text);

  // 没有"动词"的删除：.NET API、robocopy /MOV（移动 = 删源）
  const API_DELETE = /\]::Delete(?:Directory|File)?\s*\(/i.test(text)
    || /\bSystem\.IO\b[\s\S]{0,40}\bDelete(?:Directory|File)?\s*\(/i.test(text);
  const ROBO_MOVE = /\brobocopy\b[^;|&]*\/(?:mov|move)\b/i.test(text);

  // `node --version` / `git --help` 这类只查版本、不跑脚本的调用，
  // 效果等于"读环境信息"，按读处理；否则会被当成不透明执行、每次都问。
  const PLAIN_QUERY = /^\s*(?:node|nodejs|python3?|deno|bun|ruby|perl|php|java|go|cargo|npm|pnpm|yarn|git|docker|kubectl|pwsh|powershell)\s+(?:--?v(?:ersion)?|--?h(?:elp)?)\s*;?\s*$/i;
  const plainQuery = !redirects && PLAIN_QUERY.test(text);

  // 一个动词都没认出来 → **不许当读**。
  // 这是三次真实漏放的共同根因：`.NET API`、`robocopy /MOV`、`cmd /c del` 都因为
  // "没匹配到动词"退化成 read，然后被"项目外普通读"快路静默放行。
  // 未知命令一律降到 'other'，交给"问人"而不是"放行"。
  // "证明是无害的"并不等于"看起来像读"。这些构造能把一段文字变成另一段命令，
  // 一旦出现，就不能再声称这条命令只是读——必须降级为未知、交给人。
  const SUBSTITUTION = /\$\(|`[^`]*`|\biex\b|Invoke-Expression|EncodedCommand|base64\s+-d|\beval\b/i.test(text);
  const BARE_STRING = /^\s*["'][^"']*["']\s*;?\s*$/;

  const anyKnownVerb = hasVerb(CMD_SETS.send) || hasVerb(CMD_SETS.delete)
    || hasVerb(CMD_SETS.write) || hasVerb(CMD_SETS.execute) || hasVerb(CMD_SETS.read);
  const unknown = !plainQuery && !API_DELETE && !ROBO_MOVE && !anyKnownVerb;
  const rawOp = (API_DELETE || ROBO_MOVE) ? 'delete'
    : hasVerb(CMD_SETS.send) ? 'send'
    : hasVerb(CMD_SETS.delete) ? 'delete'
    : (hasVerb(CMD_SETS.write) || redirects) ? 'write'
    : hasVerb(CMD_SETS.execute) ? 'execute'
    : unknown ? 'other'
    : 'read';
  // 只有"能被证明只是读"的命令才算读：
  //   - 每个分段的首词都在读动词表里（或整条只是一个字符串字面量）
  //   - 没有重定向、没有命令替换/反引号/iex/base64 解码
  // 任何一条不满足 → 降级为 other（问人），而不是猜成读。
  const provenRead = !plainQuery && !SUBSTITUTION && !redirects && !API_DELETE && !ROBO_MOVE
    && (BARE_STRING.test(text) || (hasVerb(CMD_SETS.read) && !hasVerb(CMD_SETS.send)
      && !hasVerb(CMD_SETS.delete) && !hasVerb(CMD_SETS.write) && !hasVerb(CMD_SETS.execute)));

  const op = plainQuery || provenRead ? 'read' : (rawOp === 'read' ? 'other' : rawOp);

  // 不透明执行：跑解释器/脚本时，真实效果（可能联网、写盘、删东西）藏在脚本里，
  // 命令文本看不出来。这类一律当作"未知效果"，不允许模型复核直接放行。
  const opaque = !plainQuery && op === 'execute' && verbs.some((v) => CMD_SETS.interpreter.has(v));

  // 循环/管道驱动的删除与写入，目标集合在运行时才确定 → 按"批量"处理。
  // 但必须要求"删除动作本身"在循环里或由管道喂进来，且动词要有词边界
  // （否则 `| Format-Table` 里的 "rm" 会把整条命令误判成批量）。
  const DEL_WRITE = String.raw`(?:^|[\s;|{(&])(?:Remove-Item|rm|del|erase|rmdir|rd|Set-Content|Out-File|Add-Content)\b`;
  const loopDriven = (op === 'delete' || op === 'write') && (
    new RegExp(`(?:foreach|ForEach-Object)\\b[\\s\\S]{0,300}?${DEL_WRITE}`, 'i').test(text)
    || new RegExp(`\\|[^|]{0,120}?${DEL_WRITE}`, 'i').test(text)
  );

  const targets = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'，。)）]+/g)) {
    const host = hostOf(m[0]);
    if (host) targets.push({ kind: 'host', value: host });
  }
  const wantPaths = op !== 'send' || targets.length === 0;
  if (wantPaths) {
    const tokens = text.split(/[\s;|&]+/);
    let lastToken = '';
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i].replace(/^["']|["']$/g, '').replace(/^@/, '');
      if (!t || t.startsWith('-') || /^https?:/i.test(t)) continue;
      // Windows 命令行开关用 `/`：`whoami /groups` 里的 /groups 不是路径。
      // （真机采样时这几个开关被当成 `C:/groups`，把只读命令判成了"项目外"）
      if (process.platform === 'win32' && /^\/[A-Za-z?]{1,12}$/.test(t)) continue;
      // `$var` 是运行时才知道的值，不是字面路径；但 `$env:`/`$HOME` 是真实路径
      if (/^\$(?!env:|HOME|USERPROFILE\b)/i.test(t)) continue;
      const fw = firstWord(t);
      const isVerb = CMD_SETS.delete.has(fw) || CMD_SETS.read.has(fw) || CMD_SETS.write.has(fw);
      // 裸分词只在前一个"非开关"词是删除/写命令时当目标（`Remove-Item -Force build`）
      const prevIsVerb = CMD_SETS.delete.has(lastToken) || CMD_SETS.write.has(lastToken);
      if (isVerb) { lastToken = fw; continue; }
      const wildToken = /[*?]/.test(t);
      if (looksLikePath(t) || (prevIsVerb && !wildToken)) {
        targets.push({ kind: 'path', value: normalizePath(t, cwd) });
      }
      lastToken = fw;
    }
  }
  if (targets.length === 0) targets.push({ kind: 'path', value: normalizePath('.', cwd) });

  // 通配只认"目标里的通配"，不认命令别处出现的 `*`：
  // `Get-ChildItem | Where-Object { $_.Name -like '*steam*' }` 里的 * 只是过滤条件。
  const wildcard = loopDriven || targets.some((t) => t.kind === 'path' && /[*?]/.test(t.value));

  return {
    op,
    targets,
    wildcard,
    wrapped,
    opaque,
    source: 'shell',
    raw: text.slice(0, 400),
  };
}

const FS_FIELD_ORDER = ['path', 'file_path', 'filePath', 'target', 'dir', 'directory'];

/** 参数里哪些字段名像"路径"（含复数与常见变体）。 */
const PATH_FIELD_RE = /^(.*(path|file|dir|folder|target|dest|dst|src|source)s?)$/i;
/** 参数里哪些字段名像"外发目标"。 */
const HOST_FIELD_RE = /^(.*(url|uri|endpoint|host|webhook|callback)s?)$/i;

const SCHEMA_OP_HINTS = [
  ['send', /(upload|publish|post|send|submit|share|push|webhook|notify|tweet|email)/i],
  ['delete', /(delete|remove|\brm\b|destroy|trash|purge|drop|unlink|erase)/i],
  ['write', /(write|create|save|edit|update|put|append|mkdir|move|rename|copy|patch|apply)/i],
  ['execute', /(exec|run|command|shell|spawn|invoke|script|eval)/i],
  ['read', /(read|get|list|search|query|fetch|view|show|describe|stat|glob|grep)/i],
];

function collectByField(args, re) {
  const out = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!re.test(k)) continue;
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.push(x.trim());
  }
  return out;
}

/**
 * 用**工具自己声明的 schema** 推效果，而不是猜命令文本。
 *
 * 这是泛化到第三方/MCP 工具的关键：参数类型就是效果类型，
 * 工具名字撒谎也没用（名字只用来提示 op，路径/URL 参数才是事实）。
 *
 * @param definition - tools 注册表里的定义（含 name / description / parameters）
 * @returns 效果对象；推不出时返回 undefined，交给调用方回退
 */
export function effectOfSchema(definition, args, cwd) {
  const name = String(definition?.name ?? '');
  const desc = String(definition?.description ?? '');
  const hay = `${name} ${desc}`;
  const a = args && typeof args === 'object' ? args : {};

  const paths = collectByField(a, PATH_FIELD_RE);
  const hosts = collectByField(a, HOST_FIELD_RE);

  let op = 'other';
  // 名字比描述更可信：先在名字里找动词，找不到再看描述。
  const fromName = SCHEMA_OP_HINTS.find(([, re]) => re.test(name));
  const fromDesc = () => SCHEMA_OP_HINTS.find(([, re]) => re.test(desc));
  if (/read[- ]?only/i.test(desc) || /read[- ]?only/i.test(name)) op = 'read';
  else if (fromName) op = fromName[0];
  else {
    const d = fromDesc();
    if (d) op = d[0];
  }

  // schema 里完全没有路径/URL 参数，又推不出 op → 不知道（保留 other）
  if (paths.length === 0 && hosts.length === 0 && op === 'other') return undefined;

  const targets = [
    ...hosts.map((h) => ({ kind: 'host', value: hostOf(h) ?? h.toLowerCase() })),
    ...paths.map((p) => ({ kind: 'path', value: normalizePath(p, cwd) })),
  ];
  if (targets.length === 0) targets.push({ kind: 'path', value: normalizePath('.', cwd) });

  // URL 里塞了长参数 = 在用 GET 外带数据，按外发处理（否则"读网页"会变成数据出口）
  const urlCarriesData = hosts.some((h) => {
    const q = String(h).split('?')[1] ?? '';
    return q.length > 40 || /[=][A-Za-z0-9+/_-]{32,}/.test(q);
  });

  return {
    op: urlCarriesData ? 'send' : (op === 'other' && hosts.length > 0 ? 'send' : op),
    targets,
    wildcard: paths.some((p) => /[*?]/.test(p)),
    opaque: false,
    source: 'schema',
    raw: `${name}(${Object.keys(a).join(',')})`,
  };
}

/** 工具调用 → 效果。未知工具按 `other` 处理（→ 一定问人）。 */
export function effectOf(tool, args, cwd) {
  const a = args && typeof args === 'object' ? args : {};
  const pickPath = () => {
    for (const f of FS_FIELD_ORDER) if (typeof a[f] === 'string') return a[f];
    return undefined;
  };

  if (tool === 'bash' || tool === 'pwsh' || tool === 'shell' || tool === 'run_command') {
    return parseShell(a.command ?? a.cmd ?? a.script ?? '', cwd);
  }
  if (tool === 'send_email' || tool === 'send_money' || tool === 'http_post') {
    return { op: 'send', targets: [{ kind: 'host', value: String(a.host ?? a.to ?? 'unknown').toLowerCase() }], wildcard: false, source: 'tool', raw: tool };
  }
  if (['read', 'glob', 'grep', 'list', 'view'].includes(tool)) {
    return { op: 'read', targets: [{ kind: 'path', value: normalizePath(pickPath() ?? '.', cwd) }], wildcard: /[*?]/.test(pickPath() ?? ''), source: 'tool', raw: tool };
  }
  if (['write', 'edit', 'apply_patch', 'create'].includes(tool)) {
    return { op: 'write', targets: [{ kind: 'path', value: normalizePath(pickPath() ?? '.', cwd) }], wildcard: /[*?]/.test(pickPath() ?? ''), source: 'tool', raw: tool };
  }
  if (['delete', 'remove', 'rm', 'unlink'].includes(tool)) {
    return { op: 'delete', targets: [{ kind: 'path', value: normalizePath(pickPath() ?? '.', cwd) }], wildcard: /[*?]/.test(pickPath() ?? ''), source: 'tool', raw: tool };
  }
  return { op: 'other', targets: [{ kind: 'path', value: normalizePath(pickPath() ?? '.', cwd) }], wildcard: false, source: 'tool', raw: tool };
}

function inside(target, root) {
  // 根目录可能来自会话 header.cwd（Windows 反斜杠），必须先归一化再比较，
  // 否则 `C:\ws` 与 `C:/ws/a.txt` 永远匹配不上，整个工作区都会被判成"项目外"。
  const t = String(target).toLowerCase().replace(/\\/g, '/');
  const r = String(root ?? '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!r) return false;
  return t === r || t.startsWith(r + '/');
}

/** 取"目录前缀"作为类的作用域桶（不能把文件名算进去，否则每个文件一个类）。 */
function bucketOf(value) {
  const parts = String(value).split('/').filter(Boolean);
  const dir = parts.slice(0, -1);
  return dir.slice(0, Math.min(dir.length, 3)).join('/') || String(value);
}

/** 目标基数分桶：一条批准不能变成批量许可证。 */
export function cardinalityOf(effect) {
  if (effect.wildcard) return 'many';
  const n = effect.targets.length;
  if (n <= 1) return 'one';
  if (n <= 10) return 'few';
  return 'many';
}

/**
 * 计算效果类。
 * @param effect - effectOf/parseShell 的结果
 * @param scope - { root, namedPaths?, allowedHosts? }
 */
export function classify(effect, scope) {
  const root = scope?.root ?? 'C:/';
  const named = (scope?.namedPaths ?? []).map((p) => normalizePath(p, root));
  const allowedHosts = (scope?.allowedHosts ?? []).map((h) => String(h).toLowerCase());

  const card = cardinalityOf(effect);
  const paths = effect.targets.filter((t) => t.kind === 'path').map((t) => t.value);
  const hosts = effect.targets.filter((t) => t.kind === 'host').map((t) => t.value);

  const sensitivity = paths.some(isSensitivePath) ? 'sensitive' : 'plain';

  if (effect.op === 'send') {
    const host = hosts[0] ?? 'unknown';
    const scopeName = allowedHosts.includes(host)
      ? `host-allowed:${host}`
      : `host-other:${host}`;
    return { key: `send|${scopeName}|${sensitivity}|${card}`, op: 'send', scope: scopeName, sensitivity, cardinality: card, host };
  }

  let scopeName;
  if (paths.every((p) => inside(p, root))) scopeName = 'workspace';
  else if (named.length > 0 && paths.every((p) => named.some((n) => inside(p, n)))) scopeName = 'named:' + bucketOf(named[0]);
  else scopeName = 'outside:' + bucketOf(paths[0] ?? '');

  return {
    key: `${effect.op}|${scopeName}|${sensitivity}|${card}`,
    op: effect.op,
    scope: scopeName,
    sensitivity,
    cardinality: card,
    underRoot: paths.every((p) => inside(p, root)),
  };
}

/** 人类可读的解释（面板与审计都用这一份）。 */
export function describeClass(c) {
  const opZh = { read: '读', write: '写', delete: '删', send: '外发', execute: '执行', other: '未知操作' }[c.op] ?? c.op;
  const scopeZh = c.scope === 'workspace' ? '项目内'
    : c.scope.startsWith('outside:') ? `项目外 ${c.scope.slice(8)}`
    : c.scope.startsWith('named:') ? `指令指定的 ${c.scope.slice(6)}`
    : c.scope.startsWith('host-allowed:') ? `已授权主机 ${c.scope.slice(13)}`
    : `外部主机 ${c.scope.slice(11)}`;
  const cardZh = { one: '单个目标', few: '少量目标', many: '批量/通配' }[c.cardinality] ?? c.cardinality;
  return `${scopeZh}${c.sensitivity === 'sensitive' ? '的敏感文件' : ''} · ${opZh} · ${cardZh}`;
}
