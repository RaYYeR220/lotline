import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./contract.ts";
import { analyze, commonWords } from "./text.ts";
import type { Intent, RegistryDocument, RiskClass } from "./types.ts";

/** Source weights: how strongly a term found in each part of an intent record counts. */
const SOURCE_WEIGHT = { id: 1, example: 1, description: 0.6 } as const;

/** The safe fallback used when nothing clears the Reject band and the registry has none of its own. */
export const GENERAL_INTENT: Intent = {
  id: "GENERAL",
  category: "general",
  description: "Safe fallback: respond conversationally, never route to tools.",
  parameters: { type: "object", properties: {} },
  capabilities: [],
  riskClass: "low",
  surfaces: ["*"],
  roles: ["*"],
  examples: ["hello there", "what can you help me with?"],
  version: 1,
};

export interface Prototype {
  intent: string;
  terms: string[];
  weight: number;
}

/** Everything the Stage-1 scan needs, precomputed once per registry. */
export interface LexicalIndex {
  /** intent id -> term -> source weight (max over id, examples, description). */
  vocab: Map<string, Map<string, number>>;
  /** term -> number of intents whose vocabulary contains it. */
  df: Map<string, number>;
  /** intent id -> concept terms of its category and of its name. */
  idTerms: Map<string, { category: string[]; name: string[] }>;
  prototypes: Prototype[];
  /** lowercased entity -> intents whose examples mention it (used to phrase clarifications). */
  entityIntents: Map<string, Set<string>>;
  /** Words seen in ordinary lowercase use anywhere in the registry. */
  common: Set<string>;
  size: number;
}

const ID_GRAMMAR = /^[A-Za-z][\w-]*(?:\.[\w-]+)*$/;
const RISK: RiskClass[] = ["low", "medium", "high"];

function validate(raw: unknown, where: string): Intent {
  const i = raw as Partial<Intent>;
  const fail = (msg: string) => {
    throw new Error(`intent registry ${where}: intent "${i?.id ?? "?"}" ${msg}`);
  };
  if (!i || typeof i !== "object") fail("is not an object");
  if (typeof i.id !== "string" || !ID_GRAMMAR.test(i.id)) fail("has an id outside the category.name grammar");
  if (!Array.isArray(i.examples) || i.examples.length === 0) fail("has no examples (examples are mandatory)");
  if (!Array.isArray(i.capabilities)) fail("has no capabilities array");
  if (!RISK.includes(i.riskClass as RiskClass)) fail(`has riskClass "${i.riskClass}"`);
  return {
    id: i.id!,
    category: i.category ?? i.id!.split(".")[0]!,
    description: i.description ?? "",
    parameters: i.parameters ?? { type: "object", properties: {} },
    capabilities: [...i.capabilities!],
    riskClass: i.riskClass as RiskClass,
    surfaces: i.surfaces?.length ? [...i.surfaces] : ["*"],
    roles: i.roles?.length ? [...i.roles] : ["*"],
    examples: [...i.examples!],
    version: typeof i.version === "number" ? i.version : 1,
  };
}

/** The declared catalog of things the system may do. If it is not here, it cannot be acted on. */
export class IntentRegistry {
  readonly intents: Intent[];
  readonly version: number;
  /** sha256 over the canonical registry; stamped on contracts so engines can detect drift. */
  readonly digest: string;
  readonly index: LexicalIndex;
  private readonly byId: Map<string, Intent>;

  constructor(intents: Intent[], version = 1) {
    this.byId = new Map();
    for (const intent of intents) {
      if (this.byId.has(intent.id)) throw new Error(`intent registry: duplicate intent id "${intent.id}"`);
      this.byId.set(intent.id, intent);
    }
    this.intents = [...this.byId.values()];
    this.version = version;
    this.digest = "sha256:" + createHash("sha256").update(canonicalJson(this.intents)).digest("hex").slice(0, 32);
    this.index = buildIndex(this.intents);
  }

