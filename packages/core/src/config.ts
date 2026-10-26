export type Lane = "reason" | "fast" | "vision" | "guard" | "judge";

export interface LotlineConfig {
  sampleMode: boolean;
  zetaris: { baseUrl: string; token?: string; orgId?: string };
  nightshift: { baseUrl: string; token?: string };
  lanes: Record<Lane, string>;
  contractSecret: string;
  logsDir: string;
}

const LANE_DEFAULTS: Record<Lane, string> = {
  reason: "nvidia/nemotron-3.5-lightning-30b-a3b",
  fast: "nvidia/nemotron-3.5-bolt-e4b",
  vision: "meterless/vision",
  guard: "nvidia/nemotron-3.5-bolt-e4b",
  judge: "nvidia/nemotron-3-ultra-550b-a55b",
};

const blank = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LotlineConfig {
  return {
    sampleMode: /^(1|true|yes)$/i.test(env.SAMPLE_MODE ?? ""),
    zetaris: {
      baseUrl: blank(env.ZETARIS_BASE_URL) ?? "http://localhost:8888/api/v1.0",
      token: blank(env.ZETARIS_API_TOKEN),
      orgId: blank(env.ZETARIS_ORG_ID),
    },
    nightshift: {
      baseUrl: blank(env.NIGHTSHIFT_BASE_URL) ?? "http://127.0.0.1:8088/v1",
      token: blank(env.NIGHTSHIFT_TOKEN),
    },
    lanes: {
      reason: blank(env.LANE_REASON) ?? LANE_DEFAULTS.reason,
      fast: blank(env.LANE_FAST) ?? LANE_DEFAULTS.fast,
      vision: blank(env.LANE_VISION) ?? LANE_DEFAULTS.vision,
      guard: blank(env.LANE_GUARD) ?? LANE_DEFAULTS.guard,
      judge: blank(env.LANE_JUDGE) ?? LANE_DEFAULTS.judge,
    },
    contractSecret: blank(env.CONTRACT_SECRET) ?? "lotline-dev-secret",
    logsDir: blank(env.LOGS_DIR) ?? "logs",
  };
}
