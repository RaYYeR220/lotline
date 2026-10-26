// Minimal JSONL file helpers for the local file store. Appends are one line per
// write; rewrites go through a temp file and a rename so a crash mid-write
// never leaves a half-written store behind.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Only a torn final line (crash during append) is tolerated; anything else is corruption.
      if (i < lines.length - 2) throw new Error(`H-MEM: corrupt line ${i + 1} in ${file}`);
    }
  }
  return out;
}

export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
}

export function writeJsonlAtomic(file: string, values: unknown[]): void {
  writeAtomic(file, values.map((v) => JSON.stringify(v) + "\n").join(""));
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}
