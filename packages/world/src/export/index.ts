import type { World } from "../types.ts";
import { exportDuckDb } from "./duckdb.ts";
import { exportFiles } from "./files.ts";

export { exportDuckDb, type DuckDbExportOptions, type DuckDbExportReport } from "./duckdb.ts";
export { exportFiles, publicNotices, type FileExportOptions, type FileExportReport } from "./files.ts";

/**
 * Every sink a world can be written to. Each exporter takes the same in-memory
 * world and a target (directory, file, or connection string), so new partner
 * backends plug in here without touching the generator.
 */
export interface WorldExporter {
  readonly name: string;
  export(world: World, target: string): Promise<unknown>;
}

export const exporters: Record<string, WorldExporter> = {
  files: { name: "files", export: (world, target) => exportFiles(world, target) },
  duckdb: { name: "duckdb", export: (world, target) => exportDuckDb(world, target) },
};
