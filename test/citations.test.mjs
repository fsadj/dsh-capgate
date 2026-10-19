import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCitation, citationSupports, collectInstructionTexts } from '../src/citations.mjs';
import { parseShell, effectOf, classify } from '../src/classify.mjs';

const ROOT = 'C:/repo';
const texts = (t) => [{ text: t, seq: 0, source: 'user' }];

test('逐字出现才算引文', () => {
  assert.ok(findCitation(texts('把 src/app.js 里的 bug 改掉'), 'C:/repo/src/app.js'));
  assert.equal(findCitation(texts('把 src/app.js 里的 bug 改掉'), 'C:/repo/src/other.js'), undefined);
});

test('成词边界：文件名不能被子串命中', () => {
  assert.equal(findCitation(texts('看 src/app.json 配置'), 'C:/repo/src/app.js'), undefined);
});

test('动词不匹配则引文不成立', () => {
  const c = findCitation(texts('看一下 src/app.js'), 'C:/repo/src/app.js');
  const del = classify(parseShell('Remove-Item src/app.js', ROOT), { root: ROOT });
  assert.ok(c);
  assert.equal(citationSupports(c, del), false, '“看一下”不能支持删除');
});

test('疑问句不支持删除', () => {
  const c = findCitation(texts('要不要删掉 src/app.js？'), 'C:/repo/src/app.js');
  const del = classify(parseShell('Remove-Item src/app.js', ROOT), { root: ROOT });
  assert.equal(citationSupports(c, del), false);
});

test('明确的删除指令支持删除', () => {
  const c = findCitation(texts('删掉 src/legacy.js，它没用了'), 'C:/repo/src/legacy.js');
  const del = classify(parseShell('Remove-Item src/legacy.js', ROOT), { root: ROOT });
  assert.equal(citationSupports(c, del), true);
});

test('越界路径要求至少两级，防止只提文件名就越界', () => {
  const c = findCitation(texts('看看 notes.txt'), 'C:/secrets/notes.txt');
  const read = classify(effectOf('read', { path: 'C:/secrets/notes.txt' }, ROOT), { root: ROOT });
  assert.ok(c, '单级 basename 能匹配到');
  assert.equal(citationSupports(c, read), false, '但不足以支持越界访问');
});

test('会话面读取：只取人类指令', () => {
  const agent = {
    session: {
      id: 's1',
      header: { cwd: ROOT },
      surface: { nodes: [0, 1] },
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '用户说的话' }] } },
        { type: 'user/message', data: { source: { kind: 'agent-message' }, content: [{ type: 'text', text: '子 agent 转述' }] } },
      ]),
    },
  };
  const got = collectInstructionTexts(agent);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '用户说的话');
});
