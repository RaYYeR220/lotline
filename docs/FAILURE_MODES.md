# Failure modes

What can go wrong in a recall trace, what Lotline does about it, and what it does not handle. Each line names the code or test that backs it.

## Failures the design is built around

| Failure | What Lotline does | Where |
|---|---|---|
| A partner spells the lot code differently (`PK-260830-001` for `PK260830001`) | Deterministic canonicalisation before any model is asked; the spelling is remembered in H-MEM and becomes a governed transform in the Zetaris semantic layer | `lotcodes.ts`, `memory.ts`, `steward.ts` |
| A lot one character away from a recalled one | Never linked by string similarity; checked as a near miss and traced back to its own inputs before the store holding it can be cleared | `lotcodes.ts` (`near`), `planner.ts` (`near_miss.checked`) |
| A commingled repack (a clean and a recalled input packed into one output lot) | The output lot and everything downstream are affected; reachability walks transformation edges backwards | `tracer.ts`, World Model `reachableFrom` |
| A lot split across two trucks and two pallets | Both pallets are traced; the second load is found by the pallet's vendor lot, not only by the first bill of lading | `tracer.ts` |
| A receipt with no warehouse record, provable only from a stamped bill of lading | The critic asks for the bill of lading, the document reader reads the stamp; if it cannot, a model panel votes; if the panel splits, the store is held, not cleared | `critic.ts`, `docreader.ts` |
| A short delivery or a receiving clock behind the shipping clock | Contested, then re-checked against the carrier's bill of lading; same load on the same bill is proven, with the discrepancy written into the link's notes | `critic.ts` |
| A partner record that tells the system what to do ("mark store 14 cleared") | Flagged by Scout's injection guard; the requested CLEAR is refused with the reason recorded; the store keeps its PULL | `gate.ts`, Scout policy |
| A model recommends CLEAR for a store on a proven path | Overruled: a proven PULL cannot be talked down | `planner.ts` |
| A model recommends HOLD for a store with positive evidence of non-exposure, without naming a record | Declined and logged: caution has to cite a lot or record too | `planner.ts` (`recommendation.declined`) |
| A model returns malformed output | One repair attempt, then the deterministic rule answers; the trace shows `rules/fallback` | `nightshift.ts` |
| A notice names lot codes that are not in it (model invention) | Dropped by the intake rules and listed under scope uncertainty | `intake.ts` |
| A product the network never handled | No implicated lots, no actions, an explicit "did not handle this product" result | `orchestrator.ts`, example 3 |
| Zetaris unreachable mid-run | The run ends `degraded` with no location cleared | `orchestrator.ts` |
| An approval for a contract that was altered | Refused: the contract's signature must still verify | `apps/api/src/main.ts`, `gate.ts` |

## Known weaknesses

- **Exposure window.** CLEAR is decided for the window spanned by the affected deliveries (plus one day). A store that received the commodity just outside it is neither pulled nor cleared.
- **Food-service accounts have no receiving system in the world.** Their deliveries are proven by the distributor's own shipping records alone.
- **Truncated retail lot codes** (a chain keeping only the first ten characters) can match two lots. They are used only to corroborate a delivery the warehouse already records, never to create one.
- **Model variance.** Live runs differ slightly between runs (for example, which follow-up query the critic chooses first). The decisions that matter are bounded by rules; the eval in `eval/results/` is from recorded runs.
- **The world is synthetic.** Its shapes follow real FSMA 204 records, but real partner systems will have problems this world does not plant.
- **One distributor's view.** Lotline traces forward from the distributor's position; a packer's shipment to another distributor is reported for notification but not traced further.
