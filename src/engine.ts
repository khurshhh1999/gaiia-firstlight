// FirstLight activation engine.
//
// Rehearses a gaiia workflow that provisions a Calix SMx ONT and then runs
// Account Management: Activate Account. Everything is a pure function over plain data.
//
// The workflow's own record (Rehearsal) and the simulated network (World) are kept apart on purpose:
// after a timeout the workflow cannot know whether its write landed, so recovery has to read
// the device instead of trusting its own bookkeeping.

export type PolicyVariant = 'untagged' | 'tagged';

/** One row of Settings → Integrations → Calix → Product Mapping. All three values are required. */
export interface ProductMapping { product: string; serviceTemplate: string; untaggedPolicyMap: string; taggedPolicyMap: string }
/** One row of the Calix ONT Mapping: the policy-map variant is decided by the ONT model, not by the product. */
export interface OntMapping { model: string; ontProfile: string; variant: PolicyVariant; mainPort: string }
export interface CalixConfig { products: ProductMapping[]; onts: OntMapping[] }

export interface Order {
  key: string;               // order id + revision; the workflow's idempotency key
  accountId: string;
  product: string;
  planMbps: number;
  ont: { serial: string; model: string; assignedAccount: string | null };
  site: string;
  pon: string;
  ponSoldMbps: number;       // downstream already sold on this PON (other active accounts)
  servicePools: string[];    // prefixes this subscriber is addressed from
}

/** What the gaiia Network Site currently holds. Comes from the migration rehearsal. */
export interface SiteContext { name: string; blocks: string[] }

export type Severity = 'pass' | 'warn' | 'block';
export interface Check { id: string; label: string; severity: Severity; detail: string; owner: string }
export interface Resolution { serviceTemplate: string; policyMap: string; variant: PolicyVariant; ontProfile: string; mainPort: string }

export interface OntService { account: string; serviceTemplate: string; policyMap: string }
export interface Exception { id: string; kind: 'work-order' | 'internal-ticket'; title: string; detail: string; open: boolean }
export interface World {
  ont: { serial: string; online: boolean; rxDbm: number; service: OntService | null };
  accountStatus: 'pending' | 'active';
  controllerRequests: number;  // requests sent to SMx, including ones that failed or timed out
  controllerWrites: number;    // writes that actually changed the ONT
  activateRequests: number;
  activations: number;
  notifications: number;       // Activate Account also notifies the customer, so this must stay at 1
  exceptions: Exception[];
  inFlight: string | null;     // order key of an execution that is still running
}

export type Fault =
  | 'none' | 'ack-lost-after-write' | 'ack-lost-before-write' | 'controller-busy'
  | 'stale-ont-config' | 'low-light' | 'activation-api-error' | 'duplicate-in-flight';
export type StepId = 'preflight' | 'account' | 'provision' | 'verify' | 'activate';
export type EventStatus = 'passed' | 'failed' | 'retrying' | 'adopted' | 'skipped' | 'held' | 'opened' | 'resolved' | 'scenario';
export interface Event { seq: number; run: number; step: StepId; status: EventStatus; message: string }
export type RunStatus = 'ready' | 'blocked' | 'conflict' | 'provision-failed' | 'awaiting-field' | 'activation-failed' | 'active';

export interface Rehearsal { order: Order; intent?: string; status: RunStatus; runs: number; events: Event[]; world: World }

// GPON class B+ ONT receiver window (ITU-T G.984.2). A real deployment would use the operator's own thresholds.
export const RX_MIN_DBM = -27;
export const RX_MAX_DBM = -8;
export const GPON_DOWNSTREAM_MBPS = 2488;
export const OVERSUBSCRIPTION_POLICY = 4;        // example policy; confirm with the customer's network team
export const RETRY = { attempts: 3, backoffSeconds: [2, 4] };
const HEALTHY_RX = -19.6;

