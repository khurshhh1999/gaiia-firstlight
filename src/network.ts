// FirstLight migration model: NetBox → gaiia prefix sync for one POP.
//
// Follows the documented behaviour of gaiia's NetBox integration: prefixes are matched to a
// Network Site by exact, case-sensitive name; only site-scoped prefixes sync; an IPAM role filter
// can exclude prefixes; full sync is additive; deletes missed while the webhook could not match
// must be removed by hand. Fixtures use documentation address ranges.

export type ScopeType = 'site' | 'region' | 'vrf' | 'none';
export interface NetboxPrefix { id: string; cidr: string; scope: { type: ScopeType; name: string }; role: string | null; description: string }
export interface IpBlock { id: string; cidr: string; origin: 'netbox' | 'manual'; description: string }
export interface Migration {
  netboxSite: string;
  gaiiaSite: { name: string; referenceId: string };
  roleFilter: string[];
  prefixes: NetboxPrefix[];
  blocks: IpBlock[];                  // IP Blocks on the gaiia Network Site
  activeAddresses: Record<string, number>; // per prefix, from the operator's BNG lease export
  compared: boolean;                // false until the first full sync diffs NetBox against gaiia
  log: string[];
}

export function initialMigration(): Migration {
  return {
    // NetBox renamed the site during a naming cleanup. gaiia still has the old name, so the association broke.
    netboxSite: 'Valley-POP-01',
    gaiiaSite: { name: 'valley-pop-01', referenceId: 'NB-SITE-14' },
    roleFilter: ['customer-access'],
    prefixes: [
      { id: 'n1', cidr: '192.0.2.0/25', scope: { type: 'site', name: 'Valley-POP-01' }, role: 'customer-access', description: 'Residential IPv4 pool' },
      { id: 'n2', cidr: '2001:db8:10::/48', scope: { type: 'site', name: 'Valley-POP-01' }, role: 'customer-access', description: 'Residential IPv6 delegation pool' },
      { id: 'n3', cidr: '192.0.2.128/25', scope: { type: 'region', name: 'Juniper Valley' }, role: 'customer-access', description: 'Business pool' },
      { id: 'n4', cidr: '10.20.0.0/24', scope: { type: 'site', name: 'Valley-POP-01' }, role: 'infrastructure', description: 'OLT management' },
    ],
    blocks: [
      { id: 'b1', cidr: '192.0.2.0/25', origin: 'netbox', description: 'Residential IPv4 pool' },
      { id: 'b2', cidr: '198.51.100.0/24', origin: 'netbox', description: 'Legacy pool' },
      { id: 'b3', cidr: '203.0.113.0/25', origin: 'netbox', description: 'Residential IPv4 pool B' },
      { id: 'b4', cidr: '203.0.113.128/25', origin: 'manual', description: 'Static business customers' },
    ],
    activeAddresses: { '192.0.2.0/25': 41, '198.51.100.0/24': 0, '203.0.113.0/25': 14, '203.0.113.128/25': 3 },
    compared: false,
    log: [],
  };
}

export type PrefixState = 'synced' | 'missing' | 'site-mismatch' | 'not-site-scoped' | 'role-filtered';
export type BlockState = 'in-sync' | 'stale' | 'stale-in-use' | 'manual';

export function classifyPrefix(m: Migration, p: NetboxPrefix): PrefixState {
  if (p.scope.type !== 'site') return 'not-site-scoped';
  if (m.roleFilter.length && !(p.role && m.roleFilter.includes(p.role))) return 'role-filtered';
  if (p.scope.name !== m.gaiiaSite.name) return 'site-mismatch';
  return m.blocks.some(b => b.cidr === p.cidr) ? 'synced' : 'missing';
}

export function classifyBlock(m: Migration, b: IpBlock): BlockState {
  if (b.origin === 'manual') return 'manual';
  if (m.prefixes.some(p => p.cidr === b.cidr)) return 'in-sync';
  return (m.activeAddresses[b.cidr] ?? 0) > 0 ? 'stale-in-use' : 'stale';
}

