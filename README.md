# Lotline

**Lotline traces a food recall across five companies' records and refuses to mark any store clear that it cannot prove clean.**

When FDA or a supplier announces a recall, a produce distributor has 24 hours to hand FDA a sortable spreadsheet of every shipment and receipt of the affected lots (FSMA 204, the Food Traceability Rule) and to get the product off shelves. The records it needs sit in other companies' systems: the grower's harvest spreadsheets, the packer's ERP, its own warehouse system, the retail chains' receiving APIs and a carrier's scanned bills of lading. Each spells lot codes its own way; lots are split across trucks, commingled at repacking, short-shipped, and sometimes only provable from a stamped piece of paper.

Lotline takes the notice, queries every partner system in place through Zetaris, and has a team of agents argue about each link in the chain of custody before anyone acts on it. It returns:

- one action per location — **PULL** (affected product proven to be there), **HOLD** (possibly affected, not proven), **CLEAR** (proven to have received only unaffected lots) or **ESCALATE** — each backed by a signed execution contract, with PULL waiting for a person's approval;
- the **FDA sortable spreadsheet**, one row per tracking-event record, each row carrying the Zetaris query id that produced it; links that are not proven are listed separately, never mixed in;
- notification drafts per chain and customer (nothing is sent);
- a full trace of which agent did what, with which data and which model.

![Trace board after a run](docs/images/trace-board.png)

## Results

Graded against a hidden answer key: seven recall notices over a 60-day, 45-location partner world with nine planted record problems (lot-code drift, partial and commingled shipments, a receipt that exists only on a scanned bill of lading, a short delivery, a receiving clock running a day behind, a decoy lot one character away from a recalled one, a store whose records prove it clean, and a partner note that tells the system to clear a store). The agents never see the key.

| | Lotline (agents + rules, Nemotron through Nightshift) | One large prompt to the same model over the same records |
|---|---|---|
| Affected locations found | **97 / 97** | 76 / 97 |
| Affected locations missed | **0** | 16 |
| CLEAR on an affected location | **0** | 5 |
| PULL on an unaffected location | **0** | 66 |

Per-notice tables: [`eval/results/`](eval/results/). Reproduce with `pnpm eval` (recorded answers) or `LOTLINE_DATA=sample pnpm eval` (live models). The baseline is `eval/baseline.ts`.

## How it works

```mermaid
flowchart LR
  N[Recall notice] --> I[IntakeAgent]
  I --> M[SourceMapperAgent]
  M -- catalog, schemas --> Z[(Zetaris)]
  M -- partner quirks --> H[(H-MEM)]
  M --> T[TracerAgent]
  T -- Lightning SQL --> Z
  T -- proposed links --> C[EvidenceCritic]
  C -- narrower query --> T
  C -- scanned BOL --> D[DocReader]
  C -- contested link --> P{{Nemotron panel x3}}
  C -- ruled links --> W[(World Model)]
  W --> A[ActionPlanner]
  A -- contract request --> S[Scout gate]
  S -- signed contracts --> R[Reporter]
  R --> O[FDA spreadsheet, actions, drafts]
  R --> ST[DataSteward] -- semantic layer + DQ rules --> Z
  subgraph Partner systems queried in place
    G1[grower CSV] --- Z
    G2[packer ERP] --- Z
    G3[distributor WMS] --- Z
    G4[retail API] --- Z
    G5[carrier BOL index] --- Z
  end
```

