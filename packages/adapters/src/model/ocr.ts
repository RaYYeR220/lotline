import { createHash } from "node:crypto";

/** Cache key for a scanned page: the image bytes themselves. */
export const ocrKey = (png: Uint8Array) => `ocr:${createHash("sha256").update(png).digest("hex")}`;

interface Specialist {
  id: string;
  state: string;
  port: number | null;
  model_subdir?: string;
}

/**
 * Nightshift's document reader specialist (PaddleOCR, local, no egress). Found through the runtime's
 * specialist registry and started on demand; pages are posted to its loopback port.
 */
export class NightshiftOcr {
  private port: number | null = null;
  private model = "meterless/ocr";

  constructor(private readonly baseUrl: string, private readonly token: string | undefined, private readonly fetchImpl: typeof fetch = fetch) {}

  private async registry(): Promise<Specialist | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/meterless/specialists`, { headers: { authorization: `Bearer ${this.token ?? ""}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: Specialist[] };
    return body.data?.find((s) => s.id === "ocr");
  }

  /** Port of a running reader, starting it if it is installed but stopped. */
  async ready(): Promise<boolean> {
    if (this.port) return true;
    let spec = await this.registry().catch(() => undefined);
    if (!spec) return false;
    if (spec.model_subdir) this.model = `meterless/ocr:${spec.model_subdir.split("/").at(-1)}`;
    if (!spec.port || !/running|ready|serving/.test(spec.state)) {
      await this.fetchImpl(`${this.baseUrl}/meterless/specialists/ocr/start`, { method: "POST", headers: { authorization: `Bearer ${this.token ?? ""}` }, signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
      for (let i = 0; i < 20 && !(spec?.port && /running|ready|serving/.test(spec.state)); i++) {
        await new Promise((r) => setTimeout(r, 1500));
        spec = await this.registry().catch(() => undefined);
      }
    }
    this.port = spec?.port && /running|ready|serving/.test(spec.state) ? spec.port : null;
    return this.port != null;
  }

  async page(png: Uint8Array): Promise<{ text: string; lines: { text: string; confidence: number }[]; model: string } | null> {
    if (!(await this.ready())) return null;
    const res = await this.fetchImpl(`http://127.0.0.1:${this.port}/v1/ocr/page`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token ?? ""}` },
      body: JSON.stringify({ id: "bol", image_b64: Buffer.from(png).toString("base64"), min_confidence: 0.4 }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, any>;
    const raw: any[] = body.lines ?? body.regions ?? body.blocks ?? [];
    const lines = raw.map((l) => ({ text: String(l.text ?? l.value ?? ""), confidence: Number(l.confidence ?? l.score ?? 0) })).filter((l) => l.text);
    const text = String(body.text ?? lines.map((l) => l.text).join("\n"));
    return { text, lines, model: this.model };
  }
}
