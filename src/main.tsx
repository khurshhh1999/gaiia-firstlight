import { Fragment, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, Circle, Clock3, Code2, CreditCard, Download, FileText, GitBranch, Network, PanelLeftClose, Play, RotateCcw, Router, Server, ShieldCheck, Terminal, X, AlertTriangle, Activity, CircleHelp, CheckCheck, Wrench, Ticket, ListChecks } from 'lucide-react';
import { SegmentedControl } from './components/segmented-control';
import { Button } from './components/button';
import { execute, faults, initialConfig, initialOrder, newRehearsal, preflight, recordFieldRepair, releaseForeignService, steps } from './engine';
import type { CalixConfig, Check as PreflightCheck, EventStatus, Fault, Order, Rehearsal, RunStatus, StepId } from './engine';
import { cutoverGates, initialMigration, siteContext } from './network';
import type { Attestations, Migration } from './network';
import { MappingEditor, OrderEditor, RunHistory, WorldPanel } from './lab-panels';
import type { RunRecord } from './lab';
import { NetworkPanel } from './network-panel';
import { implementationBrief } from './brief';
import engineSource from './engine.ts?raw';
import networkSource from './network.ts?raw';
import './style.css';
import './app.css';

type Tab = 'migration' | 'preflight' | 'activation' | 'handoff';
type NodeId = 'ont' | 'olt' | 'site' | 'account';

const statusText: Record<RunStatus, string> = {
  ready: 'Ready to run', blocked: 'Blocked in preflight', conflict: 'ONT conflict', 'provision-failed': 'Provisioning failed',
  'awaiting-field': 'Awaiting field repair', 'activation-failed': 'Activation failed', active: 'Active',
};
const nodes: Record<NodeId, { title: string; owner: string; body: string; checks: string[] }> = {
  ont: { title: 'Customer ONT', owner: 'Operations', checks: ['ont', 'assignment'],
    body: 'The ONT model decides the policy-map variant: all-in-one (RG) units take the tagged map, bridge units the untagged one. Its serial must be assigned to this account in gaiia inventory.' },
  olt: { title: 'OLT and Calix SMx', owner: 'Network engineering', checks: ['product', 'headroom'],
    body: 'gaiia provisions through the Calix SMx template node. The product mapping has to name the service template and both policy maps, or provisioning for that product will not proceed.' },
  site: { title: 'Network Site', owner: 'Network engineering', checks: ['pools'],
    body: 'The subscriber is addressed from pools that must exist as IP Blocks on the gaiia Network Site. Those blocks come from NetBox, so a broken sync blocks activation.' },
  account: { title: 'gaiia account', owner: 'Customer success', checks: [],
    body: 'Activate Account starts the pending billing subscriptions and notifies the customer. It runs only after the ONT is verified, and only once.' },
};

