// The retail chains' receiving API: GET /receipts[?chain_id=..&store_id=..&since=YYYY-MM-DD] -> JSON array.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";

// receipts-api.json, when a scenario writes one, is what the chains currently post (see scripts/scenario-lakeview.ts).
const file = process.env.RECEIPTS_FILE ?? (existsSync("/seed/receipts-api.json") ? "/seed/receipts-api.json" : "/seed/receipts.json");
const rows = JSON.parse(readFileSync(file, "utf8"));
const port = Number(process.env.PORT ?? 8090);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://retail");
  if (url.pathname === "/healthz") return res.end("ok");
  if (url.pathname !== "/receipts") {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not_found" }));
  }
  const chain = url.searchParams.get("chain_id");
  const store = url.searchParams.get("store_id");
  const since = url.searchParams.get("since");
  const out = rows.filter((r) => (!chain || r.chain_id === chain) && (!store || r.store_id === store) && (!since || String(r.received_at) >= since));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}).listen(port, () => console.log(`retail receiving API on :${port}, ${rows.length} receipts`));
