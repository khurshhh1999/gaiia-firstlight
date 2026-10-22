# FirstLight: reviewer guide

**Live:** https://gaiia-firstlight.vercel.app · **About 5 minutes** · Everything runs in the browser against simulated systems.

FirstLight rehearses one slice of a gaiia implementation: getting a fiber operator's first subscriber live. It does the NetBox data repair the activation depends on, the Calix configuration check, and the activation workflow itself, including what happens when each step fails.

## Walkthrough

**1. Migration (opens first).**
- Click **Run full sync**. Nothing is created. NetBox renamed the site to `Valley-POP-01`, and gaiia matches names exactly, so the prefixes are skipped silently.
- Click **Rename gaiia site**, then sync again. The IPv6 pool arrives. The region-scoped and role-filtered prefixes stay out, as documented.
- **Remove** the stale `198.51.100.0/24`. Then try `203.0.113.0/25`: it's refused because 14 subscribers are still on it. **Restore in NetBox** instead.
- Switch the change target to *OLT-01*. The suspended and pending accounts are not counted.

**2. Preflight.** One blocker remains: Fiber 1000 has no Tagged Policy Map, and the 844G-1 is an all-in-one unit. Click **Use SMx value**. Preflight clears.

**3. Activation.** Run the default **Response lost after write**. The workflow reads the ONT, finds its own write and adopts it, ending with 1 write and 1 notice. **Replay delivery**: zero new requests. Then reset and try **Low optical level**, **ONT still has old service** and **Activate Account fails**. Each one stops safely and opens the right ticket or work order.

**4. Handoff.** Click **Export handoff**. The Markdown is generated from what you just did, including the gaiia node mapping, gates, evidence and open exceptions.

## What to look for

- The activation path uses gaiia's own nodes, ending in `Account Management: Activate Account`. gaiia is the BSS here, not an external system to call.
- Recovery reads a simulated device that is separate from the workflow's own log, so "reconciled" means something.
- Data gates are computed. Only the two genuinely human sign-offs are checkboxes.
- The migration and activation share state: a broken NetBox sync really does block FL-1046.

## Code

`src/engine.ts` and `src/network.ts` are pure TypeScript; the UI only renders them. 29 tests in `tests/` (`npm test`). See [README.md](README.md) for the design and sources.
