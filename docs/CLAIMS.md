# Claims and evidence

Every claim in the README and the submission, with how to check it.

**REPRODUCIBLE** — run a command in this repository and see it. **RECORDED** — produced on a live run; the artefact is committed. **NOT CLAIMED** — things we deliberately do not claim.

| Claim | Status | Check |
|---|---|---|
| 97/97 affected locations found, 0 missed, 0 CLEAR on an affected location, 0 PULL on an unaffected location, seven notices | RECORDED (live models through Nightshift); REPRODUCIBLE in sample mode | `eval/results/seed-7-live.md`; `pnpm eval` |
| The single-prompt baseline finds 76/97, misses 16, clears 5 affected locations and pulls 66 unaffected ones | RECORDED | `eval/results/baseline-seed-7.json`; `eval/baseline.ts` |
| World Model implementation passes the official Meterless suite 8/8 | REPRODUCIBLE | `pnpm conformance:wm`; `docs/conformance/world-model.txt` |
| Scout Intent implementation meets every threshold of the official Meterless eval harness | REPRODUCIBLE | `pnpm conformance:scout`; `docs/conformance/scout.txt` |
| H-MEM implementation passes the official suite 13/13 | REPRODUCIBLE | `pnpm conformance:hmem`; `docs/conformance/hmem.txt` |
| Markovian implementation passes the official suite 8/8 | REPRODUCIBLE | `pnpm conformance:markovian`; `docs/conformance/markovian.txt` |
| Every model call goes through Nightshift and is logged with the model that served it | REPRODUCIBLE | `logs/*.jsonl`, events `nightshift.chat` (`model`, `detail.receipt_id`) |
| Every partner-data read goes through the data layer (Zetaris live, the snapshot in sample mode) | REPRODUCIBLE | events `zetaris.query` with `detail.sql`, `detail.query_id`, `detail.backend` |
| The injected partner note is refused by the Scout gate | REPRODUCIBLE | example 1; event `contract.refused` with reason `injection` |
| No location is cleared without positive evidence | REPRODUCIBLE | Scout policy test `clear without evidence refused`; planner sends `provenEvidenceCount` |
| The answer key is never read by the agents | REPRODUCIBLE | the key lives in `eval/keys/`, read only by `eval/run.ts` after a run |

## Not claimed

- That the partner world is real data. It is generated and seeded; see the README.
- That a live run produces exactly the same model text twice. Rules bound the decisions; the wording varies.
- That Lotline sends notifications or places holds. It drafts and issues contracts; people act.
- Any regulatory certification. The spreadsheet follows the FSMA 204 key data elements; it has not been reviewed by FDA.