export function audit(m: Migration) {
  const prefixes = m.prefixes.map(p => ({ prefix: p, state: classifyPrefix(m, p) }));
  const blocks = m.blocks.map(b => ({ block: b, state: classifyBlock(m, b) }));
  const count = <T extends string>(list: { state: T }[], s: T) => list.filter(x => x.state === s).length;
  return {
    prefixes, blocks,
    nameMatches: m.netboxSite === m.gaiiaSite.name,
    missing: count(prefixes, 'missing'),
    mismatched: count(prefixes, 'site-mismatch'),
    stale: count(blocks, 'stale'),
    staleInUse: count(blocks, 'stale-in-use'),
  };
}

/** updateNetworkSite: rename the gaiia site to match NetBox, the source of truth. Blocks stay on the same site record. */
export function renameGaiiaSite(m: Migration, name: string): Migration {
  if (!name || name === m.gaiiaSite.name) return m;
  return { ...m, gaiiaSite: { ...m.gaiiaSite, name },
    log: [...m.log, `updateNetworkSite: renamed “${m.gaiiaSite.name}” to “${name}”. IP Blocks, inventory and tickets stay attached to site ${m.gaiiaSite.referenceId}.`] };
}

/** Workflow “Import Network Site Prefixes - Full Sync”. Additive: it never removes blocks. */
export function fullSync(m: Migration): Migration {
  const states = m.prefixes.map(p => ({ p, s: classifyPrefix(m, p) }));
  const created = states.filter(x => x.s === 'missing').map(x => ({ id: `sync-${x.p.id}`, cidr: x.p.cidr, origin: 'netbox' as const, description: x.p.description }));
  const n = (s: PrefixState) => states.filter(x => x.s === s).length;
  const synced: Migration = { ...m, blocks: [...m.blocks, ...created], compared: true };
  const after = audit(synced);
  return { ...synced,
    log: [...m.log, `Full sync (instance “Default”): ${created.length} created, ${n('synced')} already present, ${n('site-mismatch')} skipped with no Network Site named “${m.netboxSite}”, ${n('role-filtered')} outside the role filter, ${n('not-site-scoped')} not site-scoped. 0 removed.`,
      ...(m.compared ? [] : [`Compared gaiia IP Blocks with NetBox: ${after.stale + after.staleInUse} integration block(s) no longer exist in NetBox, ${after.staleInUse} of them still carrying subscribers.`])] };
}

/** removeIpBlocksFromNetworkSite, guarded: integration-created, no longer in NetBox, and holding no live subscriber addresses. */
export function removeStaleBlock(m: Migration, cidr: string): { migration: Migration; removed: boolean } {
  const block = m.blocks.find(b => b.cidr === cidr);
  if (!block) return { migration: m, removed: false };
  if (!m.compared) return { migration: { ...m, log: [...m.log, `Refused to remove ${cidr}: run a full sync first so gaiia is compared with NetBox.`] }, removed: false };
  const state = classifyBlock(m, block);
  const refuse = (why: string) => ({ migration: { ...m, log: [...m.log, `Refused to remove ${cidr}: ${why}`] }, removed: false });
  if (state === 'manual') return refuse('it was created by hand in gaiia, outside the integration’s ownership.');
  if (state === 'in-sync') return refuse('NetBox still has this prefix.');
  if (state === 'stale-in-use') return refuse(`NetBox says it was deleted, but ${m.activeAddresses[cidr]} subscriber addresses are still live in it. Escalated to network engineering.`);
  return { removed: true, migration: { ...m, blocks: m.blocks.filter(b => b !== block),
    log: [...m.log, `removeIpBlocksFromNetworkSite: removed ${cidr}. It was integration-created, deleted in NetBox while the site name did not match, and has 0 active addresses.`] } };
}

/** Network engineering confirms an in-use prefix is still live and restores it in NetBox; the webhook keeps the block. */
export function restoreInNetbox(m: Migration, cidr: string): Migration {
  const block = m.blocks.find(b => b.cidr === cidr);
  if (!m.compared || !block || classifyBlock(m, block) !== 'stale-in-use') return m;
  const prefix: NetboxPrefix = { id: `restored-${block.id}`, cidr, scope: { type: 'site', name: m.netboxSite }, role: 'customer-access', description: block.description };
  return { ...m, prefixes: [...m.prefixes, prefix],
    log: [...m.log, `NetBox: re-created ${cidr} on ${m.netboxSite} after network engineering confirmed it is live. The gaiia block is kept.`] };
}