function download(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const severityTag = (c: PreflightCheck) => c.severity === 'pass'
  ? <span className="status-tag pass"><Check size={11}/> Passed</span>
  : c.severity === 'warn' ? <span className="status-tag warn">Warning</span> : <span className="status-tag block">Blocked</span>;
const stepState = (events: Rehearsal['events'], run: number, id: StepId): EventStatus | 'idle' =>
  [...events].reverse().find(e => e.run === run && e.step === id && e.status !== 'scenario')?.status ?? 'idle';

function App() {
  const [tab, setTab] = useState<Tab>('migration');
  const [migration, setMigration] = useState<Migration>(initialMigration);
  const [attest, setAttest] = useState<Attestations>({ notice: false, rollback: false });
  const [config, setConfig] = useState<CalixConfig>(initialConfig);
  const [order, setOrder] = useState<Order>(() => initialOrder());
  const [rehearsal, setRehearsal] = useState<Rehearsal>(() => newRehearsal());
  const [fault, setFault] = useState<Fault>('ack-lost-after-write');
  const [running, setRunning] = useState(false);
  const [visible, setVisible] = useState(0);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState<NodeId>('olt');
  const [dialog, setDialog] = useState<'source' | 'help' | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const runId = useRef(0);
  const revision = useRef(1);
  useEffect(() => { if (dialog) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [dialog]);

  const site = siteContext(migration);
  const { checks, resolution } = preflight(order, config, site);
  const blockers = checks.filter(c => c.severity === 'block');
  const gates = cutoverGates(migration, attest);
  const cutoverReady = gates.every(g => g.passed);
  const locked = rehearsal.intent !== undefined || running;
  const events = rehearsal.events.slice(0, visible);
  const lastRun = events.at(-1)?.run ?? 0;
  const world = rehearsal.world;
  const openExceptions = world.exceptions.filter(e => e.open);
  const checksFor = (id: NodeId) => checks.filter(c => nodes[id].checks.includes(c.id));
  const nodeIssue = (id: NodeId) => checksFor(id).some(c => c.severity === 'block');

  const record = (label: string, before: Rehearsal, after: Rehearsal) =>
    setRecords(r => [...r, { id: ++runId.current, label, before, after }].slice(-12));
  async function run() {
    if (running) return;
    setRunning(true);
    const result = execute(rehearsal, config, site, fault);
    const start = rehearsal.events.length;
    setRehearsal(result); setOrder(result.order);
    record(faults.find(f => f.value === fault)!.label, rehearsal, result);
    for (let n = start + 1; n <= result.events.length; n++) {
      await new Promise(resolve => setTimeout(resolve, 170)); setVisible(n);
    }
    setRunning(false);
  }
  function operator(action: (r: Rehearsal) => Rehearsal, label: string) {
    const result = action(rehearsal);
    record(label, rehearsal, result); setRehearsal(result); setVisible(result.events.length);
  }
  function resetActivation() {
    const o = initialOrder();
    runId.current = 0; revision.current = 1;
    setConfig(initialConfig()); setOrder(o); setRehearsal(newRehearsal(o)); setRecords([]); setVisible(0); setFault('ack-lost-after-write');
  }
  function newRevision() {
    if (running) return;
    revision.current++;
    const next = { ...order, key: `FL-1046-R${revision.current}` };
    setOrder(next); setRehearsal(newRehearsal(next, rehearsal.world)); setVisible(0);
  }
  const editOrder = (o: Order) => { setOrder(o); setRehearsal(r => ({ ...r, order: o })); };

  const brief = () => implementationBrief({ migration, gates, config, order, checks, resolution, rehearsal, records });
  const exportBrief = () => download(`firstlight-${order.key.toLowerCase()}-handoff.md`, brief());
  const exportJson = () => download(`firstlight-${order.key.toLowerCase()}-evidence.json`, JSON.stringify({
    scope: 'FirstLight rehearsal. Fictional operator and simulated adapters; not an importable gaiia workflow.',
    migration, cutoverGates: gates, calixConfig: config, order, preflight: checks, resolution, rehearsal, attempts: records,
  }, null, 2), 'application/json');

  const nav = [
    { id: 'migration', name: 'Migration', icon: Server },
    { id: 'preflight', name: 'Preflight', icon: ListChecks },
    { id: 'activation', name: 'Activation', icon: GitBranch },
    { id: 'handoff', name: 'Handoff', icon: FileText },
  ] as const;
  const heading: Record<Tab, [string, string, string]> = {
    migration: ['CHG-021 · Valley-POP-01', 'NetBox migration', 'Repair the prefix sync, decide what can safely be removed, and review who the cutover touches.'],
    preflight: [order.key, 'Activation preflight', 'Check the Calix mappings, inventory and site address pools before anything is written.'],
    activation: [order.key, 'Activation rehearsal', 'Run the workflow against a simulated ONT and account, inject failures, and watch recovery.'],
    handoff: [order.key, 'Implementation handoff', 'Everything the customer’s team needs to build, review and operate this in gaiia.'],
  };
  const runLabel = running ? 'Running…' : rehearsal.status === 'active' ? 'Replay delivery' : rehearsal.runs ? 'Re-run workflow' : 'Run workflow';
  const faultGroups = [...new Set(faults.map(f => f.group))];

  return <div className="app-shell">
    <aside className="sidebar">
      <a href="#" className="wordmark" onClick={e => { e.preventDefault(); setTab('migration'); }}><span className="logo"><Activity size={17}/></span>FirstLight <span className="version">/ lab</span></a>
      <div className="workspace-picker"><span className="workspace-avatar">JV</span><div><b>Juniper Valley Fiber</b><span>Go-live rehearsal</span></div></div>
      <div className="nav-caption">IMPLEMENTATION</div>
      <nav aria-label="Workspace navigation">{nav.map(n => <button key={n.id} className={tab === n.id ? 'nav-item current' : 'nav-item'} onClick={() => setTab(n.id)} aria-current={tab === n.id ? 'page' : undefined}>
        <n.icon size={16}/>{n.name}
        {n.id === 'migration' && !cutoverReady && <span className="nav-count">Hold</span>}
        {n.id === 'preflight' && blockers.length > 0 && <span className="nav-count">{blockers.length}</span>}
      </button>)}</nav>
      <div className="sidebar-order"><span className="nav-caption">CURRENT ORDER</span><div><span className={`order-dot ${rehearsal.status === 'active' ? 'live' : ''}`}/> {order.key}</div><p>{order.accountId} · {order.product}<br/>{order.ont.model} · {order.pon}</p></div>
      <div className="sidebar-bottom">
        <button onClick={() => setDialog('help')}><CircleHelp size={15}/> Walkthrough</button>
        <a href="https://support.gaiia.com/hc/en-us/articles/49085616236443-NetBox-Integration" target="_blank" rel="noreferrer"><ArrowUpRight size={15}/> gaiia NetBox docs</a>
        <a href="https://support.gaiia.com/hc/en-us/articles/44225588902299-Workflow-Builder-Overview" target="_blank" rel="noreferrer"><ArrowUpRight size={15}/> gaiia Workflow Builder</a>
        <div className="profile"><span>KK</span><div><b>Khursheed Khan</b><small>FDE candidate project</small></div></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="app-header"><div><PanelLeftClose size={16}/><span className="header-divider"/><span>Juniper Valley Fiber</span><ChevronRight size={13}/><b>{nav.find(n => n.id === tab)?.name}</b></div><span className="environment"><span/> Simulated</span></header>
      <main>
        <div className="page-heading"><div><div className="breadcrumb">Implementation <span>/</span> {heading[tab][0]}</div><h1>{heading[tab][1]}</h1><p>{heading[tab][2]}</p></div>
          <div className="heading-actions"><Button variant="secondary" icon={<Code2 size={15}/>} onClick={() => setDialog('source')}>Source</Button><Button variant="secondary" disabled={running} icon={<Download size={15}/>} onClick={exportBrief}>Export handoff</Button></div></div>

        <ol className="golive" aria-label="Go-live readiness">
          <li className={cutoverReady ? 'done' : 'hold'}><button onClick={() => setTab('migration')}><b>Site data</b><span>{cutoverReady ? 'CHG-021 ready' : 'CHG-021 on hold'}</span></button></li>
          <li className={blockers.length ? 'hold' : 'done'}><button onClick={() => setTab('preflight')}><b>Preflight</b><span>{blockers.length ? `${blockers.length} blocking` : 'Clear'}</span></button></li>
          <li className={rehearsal.status === 'active' ? 'done' : rehearsal.runs ? 'hold' : ''}><button onClick={() => setTab('activation')}><b>Activation</b><span>{rehearsal.runs ? statusText[rehearsal.status] : 'Not run'}</span></button></li>
          <li className={rehearsal.status === 'active' && cutoverReady ? 'done' : ''}><button onClick={() => setTab('handoff')}><b>Handoff</b><span>{rehearsal.status === 'active' && cutoverReady ? 'Ready to share' : 'Draft'}</span></button></li>
        </ol>

        <div className="section-tabs"><SegmentedControl<Tab> kind="tabs" variant="underline" aria-label="Implementation stages" value={tab} onChange={setTab}
          options={[{ value: 'migration', label: 'Migration', controls: 'panel-migration' }, { value: 'preflight', label: 'Preflight', count: blockers.length || undefined, controls: 'panel-preflight' }, { value: 'activation', label: 'Activation', controls: 'panel-activation' }, { value: 'handoff', label: 'Handoff', controls: 'panel-handoff' }]}/>
          <span className="section-meta">{tab === 'migration' ? `${migration.log.length} operations` : tab === 'activation' ? `${events.length} events · ${rehearsal.runs} runs` : tab === 'preflight' ? `${checks.length} checks` : 'Generated from live state'}</span></div>

        {tab === 'migration' && <NetworkPanel migration={migration} onChange={setMigration} attest={attest} onAttest={setAttest} gates={gates}/>}

        {tab === 'preflight' && <section className="discovery" id="panel-preflight" role="tabpanel" aria-label="Preflight">
          <div className="topology"><div className="topology-label">SERVICE PATH <span>GPON · Calix SMx</span></div>
            <div className="topology-nodes">{([
              { id: 'ont', icon: Router, name: 'ONT', value: `${order.ont.model} · ${order.ont.serial}` },
              { id: 'olt', icon: Server, name: 'OLT · SMx', value: order.pon },
              { id: 'site', icon: Network, name: 'Network Site', value: site.name },
              { id: 'account', icon: CreditCard, name: 'gaiia account', value: `${order.accountId} · ${world.accountStatus}` },
            ] as const).map((n, i) => <div key={n.id} className="topology-segment">{i > 0 && <span className="path-link"><ArrowRight size={13}/></span>}
              <button className={`topology-node ${selected === n.id ? 'selected' : ''} ${nodeIssue(n.id) ? 'has-issue' : ''}`} onClick={() => setSelected(n.id)}>
                <div><n.icon size={17}/><span className={nodeIssue(n.id) ? 'node-status warning' : 'node-status'}/></div><b>{n.name}</b><span>{n.value}</span>
                <small>{nodeIssue(n.id) ? 'Blocked' : n.id === 'account' ? (world.accountStatus === 'active' ? 'Active' : 'Pending') : 'Ready'}</small></button></div>)}</div>
            <div className="topology-foot"><span>ONT → splitter SP-07 → OLT-01 → Valley-POP-01 → gaiia</span><span>Click a stage to inspect it</span></div></div>

          <div className="discovery-columns"><div className="checks-section">
            <div className="section-heading"><h2>Readiness checks</h2><span>{blockers.length ? `${blockers.length} blocking` : 'Nothing blocking'}</span></div>
            <div className="checks-table pf-table"><div className="table-head"><span>Check</span><span>Observed</span><span>Result</span></div>
              {checks.map(c => <div className="table-row" key={c.id}><span>{c.label}</span><span>{c.detail}</span><span>{severityTag(c)}</span></div>)}</div>
            {checks.find(c => c.id === 'pools' && c.severity === 'block') && <div className="inline-issue"><AlertTriangle size={15}/><div><b>The subscriber’s address pool has not reached gaiia.</b><p>The NetBox site was renamed, so prefix webhooks for Valley-POP-01 are being skipped. Fix the sync in the migration rehearsal.</p></div><Button variant="secondary" size="sm" onClick={() => setTab('migration')}>Open migration</Button></div>}
            <MappingEditor config={config} order={order} onChange={setConfig} disabled={running}/>
            <OrderEditor order={order} onChange={editOrder} locked={locked} onRevision={newRevision}/>
            <div className="section-bottom"><span>{blockers.length ? 'Resolve the blocking checks before activation.' : 'Preflight is clear. Nothing has been written yet.'}</span><Button iconRight={<ArrowRight size={14}/>} onClick={() => setTab('activation')}>Rehearse activation</Button></div>
          </div>
          <aside className="inspector"><div className="inspector-label">STAGE <span>0{(['ont', 'olt', 'site', 'account'] as NodeId[]).indexOf(selected) + 1}</span></div>
            <h3>{nodes[selected].title}</h3><p>{nodes[selected].body}</p>
            <dl><dt>Owner</dt><dd>{nodes[selected].owner}</dd>
              {checksFor(selected).map(c => <Fragment key={c.id}><dt>{c.label}</dt><dd>{c.detail}</dd></Fragment>)}
              {selected === 'olt' && resolution && <><dt>Resolved</dt><dd className="mono">{resolution.serviceTemplate} · {resolution.policyMap} · {resolution.ontProfile}/{resolution.mainPort}</dd></>}</dl>
            <div className="inspector-note"><CircleHelp size={14}/><span>Mapping values come from the customer’s SMx configuration. Confirm them with their network team.</span></div></aside></div>
        </section>}

        {tab === 'activation' && <section id="panel-activation" role="tabpanel" aria-label="Activation">
          <div className="section-heading"><h2>Workflow</h2><span className="mono">idempotency key: {order.key}</span></div>
          <div className="activation-columns"><div className="workflow">
            {steps.map((s, i) => { const state = stepState(events, lastRun, s.id); const cls = state === 'adopted' || state === 'resolved' ? 'reconciled' : state === 'retrying' || state === 'opened' ? 'held' : state;
              return <div className={`workflow-row ${cls}`} key={s.id}><span className="workflow-index">{['passed', 'adopted', 'resolved', 'skipped'].includes(state) ? <Check size={14}/> : state === 'failed' ? <X size={14}/> : ['held', 'retrying', 'opened'].includes(state) ? <Clock3 size={13}/> : i + 1}</span>
                <div><h3>{s.title}</h3><p>{s.description}</p><small>{s.node}</small></div><span className={`state-label ${state}`}>{state === 'idle' ? 'Waiting' : state[0].toUpperCase() + state.slice(1)}</span></div>; })}
            <div className="workflow-footer"><ShieldCheck size={14}/> Retries: 3 attempts, 2 s then 4 s backoff. Unknown outcomes are read back before any retry.</div></div>
            <aside className="run-controls"><h3>Test conditions</h3>
              <label htmlFor="fault">Failure scenario</label>
              <select id="fault" value={fault} disabled={running} onChange={e => setFault(e.target.value as Fault)}>
                {faultGroups.map(g => <optgroup label={g} key={g}>{faults.filter(f => f.group === g).map(f => <option key={f.value} value={f.value}>{f.label}</option>)}</optgroup>)}</select>
              <p>{faults.find(f => f.value === fault)!.description}</p>
              {blockers.length > 0 && <div className="run-notice warning"><AlertTriangle size={15}/><div><b>{blockers.length} blocking preflight {blockers.length === 1 ? 'check' : 'checks'}</b><p>A run will stop in preflight with zero writes. That is worth seeing once.</p><button className="text-button" onClick={() => setTab('preflight')}>Review preflight <ArrowRight size={12}/></button></div></div>}
              {!running && rehearsal.status === 'active' && <div className="run-notice success"><CheckCheck size={15}/><div><b>Service active</b><p>Replay the delivery: the workflow reads the account and exits without writing.</p></div></div>}
              {!running && rehearsal.status === 'awaiting-field' && <div className="run-notice warning"><Wrench size={15}/><div><b>Technician dispatched</b><p>Configuration is kept on the ONT for diagnosis. The account is pending and unbilled.</p><Button size="sm" variant="secondary" onClick={() => operator(r => recordFieldRepair(r), 'Field repair recorded')}>Record field repair</Button></div></div>}
              {!running && rehearsal.status === 'conflict' && world.ont.service && world.ont.service.account !== order.accountId && <div className="run-notice warning"><Ticket size={15}/><div><b>ONT belongs to {world.ont.service.account}</b><p>Nothing was overwritten. Confirm the old account is cancelled, then remove its service.</p><Button size="sm" variant="secondary" onClick={() => operator(releaseForeignService, 'Stale service removed')}>Confirm and remove old service</Button></div></div>}
              {!running && rehearsal.status === 'activation-failed' && <div className="run-notice warning"><Ticket size={15}/><div><b>Activate Account failed</b><p>The ONT is verified and the account is still pending. Re-run with “No failure” to finish. The provisioning is adopted, not repeated.</p></div></div>}
              <Button className="run-button" loading={running} disabled={running} icon={rehearsal.status === 'active' ? <GitBranch size={14}/> : rehearsal.runs ? <RotateCcw size={14}/> : <Play size={14}/>} onClick={run}>{runLabel}</Button>
              <Button className="reset-button" variant="ghost" icon={<RotateCcw size={13}/>} disabled={running} onClick={resetActivation}>Reset activation</Button>
              <div className="counters quad">
                <div><b>{running ? '—' : world.controllerWrites}</b><span>SMx writes applied<small>{world.controllerRequests} {world.controllerRequests === 1 ? 'request' : 'requests'} sent</small></span></div>
                <div><b>{running ? '—' : world.notifications}</b><span>Activation notices<small>{world.activateRequests} Activate Account {world.activateRequests === 1 ? 'call' : 'calls'}</small></span></div>
              </div>
              <div className="billing-status"><span>Account</span><b><span className={!running && world.accountStatus === 'active' ? 'dot active' : 'dot'}/>{world.accountStatus === 'active' ? 'Active · billing started' : 'Pending · not billed'}</b></div>
              <div className="billing-status"><span>Open exceptions</span><b>{openExceptions.length ? openExceptions.map(e => e.id).join(', ') : 'None'}</b></div>
            </aside></div>
          <WorldPanel rehearsal={rehearsal} running={running}/>
          <div className="trace"><div className="section-heading"><h2><Terminal size={15}/> Execution log</h2><span aria-live="polite">{events.length} events {running ? '· running' : ''}</span></div>
            {events.length === 0 ? <div className="empty-trace"><Terminal size={18}/><span>No executions yet. Run the workflow to see each node’s result.</span></div>
              : <div className="trace-scroll" aria-live="polite"><div className="trace-head run-col"><span>#</span><span>Run</span><span>Node</span><span>Result</span><span>Detail</span></div>
                {events.map(e => <div className="trace-row run-col" key={e.seq}><span className="mono">{String(e.seq).padStart(2, '0')}</span><span className="mono">{e.run}</span><span className="mono">{e.step}</span><span className={`state-label ${e.status}`}>{e.status}</span><p>{e.message}</p></div>)}</div>}</div>
          <RunHistory records={records}/>
        </section>}

        {tab === 'handoff' && <section id="panel-handoff" role="tabpanel" aria-label="Handoff">
          <div className="brief"><div className="brief-title"><FileText size={22}/><div><h2>Juniper Valley Fiber · {order.key}</h2><p>NetBox migration CHG-021 and first fiber activation on gaiia</p></div><Button variant="secondary" disabled={running} icon={<Download size={14}/>} onClick={exportBrief}>Download .md</Button></div>
            <div className="brief-section"><h3>Where things stand</h3><dl className="brief-facts">
              <dt>CHG-021 cutover</dt><dd>{cutoverReady ? 'All gates passed' : `Hold: ${gates.filter(g => !g.passed).map(g => g.name.toLowerCase()).join('; ')}`}</dd>
              <dt>Preflight</dt><dd>{blockers.length ? blockers.map(b => b.detail).join(' ') : `Clear. ${resolution ? `${resolution.serviceTemplate} with ${resolution.policyMap}.` : ''}`}</dd>
              <dt>Activation</dt><dd>{statusText[rehearsal.status]} after {rehearsal.runs} run{rehearsal.runs === 1 ? '' : 's'}: {world.controllerWrites} SMx write{world.controllerWrites === 1 ? '' : 's'} from {world.controllerRequests} request{world.controllerRequests === 1 ? '' : 's'}, {world.notifications} activation notice{world.notifications === 1 ? '' : 's'}.</dd>
              <dt>Open exceptions</dt><dd>{openExceptions.length ? openExceptions.map(e => `${e.id} ${e.title}`).join('; ') : 'None'}</dd></dl></div>
            <div className="brief-section"><h3>Workflow in gaiia</h3><p className="subtle">Node mapping for the customer’s Workflow Builder build. Retry, timeout and error routing are set per node.</p>
              <div className="mapping-table wide">
                <span>Trigger</span><b>Event or Webhook: order ready for activation</b>
                {steps.map(s => <Fragment key={s.id}><span>{s.title}</span><b>{s.node}</b></Fragment>)}
                <span>ONT or account conflict</span><b>Tickets: Create Internal Ticket</b>
                <span>Optical or field fault</span><b>Workforce: Create Work Order</b>
                <span>Audit trail</span><b>Create Activity Log Comment</b></div></div>
            <div className="brief-section"><h3>Failure handling</h3>
              {faults.filter(f => f.value !== 'none').map(f => <div className="policy-row" key={f.value}><b>{f.label}</b><p>{f.description}</p></div>)}</div>
            <div className="brief-section evidence-summary"><h3>Evidence</h3><span>Runs <b>{rehearsal.runs}</b></span><span>SMx writes <b>{world.controllerWrites}</b></span><span>Notices <b>{world.notifications}</b></span><span>Exceptions <b>{world.exceptions.length}</b></span></div></div>
          <div className="handoff-actions"><Button variant="secondary" disabled={running} icon={<Download size={14}/>} onClick={exportJson}>Export evidence JSON</Button><span className="subtle">The handoff includes the migration log, cutover gates, mappings, preflight, every attempt and open exceptions.</span></div>
        </section>}

        <footer className="app-footer"><span><Circle size={8}/> Fictional operator. Simulated NetBox, Calix SMx and gaiia; no external calls.</span><span>State lives in this tab and resets on refresh.</span></footer>
      </main>
    </div>
    <dialog ref={dialogRef} className="source-dialog" onCancel={() => setDialog(null)} onClick={e => { if (e.target === dialogRef.current) setDialog(null); }}>
      <header><h2>{dialog === 'help' ? 'Five-minute walkthrough' : tab === 'migration' ? 'src/network.ts' : 'src/engine.ts'}</h2><Button variant="ghost" icon={<X size={17}/>} aria-label="Close dialog" onClick={() => setDialog(null)}/></header>
      {dialog === 'help' ? <div className="help-body"><ol>
        <li><b>Migration.</b> Run full sync: nothing is created, because NetBox renamed the site and gaiia matches names exactly. Rename the gaiia site and sync again; the IPv6 pool arrives.</li>
        <li>Remove the stale <code>198.51.100.0/24</code>. Try the same on <code>203.0.113.0/25</code>: it is refused, because 14 subscribers are still on it. Restore it in NetBox instead.</li>
        <li>Pick a change target and notice that suspended and pending accounts are not counted as impacted.</li>
        <li><b>Preflight.</b> Fill the empty Tagged Policy Map. The 844G-1 is an all-in-one unit, so it needs the tagged map.</li>
        <li><b>Activation.</b> Run “Response lost after write”. The workflow reads the ONT, finds its own write and adopts it: one write, one notice. Replay the delivery and nothing changes.</li>
        <li>Reset and try “Low optical level”, “ONT still has old service” and “Activate Account fails”. Each one stops safely and opens the right exception.</li>
        <li><b>Handoff.</b> Export the brief. It is generated from what you just did.</li></ol>
        <p>Everything runs in your browser against simulated systems. The code that decides each outcome is under Source.</p></div>
        : <><p className="source-caption">The pure TypeScript that drives this screen. Tests in <code>tests/</code> run the same functions.</p><pre><code>{tab === 'migration' ? networkSource : engineSource}</code></pre>
          <div className="dialog-actions"><Button variant="secondary" icon={<Download size={14}/>} onClick={() => download(tab === 'migration' ? 'network.ts' : 'engine.ts', tab === 'migration' ? networkSource : engineSource)}>Download</Button></div></>}
    </dialog>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
