import type { Rehearsal } from './engine.ts';

export interface RunRecord { id: number; label: string; before: Rehearsal; after: Rehearsal }

/** Before/after view of the simulated world for one attempt. */
export function comparison(record: RunRecord) {
  const row = (name: string, pick: (r: Rehearsal) => string | number) => ({ name, before: pick(record.before), after: pick(record.after) });
  const service = (r: Rehearsal) => r.world.ont.service ? `${r.world.ont.service.serviceTemplate} · ${r.world.ont.service.account}` : 'None';
  return [
    row('ONT service', service),
    row('ONT Rx (dBm)', r => r.world.ont.rxDbm.toFixed(1)),
    row('Account status', r => r.world.accountStatus),
    row('SMx requests', r => r.world.controllerRequests),
    row('SMx writes applied', r => r.world.controllerWrites),
    row('Activate Account calls', r => r.world.activateRequests),
    row('Activation notices', r => r.world.notifications),
    row('Open exceptions', r => r.world.exceptions.filter(e => e.open).length),
  ];
}
