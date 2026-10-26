import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Lane } from "./types.ts";

export interface CacheEntry {
  key: string;
  lane: Lane;
  model: string;
  raw: string;
  receiptId?: string;
}

/** Cache key for a model call: the lane plus the exact prompt pair. */
export function cacheKey(lane: Lane, system: string, user: string): string {
  return createHash("sha256").update(`${lane}\u0000${system}\u0000${user}`).digest("hex");
}

export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as CacheEntry;
      this.entries.set(entry.key, entry);
    }
  }

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  put(entry: CacheEntry): void {
    if (this.entries.get(entry.key)?.raw === entry.raw) return;
    this.entries.set(entry.key, entry);
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
  }
}
