import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, cutoverGates, fullSync, impact, initialMigration, removeStaleBlock, renameGaiiaSite, restoreInNetbox } from '../src/network.ts';

const repaired = () => fullSync(renameGaiiaSite(initialMigration(), 'Valley-POP-01'));

test('before the rename, full sync creates nothing: the site name does not match exactly', () => {
  const m = fullSync(initialMigration());
  assert.equal(m.blocks.length, initialMigration().blocks.length);
  assert.equal(audit(m).mismatched, 2);
  assert.match(m.log[0], /0 created.*2 skipped/);
});

test('region-scoped and role-filtered prefixes never sync, by design', () => {
  const a = audit(repaired());
  assert.equal(a.prefixes.find(p => p.prefix.cidr === '192.0.2.128/25')?.state, 'not-site-scoped');
  assert.equal(a.prefixes.find(p => p.prefix.cidr === '10.20.0.0/24')?.state, 'role-filtered');
});

test('rename then sync adds only the IPv6 pool, and repeating the sync changes nothing', () => {
  const m = repaired();
  assert.deepEqual(m.blocks.map(b => b.cidr).filter(c => !initialMigration().blocks.some(b => b.cidr === c)), ['2001:db8:10::/48']);
  assert.equal(audit(m).missing, 0);
  assert.deepEqual(fullSync(m).blocks, m.blocks);
});

test('removal is refused for in-use and manual blocks and allowed for a free stale block', () => {
  const m = repaired();
  const inUse = removeStaleBlock(m, '203.0.113.0/25');
  assert.equal(inUse.removed, false);
  assert.match(inUse.migration.log.at(-1)!, /14 subscriber addresses/);
  assert.equal(removeStaleBlock(m, '203.0.113.128/25').removed, false);
  const free = removeStaleBlock(m, '198.51.100.0/24');
  assert.equal(free.removed, true);
  assert.equal(audit(free.migration).stale, 0);
});

test('restoring an in-use prefix in NetBox resolves it without deleting anything', () => {
  const m = restoreInNetbox(repaired(), '203.0.113.0/25');
  assert.equal(audit(m).staleInUse, 0);
  assert.ok(m.blocks.some(b => b.cidr === '203.0.113.0/25'));
});

test('sign-offs cannot pass a gate that the data fails', () => {
  const all = { notice: true, rollback: true };
  assert.equal(cutoverGates(initialMigration(), all).every(g => g.passed), false);
  const clean = restoreInNetbox(removeStaleBlock(repaired(), '198.51.100.0/24').migration, '203.0.113.0/25');
  assert.ok(cutoverGates(clean, all).every(g => g.passed));
  assert.equal(cutoverGates(clean, { ...all, rollback: false }).every(g => g.passed), false);
});

test('impact counts only active services, and each account once', () => {
  const pon = impact('olt');
  assert.deepEqual(pon.accounts, ['JV-1042', 'JV-1043']);
  assert.deepEqual(pon.excluded.map(s => s.account), ['JV-1045']);
  assert.deepEqual(pon.pending.map(s => s.account), ['JV-1046']);
  const pop = impact('agg');
  assert.equal(pop.accounts.length, 3);
  assert.equal(pop.active.length, 4);
});

test('traversal terminates on cycles and shared descendants', () => {
  const r = impact('a', [
    { id: 'a', label: 'A', upstream: ['b'] }, { id: 'b', label: 'B', upstream: ['a'] },
    { id: 'c', label: 'C', upstream: ['a', 'b'], account: 'one', status: 'active' },
  ]);
  assert.equal(r.devices.length, 3);
  assert.deepEqual(r.accounts, ['one']);
});
