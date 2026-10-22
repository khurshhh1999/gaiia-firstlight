import { useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { Button } from './components/button';
import { comparison } from './lab';
import type { RunRecord } from './lab';
import { RX_MAX_DBM, RX_MIN_DBM } from './engine';
import type { CalixConfig, Order, PolicyVariant, ProductMapping, Rehearsal } from './engine';

/** Settings → Integrations → Calix: the product row for this order and the ONT row for its model. */
export function MappingEditor({ config, order, onChange, disabled }: { config: CalixConfig; order: Order; onChange: (c: CalixConfig) => void; disabled: boolean }) {
  const product = config.products.find(p => p.product === order.product);
  const ont = config.onts.find(o => o.model === order.ont.model);
  const setProduct = (key: keyof ProductMapping, value: string) =>
    onChange({ ...config, products: config.products.map(p => p.product === order.product ? { ...p, [key]: value } : p) });
  const setOnt = (patch: Partial<NonNullable<typeof ont>>) =>
    onChange({ ...config, onts: config.onts.map(o => o.model === order.ont.model ? { ...o, ...patch } : o) });
  const missingTagged = product && !product.taggedPolicyMap.trim();
  return <div className="mapping-card">
    <div className="section-heading"><h2>Calix mapping</h2><span>Settings → Integrations → Calix</span></div>
    {product && <div className="mapping-grid">
      <span className="mapping-caption">Product mapping · {product.product}</span>
      <label>Service Template<input value={product.serviceTemplate} disabled={disabled} onChange={e => setProduct('serviceTemplate', e.target.value)}/></label>
      <label>Untagged Policy Map<input value={product.untaggedPolicyMap} disabled={disabled} onChange={e => setProduct('untaggedPolicyMap', e.target.value)}/></label>
      <label className={missingTagged ? 'needs-value' : ''}>Tagged Policy Map<input value={product.taggedPolicyMap} placeholder="Required" disabled={disabled} onChange={e => setProduct('taggedPolicyMap', e.target.value)}/></label>
    </div>}
    {missingTagged && <div className="inline-issue"><div><b>Fiber 1000 predates the Product Mapping change.</b><p>Its old ONT Policy carried over as the Untagged map, but the Tagged map is new and required. This order’s 844G-1 is an all-in-one unit, so it would use the tagged map.</p></div><Button variant="secondary" size="sm" disabled={disabled} onClick={() => setProduct('taggedPolicyMap', 'AIO-1000-TAG')}>Use SMx value AIO-1000-TAG</Button></div>}
    {ont && <div className="mapping-grid">
      <span className="mapping-caption">ONT mapping · {ont.model}</span>
      <label>ONT Profile<input value={ont.ontProfile} disabled={disabled} onChange={e => setOnt({ ontProfile: e.target.value })}/></label>
      <label>Policy map variant<select value={ont.variant} disabled={disabled} onChange={e => setOnt({ variant: e.target.value as PolicyVariant })}><option value="tagged">Tagged (all-in-one)</option><option value="untagged">Untagged (bridge)</option></select></label>
      <label>ONT Main Port<input value={ont.mainPort} disabled={disabled} onChange={e => setOnt({ mainPort: e.target.value })}/></label>
    </div>}
  </div>;
}

export function OrderEditor({ order, onChange, locked, onRevision }: { order: Order; onChange: (o: Order) => void; locked: boolean; onRevision: () => void }) {
  const num = (key: 'planMbps' | 'ponSoldMbps', value: string) => onChange({ ...order, [key]: Number(value) });
  return <details className="service-editor"><summary><span>Order details</span><span>Plan, PON load and ONT assignment</span></summary><div className="editor-content">
    <div className="editor-fields three">
      <label>Plan downstream (Mbps)<input type="number" min="1" value={order.planMbps || ''} disabled={locked} onChange={e => num('planMbps', e.target.value)}/></label>
      <label>Already sold on PON (Mbps)<input type="number" min="0" value={Number.isFinite(order.ponSoldMbps) ? order.ponSoldMbps : ''} disabled={locked} onChange={e => num('ponSoldMbps', e.target.value)}/></label>
      <label>ONT serial<input value={order.ont.serial} disabled/></label>
    </div>
    <div className="editor-footer"><label><input type="checkbox" checked={order.ont.assignedAccount === order.accountId} disabled={locked} onChange={e => onChange({ ...order, ont: { ...order.ont, assignedAccount: e.target.checked ? order.accountId : null } })}/> ONT assigned to {order.accountId} in gaiia inventory</label>
      {locked ? <Button size="sm" variant="secondary" icon={<RotateCcw size={12}/>} onClick={onRevision}>New revision</Button> : <span>Locked once a run passes preflight: the order key is bound to this intent.</span>}</div>
    <p>Oversubscription is shown as a planning signal against an example 4:1 policy. It does not model contention or real traffic.</p>
  </div></details>;
}

/** The simulated ground truth: what the ONT and the account actually look like, independent of the workflow’s log. */
export function WorldPanel({ rehearsal, running }: { rehearsal: Rehearsal; running: boolean }) {
  const { ont, accountStatus, exceptions } = rehearsal.world;
  const span = RX_MAX_DBM - (RX_MIN_DBM - 6);
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - (RX_MIN_DBM - 6)) / span) * 100))}%`;
  const rxOk = ont.rxDbm >= RX_MIN_DBM && ont.rxDbm <= RX_MAX_DBM;
  return <section className="world-panel"><div className="section-heading"><h2>Simulated network and account</h2><span>Ground truth the workflow has to read. It is not the workflow’s own log.</span></div>
    <div className="world-grid">
      <div className="world-card"><span className="world-label">ONT {ont.serial}</span>
        <b>{ont.service ? `${ont.service.serviceTemplate} · ${ont.service.policyMap}` : 'No service configured'}</b>
        <small>{ont.service ? `Owned by ${ont.service.account}` : 'Factory state'} · {ont.online ? 'online' : 'offline'}</small>
        <div className="rx-meter" aria-label={`Receive level ${ont.rxDbm} dBm`}><span className="rx-window" style={{ left: pos(RX_MIN_DBM), right: `calc(100% - ${pos(RX_MAX_DBM)})` }}/><span className={`rx-mark ${rxOk ? '' : 'bad'}`} style={{ left: running ? pos(RX_MIN_DBM) : pos(ont.rxDbm) }}/></div>
        <small className={rxOk ? '' : 'bad'}>Rx {ont.rxDbm.toFixed(1)} dBm · window {RX_MIN_DBM} to {RX_MAX_DBM} dBm</small></div>
      <div className="world-card"><span className="world-label">gaiia account {rehearsal.order.accountId}</span>
        <b>{accountStatus === 'active' ? 'Active' : 'Pending activation'}</b>
        <small>{accountStatus === 'active' ? 'Billing subscriptions started; customer notified once.' : 'No billing and no customer notice yet.'}</small></div>
      <div className="world-card"><span className="world-label">Exceptions</span>
        {exceptions.length ? exceptions.map(e => <div className="exception" key={e.id}><span className={`status-tag ${e.open ? 'warn' : 'pass'}`}>{e.open ? 'Open' : 'Closed'}</span><div><b>{e.id} · {e.title}</b><small>{e.kind === 'work-order' ? 'Workforce: Create Work Order' : 'Tickets: Create Internal Ticket'}</small></div></div>)
          : <small>No tickets or work orders.</small>}</div>
    </div></section>;
}

export function RunHistory({ records }: { records: RunRecord[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const record = records.find(r => r.id === selected) || records.at(-1);
  if (!record) return null;
  return <section className="run-history"><div className="section-heading"><h2>Attempt comparison</h2><span>Last {records.length} attempts and operator actions</span></div>
    <div className="history-layout"><div className="history-list">{[...records].reverse().map(r => <button key={r.id} className={r.id === record.id ? 'selected' : ''} onClick={() => setSelected(r.id)}><span className="mono">#{r.id}</span><span><b>{r.label}</b><small>{r.after.order.key} · {r.after.status}</small></span><ArrowRight size={12}/></button>)}</div>
      <div className="state-diff"><div className="diff-row diff-head"><span>State</span><span>Before</span><span>After</span></div>
        {comparison(record).map(r => <div className={`diff-row ${r.before !== r.after ? 'changed' : ''}`} key={r.name}><span>{r.name}</span><span>{r.before}</span><b>{r.after}</b></div>)}</div></div></section>;
}
