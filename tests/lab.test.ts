import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, initialConfig, newRehearsal } from '../src/engine.ts';
import { fullSync, initialMigration, renameGaiiaSite, siteContext } from '../src/network.ts';
import { implementationBrief } from '../src/brief.ts';
import { comparison } from '../src/lab.ts';

test('end to end: the broken NetBox sync blocks activation until the migration is repaired', () => {
  const config = initialConfig();
  config.products[0].taggedPolicyMap = 'AIO-1000-TAG';
  const broken = execute(newRehearsal(), config, siteContext(initialMigration()), 'none');
  assert.equal(broken.status, 'blocked');
  assert.match(broken.events.at(-1)!.message, /2001:db8:10::\/48/);

  const migration = fullSync(renameGaiiaSite(initialMigration(), 'Valley-POP-01'));
  const done = execute(newRehearsal(), config, siteContext(migration), 'ack-lost-after-write');
  assert.equal(done.status, 'active');
  assert.equal(done.world.controllerWrites, 1);
});

test('the handoff brief and attempt comparison reflect the actual run', () => {
  const config = initialConfig();
  config.products[0].taggedPolicyMap = 'AIO-1000-TAG';
  const migration = fullSync(renameGaiiaSite(initialMigration(), 'Valley-POP-01'));
  const before = newRehearsal();
  const after = execute(before, config, siteContext(migration), 'controller-busy');
  const md = implementationBrief({ migration, gates: [], config, order: after.order, checks: [], rehearsal: after, records: [{ id: 1, label: 'Controller busy', before, after }] });
  assert.match(md, /SMx: 3 requests, 1 writes applied/);
  assert.match(md, /Account Management: Activate Account/);
  assert.match(md, /not an importable workflow/);
  const rows = comparison({ id: 1, label: 'x', before, after });
  assert.equal(rows.find(r => r.name === 'Account status')?.after, 'active');
});

test('attempts are labelled by what happened, not just the selected scenario', async () => {
  const { attemptLabel } = await import('../src/lab.ts');
  const config = initialConfig();
  const blockedSite = siteContext(initialMigration());
  const start = newRehearsal();
  const blocked = execute(start, config, blockedSite, 'ack-lost-after-write');
  assert.equal(attemptLabel(start, blocked, 'ack-lost-after-write'), 'Blocked in preflight');
  config.products[0].taggedPolicyMap = 'AIO-1000-TAG';
  const site = siteContext(fullSync(renameGaiiaSite(initialMigration(), 'Valley-POP-01')));
  const active = execute(blocked, config, site, 'ack-lost-after-write');
  assert.equal(attemptLabel(blocked, active, 'ack-lost-after-write'), 'Response lost after write');
  const replay = execute(active, config, site, 'ack-lost-after-write');
  assert.equal(attemptLabel(active, replay, 'ack-lost-after-write'), 'Replay delivery');
});
