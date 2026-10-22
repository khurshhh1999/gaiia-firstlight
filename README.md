# FirstLight

**A go-live rehearsal for a fiber ISP moving onto gaiia.**

FirstLight takes one realistic implementation slice, getting a small fiber operator's first subscriber live on gaiia, and works through it the way a forward-deployed engineer would. It repairs the NetBox data the activation depends on, checks the Calix configuration before anything is written, runs the provisioning workflow against a simulated network, and shows every failure ending in a known, recoverable state.

**Live demo:** [gaiia-firstlight.vercel.app](https://gaiia-firstlight.vercel.app) · **Reviewer guide:** [DEMO-NOTE.md](DEMO-NOTE.md)

---

## The scenario

Juniper Valley Fiber is a fictional GPON operator going live on gaiia. Before its first new subscriber, order **FL-1046**, can be activated, two problems surface:

1. **The NetBox sync is quietly broken.** A naming cleanup renamed the NetBox site `valley-pop-01` to `Valley-POP-01`. gaiia matches sites by exact, case-sensitive name, so every prefix webhook for that POP has been skipped since then. The new IPv6 delegation pool never arrived, and one prefix deleted in NetBox is still in gaiia even though 14 subscribers are using it.
2. **The Calix product mapping is incomplete.** *Fiber 1000* was configured before Product Mapping gained the required *Tagged Policy Map* field. The subscriber's 844G-1 is an all-in-one unit, so it needs exactly that map.

FirstLight walks through finding and fixing both, then rehearses the activation workflow under eight failure conditions.

## What it demonstrates

### 1. NetBox → gaiia migration (`src/network.ts`)

- Classifies every NetBox prefix the way the integration treats it: synced, missing, skipped because no site matches the name, outside the IPAM role filter, or not site-scoped.
- Repairs the association by renaming the **gaiia** site, since NetBox is the source of truth. Blocks, inventory and tickets stay on the same site record.
- Runs the additive full sync and shows that it never removes anything.
- Removes stale blocks by hand with three guards: the block must have been created by the integration, it must be gone from NetBox, and it must have **no live subscriber addresses** (from the BNG lease export). The in-use prefix is refused and restored in NetBox instead.
- Walks gaiia's upstream/downstream inventory to scope the cutover. Like *Add Accounts from Network Sites*, it counts only active services, so suspended and pending accounts are excluded and each account is counted once.
- Cutover gates: three are computed from the data and can't be ticked by hand, and two are human sign-offs that reset on any data change.

### 2. Activation workflow (`src/engine.ts`)

Mirrors the workflow you would build in gaiia's Workflow Builder:

| Step | gaiia node | Rule |
|---|---|---|
| Preflight | Execute TypeScript Code | Resolve the Calix product and ONT mappings, ONT assignment, site address pools and PON oversubscription |
| Read account | Accounts: Get Account | Already active → exit with no writes |
| Provision ONT | Calix SMx template node | Read first. Adopt a matching service, refuse a foreign one, otherwise write with bounded retries |
| Verify | HTTP REST Request · SMx device read | ONT online, Rx inside the GPON B+ window (−27 to −8 dBm) |
| Activate | Account Management: Activate Account | Re-read status before every attempt, because the node also notifies the customer |

The engine keeps **the workflow's record** separate from **the simulated world** (ONT state, account status, request and write counters, tickets). Recovery cannot cheat: after a timeout it has to read the device to learn what happened.

### 3. The two halves are connected

Activation preflight reads the gaiia Network Site produced by the migration rehearsal. Until the sync is repaired, FL-1046 is blocked because `2001:db8:10::/48` is not an IP Block on the site. That is the kind of dependency an implementation only finds when the data work and the workflow work are done together.

## Failure handling

| Scenario | What happens | End state |
|---|---|---|
| Response lost after write | Read-back finds the workflow's own write and adopts it | Active · 1 write · 1 notice |
| Request lost before write | Read-back finds nothing; one retry writes | Active · 2 requests · 1 write |
| Controller busy (503) | Two refusals, backoff of 2 s then 4 s, third attempt applies | Active · 3 requests · 1 write |
| ONT still has old service | Refuses to overwrite another account's config; opens an internal ticket | Conflict until ops confirms and removes it |
| Low optical level | Keeps the config for the technician; holds activation; opens one work order | Awaiting field repair · not billed |
| Activate Account fails | Three attempts, then a ticket; the ONT stays verified | Pending · not billed · not notified |
| Duplicate while running | The second delivery sees the in-flight execution and exits | No side effects |
| Replay after activation | Account already active → exits | No requests · still 1 notice |

A plan change on an already-provisioned ONT is treated as a conflict and pointed at *Modify Account Service*. It is not something activation should do quietly.

## Grounded in gaiia's documentation

| Behaviour | Source |
|---|---|
| Exact, case-sensitive site matching; skipped webhooks; additive full sync; manual removal after missed deletes; site-scope and role-filter rules | [NetBox Integration](https://support.gaiia.com/hc/en-us/articles/49085616236443-NetBox-Integration) |
| Site reference IDs, IP Blocks, inventory topology, *Add Accounts from Network Sites* (active only), GraphQL mutations | [Network Sites](https://support.gaiia.com/hc/en-us/articles/49758568394267-Network-Sites) |
| Node names, per-node retry/timeout/error routing, executions | [Workflow Builder Overview](https://support.gaiia.com/hc/en-us/articles/44225588902299-Workflow-Builder-Overview) |
| Service Template, Untagged/Tagged Policy Map, ONT profile and main port; incomplete mappings block provisioning | [Configuring Calix Product Mapping](https://support.gaiia.com/hc/en-us/articles/53067352774939-Configuring-Calix-Product-Mapping) |

Where the docs don't say, FirstLight says so instead of guessing. For example, the SMx device read is shown as an HTTP REST Request rather than a made-up node name.

## Project layout

```
src/
  engine.ts         Activation workflow: preflight, provisioning, verification, activation, recovery
  network.ts        NetBox migration: prefix classification, guarded repair, impact walk, cutover gates
  brief.ts          Generates the Markdown handoff from live state
  lab.ts            Before/after comparison of each attempt
  main.tsx          App shell, Preflight, Activation and Handoff screens
  network-panel.tsx Migration screen
  lab-panels.tsx    Calix mapping editor, order editor, simulated-world panel, attempt history
  components/       affectUI Button and Segmented Control (MIT)
tests/              29 tests on the same pure functions the UI runs
```

The engines are pure, deterministic TypeScript with no framework dependency. The React layer only renders their output, and the **Source** button in the app shows the exact code driving each screen.

## Run it

```sh
npm ci
npm run dev        # http://127.0.0.1:5173
npm test           # node:test, 29 tests
npm run build      # type-check and production build
```

Node 22.6+ is required for `--experimental-strip-types`. The app is static, with no environment variables or backend, and deploys to Vercel with the included `vercel.json`.

## Design decisions

- **Simulated by design.** NetBox, Calix SMx, the BNG lease export and gaiia are in-memory fixtures using documentation address ranges. The point is to make the decisions visible and testable, not to imitate an API.
- **Ground truth is separate from the log.** Without that separation, "reconciliation" is just the workflow agreeing with itself.
- **Failures don't tear things down by default.** A failed light check keeps the configuration, because the technician needs it, and a foreign service is never overwritten. Rollback is a decision for the customer's operations team, not a reflex.
- **Warnings are not gates.** PON oversubscription against an example 4:1 policy is surfaced but does not block, because that call belongs to capacity planning.

## With a real customer, next I would

1. Pull the real Product Mapping, ONT Mapping and SMx templates, and replace the fixtures with a read-only snapshot.
2. Diff NetBox against `networkSiteIpBlocks` for every site, not just one POP, and turn the result into a migration runbook.
3. Build the workflow in a gaiia sandbox: wire the read-back branch through error routing, and add failure alerts and an Activity Log comment per step.
4. Agree the optical thresholds, billing trigger and escalation owners with the customer's NOC and finance teams.

---

Built by Khursheed Khan · [Source on GitHub](https://github.com/khurshhh1999/gaiia-firstlight). UI components: [affectUI](https://www.affectui.com) Button and Segmented Control, MIT © Florian Höller (`public/affectui-LICENSE.txt`).
