import { useState } from 'react';
import { Button } from './components/button';
import { audit, fullSync, impact, initialMigration, removeStaleBlock, renameGaiiaSite, restoreInNetbox, topology } from './network';
import type { Attestations, BlockState, Gate, Migration, PrefixState } from './network';

const prefixLabel: Record<PrefixState, [string, string]> = {
  synced: ['In gaiia', 'good'], missing: ['Missing in gaiia', 'bad'], 'site-mismatch': ['Skipped: no site with this name', 'bad'],
  'not-site-scoped': ['Not synced: region-scoped', 'muted'], 'role-filtered': ['Not synced: role filter', 'muted'],
};
const blockLabel: Record<BlockState, [string, string]> = {
  'in-sync': ['In NetBox', 'good'], stale: ['Deleted in NetBox · 0 active', 'bad'], 'stale-in-use': ['Deleted in NetBox · still in use', 'bad'], manual: ['Manual · outside sync', 'muted'],
};

export function NetworkPanel({ migration: m, onChange, attest, onAttest, gates }: {
  migration: Migration; onChange: (m: Migration) => void; attest: Attestations; onAttest: (a: Attestations) => void; gates: Gate[];
}) {
  const [root, setRoot] = useState('olt');
  const a = audit(m);
  const exposed = impact(root);
  // Any data change invalidates the human sign-offs.
  const change = (next: Migration) => { onChange(next); onAttest({ notice: false, rollback: false }); };
  const ready = gates.every(g => g.passed);

  return <section id="panel-migration" role="tabpanel" aria-label="Migration rehearsal">
    <div className="section-heading"><h2>NetBox → gaiia · Valley-POP-01</h2><Button variant="secondary" size="sm" onClick={() => change(initialMigration())}>Reset migration</Button></div>
    <p className="network-intro">During a naming cleanup the NetBox site <code>valley-pop-01</code> became <code>Valley-POP-01</code>. gaiia matches sites by exact, case-sensitive name, so since then every prefix webhook for this POP has been skipped silently, including one deletion. The new IPv6 pool never arrived, and the next activation on this POP needs it.</p>

    <div className="network-grid"><div className="network-box">
      <div className="network-label">01 / RECONCILE PREFIXES</div><h3>Site association</h3>
      <div className="site-pair"><div><span>NetBox site</span><code>{m.netboxSite}</code></div><span className={a.nameMatches ? 'good' : 'bad'}>{a.nameMatches ? '=' : '≠'}</span><div><span>gaiia Network Site · {m.gaiiaSite.referenceId}</span><code>{m.gaiiaSite.name}</code></div></div>
      <p>NetBox is the source of truth, so rename the gaiia site to match. Blocks, inventory and tickets are attached to the site record and stay with it. Renaming in NetBox instead would break anything else that reads NetBox names.</p>
      <div className="network-actions"><Button size="sm" variant="secondary" disabled={a.nameMatches} onClick={() => change(renameGaiiaSite(m, m.netboxSite))}>Rename gaiia site to {m.netboxSite}</Button><Button size="sm" onClick={() => change(fullSync(m))}>Run full sync</Button></div>

      <div className="network-table"><div className="network-table-head">NETBOX PREFIXES · ROLE FILTER: {m.roleFilter.join(', ')}</div>
        {a.prefixes.map(({ prefix: p, state }) => <div key={p.id}><code>{p.cidr}</code><span>{p.description}<small>{p.scope.type}: {p.scope.name} · role {p.role ?? 'none'}</small></span><b className={prefixLabel[state][1]}>{prefixLabel[state][0]}</b></div>)}</div>

      <div className="network-table"><div className="network-table-head">GAIIA IP BLOCKS · ACTIVE ADDRESSES FROM BNG LEASE EXPORT</div>
        {a.blocks.map(({ block: b, state }) => <div key={b.id}><code>{b.cidr}</code><span>{b.description}<small>{b.origin === 'netbox' ? 'Created by integration' : 'Created by hand'} · {m.activeAddresses[b.cidr] ?? 0} active</small></span>
          <b className={blockLabel[state][1]}>{blockLabel[state][0]}</b>
          {state === 'stale' && <Button size="sm" variant="secondary" onClick={() => change(removeStaleBlock(m, b.cidr).migration)}>Remove</Button>}
          {state === 'stale-in-use' && <><Button size="sm" variant="ghost" onClick={() => change(removeStaleBlock(m, b.cidr).migration)}>Try remove</Button><Button size="sm" variant="secondary" onClick={() => change(restoreInNetbox(m, b.cidr))}>Restore in NetBox</Button></>}
          {state === 'manual' && <Button size="sm" variant="ghost" onClick={() => change(removeStaleBlock(m, b.cidr).migration)}>Try remove</Button>}</div>)}</div>

      <div className="network-finding"><b>{a.mismatched} skipped by name · {a.missing} missing · {a.stale} stale · {a.staleInUse} stale but in use</b>
        <p>Full sync only adds. Deletes missed while the webhook couldn’t match have to be removed by hand, and only after checking that nothing is still using the prefix.</p></div>
    </div>

    <div className="network-box"><div className="network-label">02 / CHANGE IMPACT</div><h3>Who the cutover touches</h3>
      <p>Walks the gaiia inventory downstream from the changed device. Like “Add Accounts from Network Sites” on an incident, only active services count. Each account is counted once.</p>
      <label className="network-field">Change target<select value={root} onChange={e => { setRoot(e.target.value); onAttest({ notice: false, rollback: attest.rollback }); }}>{topology.filter(d => !d.account).map(d => <option value={d.id} key={d.id}>{d.label}</option>)}</select></label>
      <div className="network-metrics"><div><b>{exposed.accounts.length}</b><span>Accounts to notify</span></div><div><b>{exposed.active.length}</b><span>Active services</span></div><div><b>{exposed.excluded.length + exposed.pending.length}</b><span>Not counted</span></div></div>
      <div className="dependency-tree">{topology.map(d => <div key={d.id} className={exposed.devices.some(e => e.id === d.id) ? 'affected' : ''}><code>{d.id}</code><span>{d.label}{d.account && <small> · {d.account} {d.status}</small>}</span><small>{d.upstream.length ? `← ${d.upstream.join(', ')}` : 'Root'}</small></div>)}</div>
      <div className="network-table"><div className="network-table-head">NOTIFY</div>{exposed.accounts.map(acc => <div key={acc}><code>{acc}</code><span>{exposed.active.filter(s => s.account === acc).map(s => s.service).join(' + ')}</span></div>)}</div>
      {(exposed.excluded.length > 0 || exposed.pending.length > 0) && <p className="network-note">{exposed.excluded.map(s => `${s.account} is suspended and not notified.`).join(' ')} {exposed.pending.map(s => `${s.account} has a pending activation: schedule it outside the window.`).join(' ')}</p>}
      <p className="network-note">JV-1042 has fiber and backup wireless behind the same aggregation, so one change takes out both paths. This is dependency exposure, not a routing or failover model.</p>
    </div></div>

    <div className="network-box cutover"><div className="section-heading"><div><div className="network-label">03 / CUTOVER GATES</div><h3>{ready ? 'Ready for the customer’s change approval' : 'Hold'}</h3></div></div>
      <p>Three gates are computed from the data and can’t be ticked by hand. Two are sign-offs, and any data change clears them.</p>
      {gates.map((g, i) => g.kind === 'computed'
        ? <div className="cutover-gate" key={g.name}><span className={g.passed ? 'good' : 'bad'}>{g.passed ? 'PASS' : 'HOLD'}</span><b>{g.name}</b><small>{g.owner} · {g.detail}</small></div>
        : <label className="cutover-gate" key={g.name}><input type="checkbox" checked={g.passed} onChange={e => onAttest({ ...attest, [i === 3 ? 'notice' : 'rollback']: e.target.checked })}/><b>{g.name}</b><small>{g.owner} · {g.detail}</small></label>)}
    </div>

    <div className="network-box"><div className="section-heading"><h3>Operation log</h3><span>{m.log.length} operations</span></div>
      {m.log.length ? m.log.map((line, i) => <div className="network-log" key={i}><code>{String(i + 1).padStart(2, '0')}</code>{line}</div>) : <p>No operations yet. Start with a full sync to see the silent skip.</p>}</div>
    <div className="network-sources">Behaviour follows <a href="https://support.gaiia.com/hc/en-us/articles/49085616236443-NetBox-Integration" target="_blank" rel="noreferrer">NetBox Integration ↗</a><a href="https://support.gaiia.com/hc/en-us/articles/49758568394267-Network-Sites" target="_blank" rel="noreferrer">Network Sites ↗</a><span>Documentation address ranges only.</span></div>
  </section>;
}
