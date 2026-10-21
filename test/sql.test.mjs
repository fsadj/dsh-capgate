import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlEffect, sqlFromArgs } from '../src/sql.mjs';
import { effectOf, locksOf, classify } from '../src/classify.mjs';

test('SELECT / WITH / EXPLAIN / SHOW → read', () => {
  for (const s of [
    'SELECT id, email FROM users LIMIT 10',
    'with t as (select 1) select * from t',
    'EXPLAIN SELECT * FROM orders',
    'show tables',
  ]) {
    assert.equal(sqlEffect(s).op, 'read', s);
  }
});

test('INSERT / UPDATE / CREATE / ALTER → write', () => {
  for (const s of [
    "INSERT INTO users (id) VALUES (1)",
    "UPDATE users SET email='x' WHERE id=1",
    'CREATE TABLE t (id int)',
    'ALTER TABLE t ADD COLUMN c int',
  ]) {
    assert.equal(sqlEffect(s).op, 'write', s);
  }
});

test('DELETE / DROP / TRUNCATE → delete，且区分有没有 WHERE', () => {
  const withWhere = sqlEffect('DELETE FROM users WHERE id = 1');
  assert.equal(withWhere.op, 'delete');
  assert.equal(withWhere.destructive, false);

  const noWhere = sqlEffect('DELETE FROM users');
  assert.equal(noWhere.op, 'delete');
  assert.equal(noWhere.destructive, true, '无 WHERE 的 DELETE 等同批量删除');

  assert.equal(sqlEffect('DROP TABLE users').destructive, true);
  assert.equal(sqlEffect('TRUNCATE TABLE users').destructive, true);
});

test('能认出表名（from / join / into / update / table）', () => {
  const r = sqlEffect('select * from users u join orders o on u.id=o.uid');
  assert.deepEqual(r.tables.sort(), ['orders', 'users']);
});

test('能处理 psql -c "..." 与注释', () => {
  const r = sqlEffect(`psql -c "delete from orders where id < 100"`);
  assert.equal(r.op, 'delete');
  assert.deepEqual(r.tables, ['orders']);

  const c = sqlEffect('-- comment\nselect 1');
  assert.equal(c.op, 'read');
});

test('不是 SQL 就不认（避免把普通命令当数据库操作）', () => {
  assert.equal(sqlEffect('node demo.mjs'), undefined);
  assert.equal(sqlEffect('Get-ChildItem'), undefined);
  assert.equal(sqlEffect(''), undefined);
});

test('sqlFromArgs 从 query/sql/statement 字段取', () => {
  assert.equal(sqlFromArgs({ query: 'select 1' }).op, 'read');
  assert.equal(sqlFromArgs({ sql: 'delete from t' }).op, 'delete');
  assert.equal(sqlFromArgs({ command: 'select 1' }).op, 'read');
  assert.equal(sqlFromArgs({ foo: 'bar' }), undefined);
});

test('工具分类：sql 工具按语句效果归类，目标带 db: 前缀', () => {
  const eff = effectOf('sql', { query: 'select id from users' }, 'C:/repo');
  assert.equal(eff.op, 'read');
  assert.equal(eff.source, 'sql');
  assert.deepEqual(eff.targets.map((t) => t.kind), ['db']);
  assert.match(eff.targets[0].value, /^db:users$/);
});

test('shell 里的 psql 也能归类', () => {
  const eff = effectOf('pwsh', { command: 'psql -c "select count(*) from orders"' }, 'C:/repo');
  assert.equal(eff.op, 'read');
  assert.equal(eff.source, 'sql');
});

test('无 WHERE 的 DELETE 带 batch 锁；带 WHERE 的不带', () => {
  const noWhere = effectOf('sql', { query: 'delete from users' }, 'C:/repo');
  const k1 = classify(noWhere, 'workspace');
  assert.ok(locksOf(k1, noWhere).includes('batch'), '批量删除必须锁');

  const withWhere = effectOf('sql', { query: 'delete from users where id=1' }, 'C:/repo');
  const k2 = classify(withWhere, 'workspace');
  assert.ok(!locksOf(k2, withWhere).includes('batch'));
});
