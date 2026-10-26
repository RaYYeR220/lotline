// The retail chains' receiving API: GET /receipts[?chain_id=..&store_id=..&since=YYYY-MM-DD] -> JSON array.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(process.env.RECEIPTS_FILE ?? "/seed/receipts.json", "utf8"));
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