export const steps: { id: StepId; title: string; node: string; description: string }[] = [
  { id: 'preflight', title: 'Preflight', node: 'Execute TypeScript Code', description: 'Resolve the Calix product and ONT mappings, check the ONT assignment, the site address pools and PON headroom.' },
  { id: 'account', title: 'Read account', node: 'Accounts: Get Account', description: 'Exit early if the account is already active. A replayed delivery must not cause any writes.' },
  { id: 'provision', title: 'Provision ONT', node: 'Calix SMx template node', description: 'Read the ONT first. Adopt a matching service, refuse a foreign one, otherwise write with bounded retries.' },
  { id: 'verify', title: 'Verify light and service', node: 'HTTP REST Request · SMx device read', description: 'ONT online, optical receive level inside the B+ window, service template in place.' },
  { id: 'activate', title: 'Activate account', node: 'Account Management: Activate Account', description: 'Starts pending billing subscriptions and notifies the customer. Re-read status before every attempt.' },
];

export function initialConfig(): CalixConfig {
  return {
    // Fiber 1000 was configured before the Product Mapping change, so its Tagged Policy Map is still empty.
    products: [
      { product: 'Fiber 1000', serviceTemplate: 'RES-1000', untaggedPolicyMap: 'BRIDGE-1000', taggedPolicyMap: '' },
      { product: 'Fiber 500', serviceTemplate: 'RES-500', untaggedPolicyMap: 'BRIDGE-500', taggedPolicyMap: 'AIO-500-TAG' },
    ],
    onts: [{ model: '844G-1', ontProfile: '844G', variant: 'tagged', mainPort: 'g1' }],
  };
}

export function initialOrder(key = 'FL-1046'): Order {
  return {
    key, accountId: 'JV-1046', product: 'Fiber 1000', planMbps: 1000,
    ont: { serial: 'CXNK0049A1F2', model: '844G-1', assignedAccount: 'JV-1046' },
    site: 'Valley-POP-01', pon: 'OLT-01 · PON 1/2', ponSoldMbps: 6500,
    servicePools: ['192.0.2.0/25', '2001:db8:10::/48'],
  };
}

export function initialWorld(order: Order = initialOrder()): World {
  return {
    ont: { serial: order.ont.serial, online: true, rxDbm: HEALTHY_RX, service: null },
    accountStatus: 'pending', controllerRequests: 0, controllerWrites: 0,
    activateRequests: 0, activations: 0, notifications: 0, exceptions: [], inFlight: null,
  };
}

export function newRehearsal(order: Order = initialOrder(), world: World = initialWorld(order)): Rehearsal {
  return { order, status: 'ready', runs: 0, events: [], world };
}