| Agent | Job |
|---|---|
| **IntakeAgent** | Reads the notice into a bounded scope: commodity, lot codes or harvest window, firm, hazard. A model reads it; rules drop any lot code the notice does not contain. |
| **SourceMapperAgent** | Lists what Zetaris has registered, maps each table to an FSMA tracking event, recalls what earlier runs learned about each partner (H-MEM). |
| **TracerAgent** | Walks implicated lots forward through every system in SQL: repacks, packer shipments, distributor receiving, pallets, store deliveries, store receiving. Every hop becomes a link carrying the rows that support it. |
| **EvidenceCritic** | Holds each link to the proof bar (same lot after canonicalisation, same bill of lading, dates in order, quantities agree). A contested link goes back to the tracer for a narrower query, chosen by a model; what is still contested goes to a three-model Nemotron panel. A split panel leaves the link unproven. |
| **DocReader** | Reads scanned bills of lading with Nightshift's local document reader; a model turns the text into fields. Instructions written on a document are extracted as data and never followed. |
| **LotMatcher** | Checks near-miss lot codes (one character apart) before a store can be cleared. |
| **ActionPlanner** | Computes reachability in the World Model, finds stores with positive evidence of non-exposure, asks a model for a recommendation per location, and keeps the cautious answer: a proven PULL cannot be talked down, and a model asking for more caution must cite a record. |
| **Scout gate** | Issues a signed execution contract for each action. Refuses CLEAR without proven evidence and refuses anything a partner's free-text field asked for. |
| **Reporter** | Builds the FDA spreadsheet and notification drafts. |
| **DataSteward** | Publishes a governed traceability view and data-quality rules back into Zetaris (live mode). |
| **DrillAgent** | Nightly mock recalls over active lots, in bounded chunks, reporting which lots would not hold up today. |

Sponsor technology, in detail: [`docs/SPONSORS.md`](docs/SPONSORS.md). Pitch deck: [`docs/lotline-deck.pdf`](docs/lotline-deck.pdf). Demo video (3 min): https://youtu.be/o5Xg625DtGc

## Zetaris for coding agents (MCP)

`apps/mcp` is an MCP server over Lotline's Zetaris data layer, so a coding agent works with the partner systems the same way the recall agents do: in place, through one SQL endpoint.

| Tool | What it does |
|---|---|
| `list_sources`, `describe_table` | The Zetaris catalog: every partner system, its tables and columns, plus Lotline's semantic-layer tables |
| `run_sql` | One read-only Spark SQL statement across any partner systems; returns rows and the Zetaris query id |
| `register_file` | Registers a CSV a partner dropped in the Zetaris file store as a Lightning table |
| `publish_semantic_table` | Publishes a governed table in the Lotline semantic layer (`lightning.metastore.lotline.<usl>.<table>`), bound to a SELECT over the partner systems; columns cast, key never null |
| `quality_check` | Registers a data-quality rule on a semantic-layer table and runs it |

Writes stay inside the Lotline namespace and the partner file store. `.cursor/mcp.json` wires the server into Cursor (`agent mcp enable zetaris` in Cursor CLI).

**Scenario: a partner changes formats.** `npx tsx scripts/scenario-lakeview.ts` takes Lakeview Markets off the retail chains' API and drops their nightly CSV in the Zetaris file store, in their own format. A recall run can then no longer confirm Lakeview deliveries from the stores' own receiving records. Onboarding the file is a job for a coding agent with the MCP tools: register the CSV, publish `receiving.store_receipts` serving the API and the CSV together, check it, and run the tracer against it with `LOTLINE_STORE_RECEIPTS=lightning.metastore.lotline.receiving.store_receipts`. `--reset` puts Lakeview back on the API.

## Run it

Requirements: Node 22+ and pnpm 9 (`corepack enable`), or Docker.

### Sample mode — no services, no keys

Runs the real agents over a bundled snapshot of the partner world. Model answers come from responses recorded on live runs; where a prompt was never recorded, a deterministic rule answers and the trace says `rules/fallback`.

```bash
pnpm install
pnpm web:build
SAMPLE_MODE=true pnpm start          # http://localhost:8000  (landing)  and  /app  (trace board)
```

or with Docker:

```bash
docker build -t lotline .
docker run --rm -p 8000:8000 -e SAMPLE_MODE=true lotline
```

### Programmatic use

```bash
curl -s -X POST "http://localhost:8000/api/recalls?wait=true" \
  -H "content-type: application/json" -d @input_examples/example_1.json
```

| Endpoint | |
|---|---|
| `POST /api/recalls` | `{notice}` or `{openFdaRecallNumber}`; `?wait=true` returns the result, otherwise `202 {runId}` |
| `GET /api/runs/:id/events` | server-sent events: every trace event as it happens, then the result |
| `GET /api/runs/:id` | run status and result |
| `GET /api/runs/:id/spreadsheet.csv` | FDA sortable spreadsheet |
| `POST /api/approvals/:contractId` | `{decision: "approved" \| "rejected", by}` for pending PULL contracts |
| `POST /api/drills` | nightly traceability drill `{sample, days, asOf}` |
| `GET /api/examples` | the sample notices |

