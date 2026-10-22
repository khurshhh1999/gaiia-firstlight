import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, initialConfig, initialOrder, newRehearsal, preflight, recordFieldRepair, releaseForeignService } from '../src/engine.ts';
import type { CalixConfig, Fault, Rehearsal } from '../src/engine.ts';

const POOLS = { name: 'Valley-POP-01', blocks: ['192.0.2.0/25', '2001:db8:10::/48'] };
const ready = (): CalixConfig => {
  const c = initialConfig();
  c.products[0].taggedPolicyMap = 'AIO-1000-TAG';
  return c;
};
const run = (r: Rehearsal, fault: Fault = 'none', config = ready()) => execute(r, config, POOLS, fault);

test('default fixture is blocked by the empty tagged policy map and the missing IPv6 pool, with no requests sent', () => {
  const r = execute(newRehearsal(), initialConfig(), { name: 'valley-pop-01', blocks: ['192.0.2.0/25'] }, 'none');
  const { checks } = preflight(initialOrder(), initialConfig(), { name: 'valley-pop-01', blocks: ['192.0.2.0/25'] });
  assert.deepEqual(checks.filter(c => c.severity === 'block').map(c => c.id), ['product', 'pools']);
  assert.equal(r.status, 'blocked');
  assert.equal(r.world.controllerRequests, 0);
  assert.equal(r.world.activateRequests, 0);
});

test('the ONT variant chooses the policy map', () => {
  const tagged = preflight(initialOrder(), ready(), POOLS).resolution;
  assert.equal(tagged?.policyMap, 'AIO-1000-TAG');
  const bridge = ready(); bridge.onts[0].variant = 'untagged';
  assert.equal(preflight(initialOrder(), bridge, POOLS).resolution?.policyMap, 'BRIDGE-1000');
});

test('an ONT assigned to another account blocks before any write', () => {
  const order = { ...initialOrder(), ont: { ...initialOrder().ont, assignedAccount: 'JV-0977' } };
  const r = run(newRehearsal(order));
  assert.equal(r.status, 'blocked');
  assert.equal(r.world.controllerRequests, 0);
});

test('PON oversubscription warns but does not block', () => {
  const order = { ...initialOrder(), ponSoldMbps: 12000 };
  const { checks, resolution } = preflight(order, ready(), POOLS);
  assert.equal(checks.find(c => c.id === 'headroom')?.severity, 'warn');
  assert.ok(resolution);
});

test('happy path: one write, one activation, one notice', () => {
  const r = run(newRehearsal());
  assert.equal(r.status, 'active');
  assert.equal(r.world.controllerWrites, 1);
  assert.equal(r.world.activations, 1);
  assert.equal(r.world.notifications, 1);
  assert.equal(r.world.inFlight, null);
});

test('response lost after write: read-back adopts the write instead of repeating it', () => {
  const r = run(newRehearsal(), 'ack-lost-after-write');
  assert.equal(r.status, 'active');
  assert.equal(r.world.controllerRequests, 1);
  assert.equal(r.world.controllerWrites, 1);
  assert.ok(r.events.some(e => e.step === 'provision' && e.status === 'adopted'));
});

test('request lost before write: read-back finds nothing and exactly one retry writes', () => {
  const r = run(newRehearsal(), 'ack-lost-before-write');
  assert.equal(r.status, 'active');
  assert.equal(r.world.controllerRequests, 2);
  assert.equal(r.world.controllerWrites, 1);
});

test('controller busy: bounded retry with backoff and a single applied write', () => {
  const r = run(newRehearsal(), 'controller-busy');
  assert.equal(r.status, 'active');
  assert.equal(r.world.controllerRequests, 3);
  assert.equal(r.world.controllerWrites, 1);
  assert.equal(r.events.filter(e => e.status === 'retrying').length, 2);
});

test('replayed deliveries after activation cause no requests and no second notice', () => {
  let r = run(newRehearsal());
  const before = structuredClone(r.world);
  for (let i = 0; i < 10; i++) r = run(r, 'ack-lost-after-write');
  assert.equal(r.world.controllerRequests, before.controllerRequests);
  assert.equal(r.world.activateRequests, before.activateRequests);
  assert.equal(r.world.notifications, 1);
});

test('stale service from a cancelled account is never overwritten', () => {
  const r = run(newRehearsal(), 'stale-ont-config');
  assert.equal(r.status, 'conflict');
  assert.equal(r.world.ont.service?.account, 'JV-0977');
  assert.equal(r.world.controllerWrites, 0);
  assert.equal(r.world.accountStatus, 'pending');
  assert.equal(r.world.exceptions.filter(e => e.open && e.kind === 'internal-ticket').length, 1);
  const released = releaseForeignService(r);
  assert.equal(released.world.ont.service, null);
  assert.equal(released.world.exceptions.filter(e => e.open).length, 0);
  const done = run(released);
  assert.equal(done.status, 'active');
  assert.equal(done.world.ont.service?.account, 'JV-1046');
});

test('same account with a different template is a service change, not an activation', () => {
  const first = run(newRehearsal(), 'activation-api-error');
  const other = ready(); other.products[0].serviceTemplate = 'RES-1000-V2';
  const r = execute(first, other, POOLS, 'none');
  assert.equal(r.status, 'conflict');
  assert.match(r.events.at(-2)!.message, /Modify Account Service/);
});

test('low light keeps the configuration, holds activation and opens one work order', () => {
  let r = run(newRehearsal(), 'low-light');
  assert.equal(r.status, 'awaiting-field');
  assert.ok(r.world.ont.service);
  assert.equal(r.world.accountStatus, 'pending');
  assert.equal(r.world.notifications, 0);
  r = run(r, 'low-light');
  assert.equal(r.world.exceptions.filter(e => e.kind === 'work-order').length, 1, 'no duplicate work order');
  r = run(recordFieldRepair(r));
  assert.equal(r.status, 'active');
  assert.equal(r.world.controllerWrites, 1, 'configuration was kept, so nothing is rewritten');
  assert.equal(r.world.notifications, 1);
});

test('Activate Account failures leave the service verified and the customer unbilled and un-notified', () => {
  const failed = run(newRehearsal(), 'activation-api-error');
  assert.equal(failed.status, 'activation-failed');
  assert.equal(failed.world.activateRequests, 3);
  assert.equal(failed.world.accountStatus, 'pending');
  assert.equal(failed.world.notifications, 0);
  const recovered = run(failed);
  assert.equal(recovered.status, 'active');
  assert.equal(recovered.world.controllerWrites, 1);
  assert.equal(recovered.world.notifications, 1);
  assert.equal(recovered.world.exceptions.filter(e => e.open).length, 0, 'the failure ticket closes on success');
});

test('a duplicate delivery while an execution is running has no side effects', () => {
  const start = newRehearsal();
  const r = run(start, 'duplicate-in-flight');
  assert.deepEqual(r.world, start.world);
  assert.equal(r.events.at(-1)!.status, 'skipped');
});

test('a changed intent cannot reuse the order key', () => {
  const first = run(newRehearsal(), 'low-light');
  const r = run({ ...first, order: { ...first.order, planMbps: 500 } });
  assert.equal(r.status, 'blocked');
  assert.match(r.events.at(-1)!.message, /INTENT_CONFLICT/);
});

test('execute never mutates its input', () => {
  const start = newRehearsal();
  const snapshot = structuredClone(start);
  run(start, 'ack-lost-after-write');
  run(start, 'stale-ont-config');
  assert.deepEqual(start, snapshot);
});