export function preflight(order: Order, config: CalixConfig, site: SiteContext): { checks: Check[]; resolution?: Resolution } {
  const checks: Check[] = [];
  const product = config.products.find(p => p.product === order.product);
  const ont = config.onts.find(o => o.model === order.ont.model);

  if (!product) {
    checks.push({ id: 'product', label: 'Calix product mapping', severity: 'block', owner: 'Network engineering', detail: `${order.product} has no Calix Product Mapping, so gaiia cannot provision it.` });
  } else {
    const missing = ([['serviceTemplate', 'Service Template'], ['untaggedPolicyMap', 'Untagged Policy Map'], ['taggedPolicyMap', 'Tagged Policy Map']] as const)
      .filter(([field]) => !product[field].trim()).map(([, label]) => label);
    checks.push(missing.length
      ? { id: 'product', label: 'Calix product mapping', severity: 'block', owner: 'Network engineering',
          detail: `${order.product} is missing ${missing.join(', ')}. All three fields are required before gaiia will provision this product.` }
      : { id: 'product', label: 'Calix product mapping', severity: 'pass', owner: 'Network engineering',
          detail: `${product.serviceTemplate} · untagged ${product.untaggedPolicyMap} · tagged ${product.taggedPolicyMap}` });
  }

  if (!ont || !ont.ontProfile.trim() || !ont.mainPort.trim()) {
    checks.push({ id: 'ont', label: 'Calix ONT mapping', severity: 'block', owner: 'Network engineering', detail: `ONT model ${order.ont.model} needs an ONT profile and main port.` });
  } else {
    checks.push({ id: 'ont', label: 'Calix ONT mapping', severity: 'pass', owner: 'Network engineering',
      detail: `${ont.model} → profile ${ont.ontProfile}, ${ont.variant === 'tagged' ? 'tagged (all-in-one)' : 'untagged (bridge)'}, port ${ont.mainPort}` });
  }

  if (order.ont.assignedAccount !== order.accountId) {
    checks.push({ id: 'assignment', label: 'ONT assigned to account', severity: 'block', owner: 'Operations',
      detail: order.ont.assignedAccount
        ? `${order.ont.serial} is assigned to ${order.ont.assignedAccount}, not ${order.accountId}.`
        : `${order.ont.serial} is not assigned to ${order.accountId} in gaiia inventory.` });
  } else {
    checks.push({ id: 'assignment', label: 'ONT assigned to account', severity: 'pass', owner: 'Operations', detail: `${order.ont.serial} → ${order.accountId}` });
  }

  const absent = order.servicePools.filter(p => !site.blocks.includes(p));
  checks.push(absent.length
    ? { id: 'pools', label: 'Address pools on site', severity: 'block', owner: 'Network engineering',
        detail: `${absent.join(', ')} ${absent.length === 1 ? 'is not an IP Block' : 'are not IP Blocks'} on ${site.name}. Reconcile the NetBox sync first.` }
    : { id: 'pools', label: 'Address pools on site', severity: 'pass', owner: 'Network engineering', detail: `${order.servicePools.join(' + ')} present on ${site.name}` });

  const ratio = (order.ponSoldMbps + order.planMbps) / GPON_DOWNSTREAM_MBPS;
  const valid = Number.isFinite(ratio) && order.planMbps > 0 && order.ponSoldMbps >= 0;
  checks.push({
    id: 'headroom', label: 'PON oversubscription', owner: 'Network engineering',
    severity: !valid ? 'block' : ratio > OVERSUBSCRIPTION_POLICY ? 'warn' : 'pass',
    detail: !valid ? 'Plan and sold capacity must be valid, non-negative numbers.'
      : `${((order.ponSoldMbps + order.planMbps) / 1000).toFixed(1)} Gbps sold on ${(GPON_DOWNSTREAM_MBPS / 1000).toFixed(2)} Gbps downstream (${ratio.toFixed(1)}:1, policy ${OVERSUBSCRIPTION_POLICY}:1). A planning signal; it does not block activation.`,
  });

  const blocked = checks.some(c => c.severity === 'block');
  const resolution = blocked || !product || !ont ? undefined : {
    serviceTemplate: product.serviceTemplate,
    policyMap: ont.variant === 'tagged' ? product.taggedPolicyMap : product.untaggedPolicyMap,
    variant: ont.variant, ontProfile: ont.ontProfile, mainPort: ont.mainPort,
  };
  return { checks, resolution };
}

function fingerprint(o: Order): string {
  return JSON.stringify([o.accountId, o.product, o.planMbps, o.ont.serial, o.site]);
}

function cloneWorld(w: World): World {
  return { ...w, ont: { ...w.ont, service: w.ont.service && { ...w.ont.service } }, exceptions: w.exceptions.map(e => ({ ...e })) };
}