Command line: `pnpm trace --example input_examples/example_2.json`.

### Live mode — Zetaris + Meterless Nightshift

1. **Nightshift.** Install Meterless Nightshift, add an NVIDIA key under Setup → Providers (Nemotron lanes), and optionally install the verification pack (Setup → Preferences) for the local document reader. Lotline reads Nightshift's token from `%LOCALAPPDATA%\ai.meterless.runtime\proxy-token` if `NIGHTSHIFT_TOKEN` is not set.
2. **Zetaris.** Run the platform locally (Zetaris Cloud → Download, `docker compose up -d`, `./verify.sh`). In the Zetaris UI create an API token (Management → API Tokens) and note the organisation id (Management → Organisation).
3. **Partner systems.**
   ```bash
   cp .env.example .env              # set ZETARIS_API_TOKEN and ZETARIS_ORG_ID
   pnpm partners:export              # writes the seeded partner world
   pnpm partners:up                  # PostgreSQL, retail API, file store, on the Zetaris network
   pnpm zetaris:setup                # registers every source in Zetaris and checks row counts
   ```
4. **Run.** `pnpm start`, then open `/app`.

`LOTLINE_DATA=sample` keeps live models but reads the bundled snapshot instead of Zetaris; `RECORD_CACHE=1` records model answers for sample mode.

## Traces

Every run writes `logs/<runId>.jsonl` (and streams the same events to stdout and the UI): `timestamp, run_id, agent_name, action, input_summary, output_summary, target_agent, model, confidence, retry_count, status`, plus `detail` with the SQL, Zetaris query id, Nightshift receipt id or contract as relevant. A typical run has 60–110 events across nine agents, including handoffs, challenges, retries, panel votes, contract refusals and memory writes.

## Examples

`input_examples/` holds four notices: a harvest-window romaine recall with a commingled repack and an injected partner note (1), a packer lot recall whose receipt exists only on a scanned bill of lading (2), a product the network never handled (3), and a manufacturer's soft-cheese recall received direct to the warehouse (4). `output_examples/` holds the matching results produced in sample mode.

## Tests and engine conformance

```bash
pnpm test                       # unit and integration tests
pnpm conformance:wm             # World Model    — official Meterless suite, 8/8
pnpm conformance:scout          # Scout Intent   — official Meterless eval harness, all metrics 1.000
pnpm conformance:hmem           # H-MEM          — official Meterless suite, 13/13
pnpm conformance:markovian      # Markovian      — official Meterless suite, 8/8
```

## Honest limits

- **The partner world is generated.** No real company's records were available; the world is seeded and reproducible, and its answer key is what makes grading possible. The recall notices follow FDA enforcement-report fields.
- **Sample mode replays recorded model answers.** Notices or data it has not seen fall back to deterministic rules, and the trace labels them.
- **The CLEAR decision is as good as the window.** A store is cleared only for the exposure window computed from the affected deliveries; product received outside it is not considered.
- **Notifications are drafts.** Lotline does not contact anyone or place holds by itself; PULL contracts wait for a person.
- **The nightly drill's Nightshift job** needs a local model lane on the machine; without one the drill runs inside Lotline only.

More in [`docs/FAILURE_MODES.md`](docs/FAILURE_MODES.md) and [`docs/CLAIMS.md`](docs/CLAIMS.md).

## Repository

```
apps/api            HTTP API, live trace stream, approvals
apps/web            landing page and trace board
packages/core       types, run trace log, configuration
packages/adapters   Zetaris and DuckDB data layers, Nightshift model gateway and document reader
packages/agents     the agents, the orchestrator, the drill
packages/engines    World Model, Scout Intent, H-MEM, Markovian (+ vendored official suites)
packages/world      seeded partner-world generator
eval                graded evaluation, baseline, answer keys
infra, scripts      partner systems for Zetaris and their registration
data/sample         snapshot, notices, scans and recorded answers for sample mode
```

## License

MIT. Vendored Meterless conformance suites keep their Apache-2.0 licence and notice.
