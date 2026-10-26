export type Row = Record<string, string | null>;

export interface QueryResult {
  queryId: string;
  backend: "zetaris" | "duckdb-sample";
  columns: string[];
  rows: Row[];
  elapsedMs: number;
  sql: string;
}

export interface QueryContext {
  agent: string;
  purpose: string;
  timeoutMs?: number;
  targetAgent?: string;
}

/** The only way agents read partner data. Live: Zetaris over REST. Sample: a DuckDB snapshot of the same tables. */
export interface DataLayer {
  readonly backend: QueryResult["backend"];
  query(sql: string, ctx: QueryContext): Promise<QueryResult>;
  listTables(ctx: QueryContext): Promise<{ source: string; table: string }[]>;
  describe(table: string, ctx: QueryContext): Promise<{ name: string; type: string }[]>;
  /** Statements that change the data layer itself (semantic layer, quality rules). Live only. */
  writeBack?(sql: string, ctx: QueryContext): Promise<QueryResult>;
  close(): Promise<void>;
}

export class DataTimeout extends Error {
  constructor(sql: string, ms: number) {
    super(`query exceeded ${ms} ms: ${sql.slice(0, 120)}`);
    this.name = "DataTimeout";
  }
}

export class DataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataError";
  }
}

/** The partner tables Lotline reads. Zetaris and the sample snapshot expose exactly these names. */
export const PARTNER_TABLES = [
  "grower.harvest", "grower.cooling",
  "packer.receipts", "packer.repacks", "packer.shipments",
  "wms.receiving", "wms.lpn", "wms.store_shipments",
  "retail.receipts", "carrier.bol_index",
  "ref.locations", "ref.firms",
] as const;