/** Run the workflow once against the simulated world. `fault` shapes this attempt only. */
export function execute(previous: Rehearsal, config: CalixConfig, site: SiteContext, fault: Fault): Rehearsal {
  const r: Rehearsal = { ...previous, runs: previous.runs + 1, events: [...previous.events], world: cloneWorld(previous.world) };
  const { order, world } = r;
  const log = (step: StepId, status: EventStatus, message: string) => r.events.push({ seq: r.events.length + 1, run: r.runs, step, status, message });
  // Opens a ticket or work order unless the same one is still open, so re-runs never stack duplicates.
  const raise = (kind: Exception['kind'], title: string, detail: string, team: string) => {
    const noun = kind === 'work-order' ? 'work order' : 'ticket';
    const existing = world.exceptions.find(e => e.open && e.kind === kind && e.title === title);
    if (existing) return `${existing.id} is already open. No duplicate ${noun}.`;
    const id = `${kind === 'work-order' ? 'WO' : 'TCK'}-${4100 + world.exceptions.length + 1}`;
    world.exceptions.push({ id, kind, title, detail, open: true });
    return `${id} created for ${team}.`;
  };

  // Scenario setup changes the world before the run, the way the real network would already be.
  // A live service is left alone: a replay against it exits before any of this could matter.
  const live = world.accountStatus === 'active';
  if (!live && fault === 'stale-ont-config' && !world.ont.service) {
    world.ont.service = { account: 'JV-0977', serviceTemplate: 'RES-500', policyMap: 'BRIDGE-500' };
    log('provision', 'scenario', `${world.ont.serial} came back from cancelled account JV-0977 and was never deprovisioned.`);
  }
  if (!live && fault === 'low-light' && world.ont.rxDbm >= RX_MIN_DBM) {
    world.ont.rxDbm = -29.4;
    log('verify', 'scenario', 'A dirty connector at the drop is attenuating the signal.');
  }
  if (fault === 'duplicate-in-flight') {
    log('preflight', 'skipped', `Another execution for ${order.key} is still running. This delivery exits without side effects.`);
    return r;
  }

  world.inFlight = order.key;
  const finish = (status: RunStatus) => { r.status = status; world.inFlight = null; return r; };

  if (r.intent && r.intent !== fingerprint(order)) {
    log('preflight', 'failed', `INTENT_CONFLICT: ${order.key} already belongs to a different service intent. Start a new revision.`);
    return finish('blocked');
  }
  const { checks, resolution } = preflight(order, config, site);
  const blockers = checks.filter(c => c.severity === 'block');
  if (!resolution) {
    log('preflight', 'failed', blockers.map(c => c.detail).join(' '));
    return finish('blocked');
  }
  r.intent = fingerprint(order);
  const warnings = checks.filter(c => c.severity === 'warn');
  log('preflight', 'passed', `Resolved ${resolution.serviceTemplate} with ${resolution.policyMap} (${resolution.variant}) on profile ${resolution.ontProfile}, port ${resolution.mainPort}.${warnings.length ? ` Warning: ${warnings.map(w => w.label).join(', ')}.` : ''}`);

  // Accounts: Get Account. A function, not a field read: the status can change between attempts.
  const readAccountStatus = () => world.accountStatus;
  if (readAccountStatus() === 'active') {
    log('account', 'skipped', `${order.accountId} is already active. No device write and no second activation notice.`);
    return finish('active');
  }
  log('account', 'passed', `${order.accountId} is pending activation.`);

  // Provision: read before writing, and read again after any request whose outcome is unknown.
  const desired: OntService = { account: order.accountId, serviceTemplate: resolution.serviceTemplate, policyMap: resolution.policyMap };
  const matches = (s: OntService | null) => !!s && s.account === desired.account && s.serviceTemplate === desired.serviceTemplate && s.policyMap === desired.policyMap;
  const current = world.ont.service;
  if (matches(current)) {
    log('provision', 'adopted', `Read-back: ${world.ont.serial} already carries ${desired.serviceTemplate}/${desired.policyMap} for ${order.accountId}. Adopted with no write.`);
  } else if (current) {
    const foreign = current.account !== order.accountId;
    const detail = foreign
      ? `${world.ont.serial} carries ${current.serviceTemplate} for ${current.account}. Confirm that account is cancelled, then remove its service before re-running.`
      : `${world.ont.serial} carries ${current.serviceTemplate}/${current.policyMap} but this order resolves to ${desired.serviceTemplate}/${desired.policyMap}. A plan change belongs in Modify Account Service, not activation.`;
    const note = raise('internal-ticket', foreign ? 'ONT holds another account’s service' : 'ONT service differs from order', detail, 'network operations');
    log('provision', 'failed', `Not overwriting the existing configuration. ${detail}`);
    log('provision', 'opened', note);
    return finish('conflict');
  } else {
    let applied = false;
    for (let attempt = 1; attempt <= RETRY.attempts && !applied; attempt++) {
      world.controllerRequests++;
      const label = `Attempt ${attempt}/${RETRY.attempts}`;
      const backoff = RETRY.backoffSeconds[attempt - 1];
      if (fault === 'controller-busy' && attempt <= 2) {
        log('provision', 'retrying', `${label}: SMx answered 503 (busy). Nothing was written. Backing off ${backoff} s.`);
        continue;
      }
      if ((fault === 'ack-lost-after-write' || fault === 'ack-lost-before-write') && attempt === 1) {
        if (fault === 'ack-lost-after-write') { world.ont.service = { ...desired }; world.controllerWrites++; }
        log('provision', 'retrying', `${label}: no response within the node timeout. Outcome unknown, so read the ONT before any retry.`);
        if (matches(world.ont.service)) {
          log('provision', 'adopted', 'Read-back found the service. The first write landed, so it is adopted without a second write.');
          applied = true;
        } else {
          log('provision', 'retrying', `Read-back found no service on the ONT. The request never landed. Retrying after ${backoff} s.`);
        }
        continue;
      }
      world.ont.service = { ...desired }; world.controllerWrites++;
      log('provision', 'passed', `${label}: applied ${desired.serviceTemplate} with ${desired.policyMap} to ${world.ont.serial} port ${resolution.mainPort}.`);
      applied = true;
    }
    if (!applied) {
      const note = raise('internal-ticket', 'ONT provisioning failed', `SMx did not accept the request after ${RETRY.attempts} attempts.`, 'network operations');
      log('provision', 'failed', `Gave up after ${RETRY.attempts} attempts. Account stays pending.`);
      log('provision', 'opened', note);
      return finish('provision-failed');
    }
  }

  // Verify. On failure keep the configuration: the technician needs it in place to diagnose the drop.
  const rx = world.ont.rxDbm;
  if (!world.ont.online || rx < RX_MIN_DBM || rx > RX_MAX_DBM) {
    log('verify', 'failed', `${world.ont.online ? 'ONT online' : 'ONT offline'}, Rx ${rx.toFixed(1)} dBm, outside the ${RX_MIN_DBM} to ${RX_MAX_DBM} dBm window.`);
    log('verify', 'held', 'Configuration stays in place. Account stays pending, so billing has not started and no notice was sent.');
    log('verify', 'opened', raise('work-order', 'Low optical level at ONT', `${world.ont.serial} receives ${rx.toFixed(1)} dBm (minimum ${RX_MIN_DBM} dBm). Inspect and clean the drop connectors and splitter port, then record the new Rx.`, 'field operations'));
    return finish('awaiting-field');
  }
  log('verify', 'passed', `ONT online, Rx ${rx.toFixed(1)} dBm, ${desired.serviceTemplate} active on the ONT.`);

  // Activate. The node also notifies the customer, so re-read status before each attempt.
  const activated = () => {
    const resolved = world.exceptions.filter(e => e.open && e.title === 'Account activation failed');
    resolved.forEach(e => { e.open = false; });
    if (resolved.length) log('activate', 'resolved', `${resolved.map(e => e.id).join(', ')} closed: activation succeeded on retry.`);
    return finish('active');
  };
  for (let attempt = 1; attempt <= RETRY.attempts; attempt++) {
    if (readAccountStatus() === 'active') {
      log('activate', 'adopted', 'Account already active. The earlier attempt landed, so the node is not called again.');
      return activated();
    }
    world.activateRequests++;
    if (fault === 'activation-api-error') {
      log('activate', 'retrying', `Attempt ${attempt}/${RETRY.attempts}: Activate Account returned an error. Nothing changed.${attempt < RETRY.attempts ? ` Backing off ${RETRY.backoffSeconds[attempt - 1]} s.` : ''}`);
      continue;
    }
    world.accountStatus = 'active'; world.activations++; world.notifications++;
    log('activate', 'passed', `${order.accountId} active. Pending billing subscriptions started, and one activation notice sent.`);
    return activated();
  }
  const note = raise('internal-ticket', 'Account activation failed', `Activate Account failed ${RETRY.attempts} times. The ONT is provisioned and verified, and ${order.accountId} is still pending, so it has not been billed or notified. Re-run once the API recovers.`, 'implementation');
  log('activate', 'failed', `Gave up after ${RETRY.attempts} attempts. Service verified; account pending.`);
  log('activate', 'opened', note);
  return finish('activation-failed');
}

