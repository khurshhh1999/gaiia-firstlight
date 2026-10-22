import { RETRY, RX_MAX_DBM, RX_MIN_DBM, faults, steps } from './engine.ts';
import type { CalixConfig, Check, Order, Rehearsal, Resolution } from './engine.ts';
import { audit } from './network.ts';
import type { Gate, Migration } from './network.ts';
import type { RunRecord } from './lab.ts';

export interface BriefInput {
  migration: Migration; gates: Gate[]; config: CalixConfig; order: Order;
  checks: Check[]; resolution?: Resolution; rehearsal: Rehearsal; records: RunRecord[];
}

/** The implementation handoff, generated from the current rehearsal state. */
export function implementationBrief(b: BriefInput): string {
  const a = audit(b.migration);
  const w = b.rehearsal.world;
  const product = b.config.products.find(p => p.product === b.order.product);
  const ont = b.config.onts.find(o => o.model === b.order.ont.model);
  const list = (xs: string[]) => xs.length ? xs.map(x => `- ${x}`).join('\n') : '- None';
  return `# Juniper Valley Fiber: go-live handoff (${b.order.key})

Prepared with FirstLight by Khursheed Khan. Fictional operator; NetBox, Calix SMx and gaiia are simulated. This is a design and evidence document, not an importable workflow.

## 1. NetBox migration (CHG-021, ${b.migration.netboxSite})

**Decision:** ${b.gates.every(g => g.passed) ? 'ready for the customer’s change approval.' : 'hold.'}

| Gate | Owner | Status | Detail |
|---|---|---|---|
${b.gates.map(g => `| ${g.name} | ${g.owner} | ${g.passed ? 'Pass' : 'Hold'} | ${g.detail} |`).join('\n')}

Prefixes: ${a.prefixes.map(p => `\`${p.prefix.cidr}\` ${p.state}`).join(', ')}.
IP Blocks: ${a.blocks.map(x => `\`${x.block.cidr}\` ${x.state}`).join(', ')}.

Operation log:
${list(b.migration.log)}

Operating rules for this customer:
- Site names are the join key between NetBox and gaiia. Rename only together, and run a full sync afterwards.
- Full sync is additive. After any webhook outage or name mismatch, compare NetBox against gaiia and remove stale blocks by hand.
- Never remove a block that still has live subscriber addresses. Restore it in NetBox or plan a renumber.

## 2. Activation preflight

Calix product mapping for ${b.order.product}: template \`${product?.serviceTemplate || '—'}\`, untagged \`${product?.untaggedPolicyMap || '—'}\`, tagged \`${product?.taggedPolicyMap || '—'}\`.
ONT mapping for ${b.order.ont.model}: profile \`${ont?.ontProfile || '—'}\`, ${ont?.variant ?? '—'}, port \`${ont?.mainPort || '—'}\`.
${b.resolution ? `Resolved: **${b.resolution.serviceTemplate}** with **${b.resolution.policyMap}** (${b.resolution.variant}).` : 'Not resolved: preflight is blocked.'}

| Check | Result | Detail |
|---|---|---|
${b.checks.map(c => `| ${c.label} | ${c.severity} | ${c.detail} |`).join('\n')}

## 3. Workflow design

| Step | gaiia node | Behaviour |
|---|---|---|
| Trigger | Event or Webhook | Order ready for activation; the order key is the idempotency key. |
${steps.map(s => `| ${s.title} | ${s.node} | ${s.description} |`).join('\n')}

Node settings: ${RETRY.attempts} attempts with ${RETRY.backoffSeconds.join(' s, ')} s backoff. After a timeout, route to a read-back branch rather than a blind retry. Verification window: ${RX_MIN_DBM} to ${RX_MAX_DBM} dBm (GPON class B+; replace with the customer's thresholds).

Failure handling:
${faults.filter(f => f.value !== 'none').map(f => `- **${f.label}.** ${f.description}`).join('\n')}

## 4. Rehearsal evidence

- Status: ${b.rehearsal.status} after ${b.rehearsal.runs} run(s)
- SMx: ${w.controllerRequests} requests, ${w.controllerWrites} writes applied
- Activate Account: ${w.activateRequests} calls, ${w.activations} activation(s), ${w.notifications} customer notice(s)
- ONT: ${w.ont.service ? `${w.ont.service.serviceTemplate}/${w.ont.service.policyMap} for ${w.ont.service.account}` : 'no service'}, Rx ${w.ont.rxDbm.toFixed(1)} dBm
- Exceptions: ${w.exceptions.length ? w.exceptions.map(e => `${e.id} ${e.title} (${e.open ? 'open' : 'closed'})`).join('; ') : 'none'}

Attempts:
${list(b.records.map(r => `#${r.id} ${r.label}: ${r.before.status} → ${r.after.status}; +${r.after.world.controllerWrites - r.before.world.controllerWrites} SMx writes, +${r.after.world.notifications - r.before.world.notifications} notices`))}

Event log:
${b.rehearsal.events.map(e => `${e.seq}. [run ${e.run} · ${e.step} · ${e.status}] ${e.message}`).join('\n') || '- No runs yet'}

## 5. Before production

- Confirm the service templates, policy maps and ONT profiles against the customer's SMx.
- Agree the optical thresholds and the post-activation checks with their NOC.
- Decide the billing trigger with finance. Activate Account starts pending subscriptions and notifies the customer.
- Load-test the read-back path against SMx rate limits, and set failure alerts on the workflow.

Sources: gaiia NetBox Integration, Network Sites, Workflow Builder Overview, Configuring Calix Product Mapping (support.gaiia.com).
`;
}