  static fromObject(doc: RegistryDocument | Intent[], where = "object"): IntentRegistry {
    const list = Array.isArray(doc) ? doc : doc.intents;
    if (!Array.isArray(list)) throw new Error(`intent registry ${where}: expected { intents: [...] }`);
    return new IntentRegistry(list.map((i) => validate(i, where)), Array.isArray(doc) ? 1 : (doc.version ?? 1));
  }

  static fromFile(file: string): IntentRegistry {
    if (!/\.json$/i.test(file)) throw new Error(`intent registry ${file}: only JSON registries are supported`);
    return IntentRegistry.fromObject(JSON.parse(readFileSync(file, "utf8")) as RegistryDocument, file);
  }

  /** One intent (or one { intents } document) per .json file. */
  static fromDirectory(dir: string): IntentRegistry {
    const parts: IntentRegistry[] = [];
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (!statSync(full).isFile() || !/\.json$/i.test(name)) continue;
      const doc = JSON.parse(readFileSync(full, "utf8")) as RegistryDocument | Intent;
      parts.push("intents" in doc ? IntentRegistry.fromObject(doc, full) : IntentRegistry.fromObject([doc as Intent], full));
    }
    return IntentRegistry.compose(parts);
  }

  static compose(registries: IntentRegistry[]): IntentRegistry {
    return new IntentRegistry(
      registries.flatMap((r) => r.intents),
      Math.max(1, ...registries.map((r) => r.version)),
    );
  }

  static load(source: string | IntentRegistry | RegistryDocument | Intent[]): IntentRegistry {
    if (source instanceof IntentRegistry) return source;
    if (typeof source !== "string") return IntentRegistry.fromObject(source);
    return statSync(source).isDirectory() ? IntentRegistry.fromDirectory(source) : IntentRegistry.fromFile(source);
  }

  get(id: string): Intent | undefined {
    return this.byId.get(id);
  }

  /** The registry's own GENERAL intent, or the built-in one. */
  general(): Intent {
    return this.byId.get("GENERAL") ?? GENERAL_INTENT;
  }
}

function buildIndex(intents: Intent[]): LexicalIndex {
  const common = commonWords(intents.flatMap((i) => [i.description, ...i.examples]));
  const isCommon = (w: string) => common.has(w);
  const vocab = new Map<string, Map<string, number>>();
  const idTerms = new Map<string, { category: string[]; name: string[] }>();
  const prototypes: Prototype[] = [];
  const entityIntents = new Map<string, Set<string>>();

  for (const intent of intents) {
    const v = new Map<string, number>();
    const add = (terms: string[], w: number) => {
      for (const t of terms) v.set(t, Math.max(v.get(t) ?? 0, w));
    };
    const [category = "", ...rest] = intent.id.split(".");
    const cat = analyze(category.replace(/[-_]/g, " ")).terms;
    const name = analyze(rest.join(" ").replace(/[-_]/g, " ")).terms;
    idTerms.set(intent.id, { category: cat, name });
    add([...cat, ...name], SOURCE_WEIGHT.id);

    const desc = analyze(intent.description, isCommon).terms;
    add(desc, SOURCE_WEIGHT.description);
    if (desc.length) prototypes.push({ intent: intent.id, terms: desc, weight: 0.8 });

    for (const example of intent.examples) {
      const a = analyze(example, isCommon);
      add(a.terms, SOURCE_WEIGHT.example);
      if (a.terms.length) prototypes.push({ intent: intent.id, terms: a.terms, weight: 1 });
      for (const e of a.entities) {
        const key = e.text.toLowerCase();
        if (!entityIntents.has(key)) entityIntents.set(key, new Set());
        entityIntents.get(key)!.add(intent.id);
      }
    }
    vocab.set(intent.id, v);
  }

  const df = new Map<string, number>();
  for (const v of vocab.values()) for (const t of v.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return { vocab, df, idTerms, prototypes, entityIntents, common, size: intents.length };
}