/** Field operations fixed the drop. Closes the open work order; the next run verifies and activates. */
export function recordFieldRepair(previous: Rehearsal, rxDbm = HEALTHY_RX): Rehearsal {
  if (previous.status !== 'awaiting-field') return previous;
  const world = cloneWorld(previous.world);
  world.ont.rxDbm = rxDbm;
  const closed = world.exceptions.filter(e => e.kind === 'work-order' && e.open);
  closed.forEach(e => { e.open = false; });
  return { ...previous, status: 'ready', world, events: [...previous.events,
    { seq: previous.events.length + 1, run: previous.runs, step: 'verify', status: 'resolved', message: `${closed.map(e => e.id).join(', ')} closed: connector cleaned, Rx now ${rxDbm.toFixed(1)} dBm. Re-run to verify and activate.` }] };
}

/** Operations confirmed the previous owner is cancelled and removed its service from the ONT. */
export function releaseForeignService(previous: Rehearsal): Rehearsal {
  const service = previous.world.ont.service;
  if (previous.status !== 'conflict' || !service || service.account === previous.order.accountId) return previous;
  const world = cloneWorld(previous.world);
  world.ont.service = null; world.controllerRequests++; world.controllerWrites++;
  const closed = world.exceptions.filter(e => e.kind === 'internal-ticket' && e.open);
  closed.forEach(e => { e.open = false; });
  return { ...previous, status: 'ready', world, events: [...previous.events,
    { seq: previous.events.length + 1, run: previous.runs, step: 'provision', status: 'resolved', message: `${service.account} confirmed cancelled. Its ${service.serviceTemplate} service was removed from ${world.ont.serial}, and ${closed.map(e => e.id).join(', ')} was closed.` }] };
}