// Topology mirrors gaiia inventory upstream/downstream links. Account status follows gaiia's
// “Add Accounts from Network Sites” rule: only active services count as impacted.
export type AccountStatus = 'active' | 'suspended' | 'pending';
export interface Device { id: string; label: string; upstream: string[]; account?: string; service?: string; status?: AccountStatus }
export const topology: Device[] = [
  { id: 'agg', label: 'POP aggregation · Valley-POP-01', upstream: [] },
  { id: 'olt', label: 'OLT-01 · PON 1/2', upstream: ['agg'] },
  { id: 'splitter', label: 'Splitter SP-07 (1:32)', upstream: ['olt'] },
  { id: 'ap', label: 'Tower-03 · sector A', upstream: ['agg'] },
  { id: 'ont1', label: 'ONT-042', upstream: ['splitter'], account: 'JV-1042', service: 'Fiber 1000', status: 'active' },
  { id: 'ont2', label: 'ONT-043', upstream: ['splitter'], account: 'JV-1043', service: 'Fiber 500', status: 'active' },
  { id: 'ont3', label: 'ONT-045', upstream: ['splitter'], account: 'JV-1045', service: 'Fiber 500', status: 'suspended' },
  { id: 'ont4', label: 'ONT-046', upstream: ['splitter'], account: 'JV-1046', service: 'Fiber 1000', status: 'pending' },
  { id: 'sm1', label: 'Radio-018', upstream: ['ap'], account: 'JV-1044', service: 'Wireless 100', status: 'active' },
  { id: 'sm2', label: 'Radio-019', upstream: ['ap'], account: 'JV-1042', service: 'Backup wireless 50', status: 'active' },
];

/** Downstream walk from the changed device. Terminates on cycles; counts each account once. */
export function impact(root: string, devices: Device[] = topology) {
  const reached = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const d of devices) if (!reached.has(d.id) && d.upstream.some(u => reached.has(u))) { reached.add(d.id); changed = true; }
  }
  const inScope = devices.filter(d => reached.has(d.id));
  const services = inScope.filter(d => d.account);
  const active = services.filter(d => d.status === 'active');
  return {
    devices: inScope, services, active,
    accounts: [...new Set(active.map(d => d.account!))],
    excluded: services.filter(d => d.status === 'suspended'),
    pending: services.filter(d => d.status === 'pending'),
  };
}

export interface Attestations { notice: boolean; rollback: boolean }
export interface Gate { name: string; passed: boolean; owner: string; detail: string; kind: 'computed' | 'attested' }
export function cutoverGates(m: Migration, a: Attestations): Gate[] {
  const r = audit(m);
  const notCompared = 'Not compared yet. Run a full sync.';
  return [
    { kind: 'computed', name: 'Site name matches NetBox', owner: 'Network engineering', passed: r.nameMatches,
      detail: r.nameMatches ? `gaiia and NetBox both use “${m.netboxSite}”.` : `NetBox “${m.netboxSite}” vs gaiia “${m.gaiiaSite.name}”. Webhooks for this site are being skipped silently.` },
    { kind: 'computed', name: 'In-scope prefixes present in gaiia', owner: 'Network engineering', passed: m.compared && r.missing + r.mismatched === 0,
      detail: !m.compared ? notCompared : r.missing + r.mismatched === 0 ? 'Every site-scoped, in-filter prefix has an IP Block.' : `${r.missing + r.mismatched} prefix(es) not yet in gaiia.` },
    { kind: 'computed', name: 'Stale blocks resolved', owner: 'Network engineering', passed: m.compared && r.stale + r.staleInUse === 0,
      detail: !m.compared ? notCompared : r.stale + r.staleInUse === 0 ? 'No integration blocks left without a NetBox prefix.' : `${r.stale} safe to remove, ${r.staleInUse} still carrying live subscribers.` },
    { kind: 'attested', name: 'Maintenance notice sent to impacted accounts', owner: 'Customer success', passed: a.notice, detail: 'Confirmed by the implementation lead.' },
    { kind: 'attested', name: 'Rollback configuration captured', owner: 'Network engineering', passed: a.rollback, detail: 'OLT and aggregation configuration saved before the window.' },
  ];
}

/** What activation sees of the site: the site record's current name and its IP Blocks. */
export function siteContext(m: Migration) {
  return { name: m.gaiiaSite.name, blocks: m.blocks.map(b => b.cidr) };
}
