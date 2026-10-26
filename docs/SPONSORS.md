# How Lotline uses Zetaris, Meterless and NVIDIA

Each sponsor technology owns one job. Take any of them away and a recall run cannot finish.

| Job | Technology | Code |
|---|---|---|
| Read five partner systems in place | **Zetaris** data layer | `packages/adapters/src/data/zetaris.ts`, `scripts/setup-zetaris.ts` |
| Leave the data layer better than we found it | **Zetaris** Unified Semantic Layer + data-quality rules | `packages/agents/src/steward.ts` |
| Every model call | **Meterless Nightshift** (chat-completions endpoint, signed compute receipts) | `packages/adapters/src/model/nightshift.ts` |
| Read scanned bills of lading locally | **Meterless Nightshift** document reader (local OCR specialist) | `packages/adapters/src/model/ocr.ts`, `packages/agents/src/docreader.ts` |
| Trace graph | **Meterless World Model** engine — our implementation | `packages/engines/world-model` |
| Action gate | **Meterless Scout Intent** engine — our implementation | `packages/engines/scout`, `packages/agents/src/gate.ts` |
| Partner memory between runs | **Meterless H-MEM** engine — our implementation | `packages/engines/hmem`, `packages/agents/src/memory.ts` |
| Nightly traceability drill | **Meterless Markovian** engine — our implementation | `packages/engines/markovian`, `packages/agents/src/drill.ts` |
| Reading, judging, deciding, drafting | **NVIDIA Nemotron**, served through Nightshift | lanes in `.env.example`; model per call in `logs/*.jsonl` |

## Zetaris: the data layer

A recall touches records kept by five companies: a grower's harvest spreadsheets, a packer's ERP, the distributor's warehouse system and master data, the retail chains' receiving API and a carrier's bill-of-lading index. Partners do not send you copies of their systems. Zetaris lets Lotline query each one where it lives.

- **Registration** (`scripts/setup-zetaris.ts`). The packer ERP, the warehouse system and the master data are PostgreSQL databases, registered with `CREATE DATASOURCE` and `REGISTER DATASOURCE TABLES`. Grower and carrier files are `CREATE LIGHTNING FILESTORE TABLE` over CSV. The retail chains' receiving API is a `CREATE LIGHTNING REST TABLE`. Every table is then addressed as `<system>.<table>` and joined across systems in plain SQL.
- **Every read goes through Zetaris.** No agent opens a partner database. `ZetarisClient` sends one Lightning SQL statement per call to `POST /api/v1.0/sql-editor/sqls/run`. Each call is traced with its SQL, its request id and its row count. The request id travels with every piece of evidence into the FDA spreadsheet (`evidence_query_id`), so any row a regulator questions points back to the exact query that produced it.
- **Discovery, not hard-coding.** The SourceMapper agent lists what is registered, describes each table and maps tables to FSMA tracking events (harvest, cooling, shipping, receiving, transformation). The tracer builds its SQL from that map; a mapping that names a column the catalog does not have is rejected.
- **Write-back.** After a live run the DataSteward agent publishes `lightning.metastore.lotline.traceability.cte_event`: one row per tracking event across every partner system, with traceability lot codes canonicalised the way the agents learned to (the warehouse's `PK-yyMMdd-n` folded back to the packer's `PKyyMMddnnn`). It registers data-quality rules for the record problems the run had to argue around (`lot_code_as_assigned`, `shipping_has_document`, `quantity_recorded`), runs them and reports how many records fail. The next analyst starts from one governed view instead of five raw systems.

## Meterless Nightshift: the model provider

Every model call goes to Nightshift's chat-completions endpoint (`http://127.0.0.1:8088/v1`). No product code calls a model provider directly.

- **Lanes.** Agents ask for a lane, not a model: `reason`, `judge`, `fast`, `vision`. Lanes are pinned to models in `.env` so the trace always shows which model did what.
- **Signed receipts.** Nightshift returns a compute receipt with every answer: requested model, routed model, latency and an ed25519-signed envelope. Lotline logs the receipt id beside the model on every model event (`detail.receipt_id`), so each decision in a run can be matched to Nightshift's own signed record.
- **Cross-model panel.** When documents cannot settle a chain-of-custody link, the critic sends it to three Nemotron models at once. Two-thirds agreement decides it; a split leaves the link unproven and the store on HOLD.
- **Local document reader.** Scanned bills of lading are read by Nightshift's OCR specialist on this machine (no egress); a Nemotron model then turns the text into fields. Text written on a document that reads like an instruction is extracted as data and never followed.

## Meterless engines, implemented by us and checked by the official suites

Meterless publishes its engines as specifications with conformance suites, not as packages. We implemented all four in TypeScript and vendored the official runners unchanged (`packages/engines/vendor/meterless/`, with their licence and notice). Outputs are committed in `docs/conformance/`.

| Engine | What it does in Lotline | Check | Result |
|---|---|---|---|
| **World Model** | The trace graph. Every link a tracer proposes becomes a bitemporal edge with provenance: source table, row key, Zetaris query id. `reachableFrom` walks transformations backwards and shipments forwards to find every affected location as of a date; a rejected link never propagates. Running the same recall twice is an idempotent ingest. | `pnpm conformance:wm` | 8/8 |
| **Scout Intent** | The action gate. No action happens without a signed execution contract (HMAC-SHA256 over canonical JSON). PULL and notifications need a person's approval; CLEAR is refused without positive evidence; any request carrying instruction-like partner text is refused as injection. | `pnpm conformance:scout` (Meterless eval harness, 32 cases) | every metric 1.000 against floors of 0.80–0.94 |
| **H-MEM** | Partner memory. What a run learns about a partner's records — the warehouse's lot spelling, a chain truncating lot codes, a receiving clock running a day behind — is stored with provenance in a trust ledger and recalled by the SourceMapper and the critic in the next run. | `pnpm conformance:hmem` | 13/13 |
| **Markovian** | The nightly drill: mock recalls over dozens of active lots, processed in bounded chunks with a compressed carried state, so a long overnight run never grows its context. | `pnpm conformance:markovian` | 8/8 |

## NVIDIA Nemotron

All language work runs on Nemotron through Nightshift:

- **Nemotron 3.5 Lightning 30B-A3B** (`reason`): reads the recall notice, maps unfamiliar partner catalogs, decides the critic's next step on a contested link, structures OCR text from bills of lading, recommends an action per location.
- **Nemotron 3 Ultra 550B-A55B** (`judge`): the heaviest vote on the cross-model panel.
- **Nemotron 3.5 Bolt E4B** (`fast`): panel vote and notification drafts.

The trace of every run (`logs/<run>.jsonl`) shows which Nemotron model handled each decision, with its Nightshift receipt id. Deterministic fallbacks are logged as `rules/fallback`, never as a model.

## What is unusual about how we used them

- The sponsor technologies carry the **safety argument**, not just the plumbing. Zetaris query ids are the evidence pointers in the FDA spreadsheet. World Model provenance is how a reviewer sees why a store was pulled. Scout contracts are what stop a CLEAR the evidence does not support. Nemotron panels decide the cases documents cannot.
- All four Meterless engines are **our own implementations**, each passing the official Meterless suite. Scout has no upstream reference implementation.
- A run **writes back** a governed semantic layer and quality rules into Zetaris instead of only reading from it.