export const faults: { value: Fault; label: string; group: string; description: string }[] = [
  { value: 'none', group: 'Baseline', label: 'No failure', description: 'Every node succeeds on the first attempt.' },
  { value: 'ack-lost-after-write', group: 'Calix SMx', label: 'Response lost after write', description: 'SMx applies the service but the response never arrives. The workflow must read the ONT, find its own write and adopt it.' },
  { value: 'ack-lost-before-write', group: 'Calix SMx', label: 'Request lost before write', description: 'The request times out before it reaches SMx. Read-back finds nothing, so exactly one retry writes it.' },
  { value: 'controller-busy', group: 'Calix SMx', label: 'Controller busy (503)', description: 'SMx refuses twice, then accepts. Shows bounded retry with backoff and no duplicate writes.' },
  { value: 'stale-ont-config', group: 'Calix SMx', label: 'ONT still has old service', description: 'A returned ONT still carries a cancelled account’s service. Refuse to overwrite it; open a ticket for operations.' },
  { value: 'low-light', group: 'Field', label: 'Low optical level', description: 'Rx is below the B+ sensitivity floor. Keep the configuration, hold activation and dispatch a technician.' },
  { value: 'activation-api-error', group: 'gaiia', label: 'Activate Account fails', description: 'The node errors on every attempt. The service stays verified and the account stays pending, unbilled and not notified.' },
  { value: 'duplicate-in-flight', group: 'Delivery', label: 'Duplicate while running', description: 'A second trigger arrives while the first execution holds the order. It exits without touching anything.' },
];
