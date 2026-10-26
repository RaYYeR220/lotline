import { existsSync } from "node:fs";
import { Resvg, renderAsync, type ResvgRenderOptions } from "@resvg/resvg-js";
import type { Rng } from "./rng.ts";

/**
 * Printed bill-of-lading forms, drawn as SVG and rasterised to PNG so the
 * vision lane has a realistic "scan" to read: typed fields, a lot table, a
 * signature and the consignee's receiving stamp, slightly skewed with a little
 * scanner noise.
 */
export interface BolDoc {
  bolNo: string;
  carrierName: string;
  scac: string;
  shipDate: string;
  trailer: string;
  seal: string;
  shipper: { name: string; address: string };
  consignee: { name: string; address: string };
  lot: string;
  description: string;
  cases: number;
  weightLb: number;
  stamp: { label: "RECEIVED" | "DELIVERED"; date: string; cases: number; note: string | null; by: string } | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MONO = "'Courier New', Courier, 'DejaVu Sans Mono', 'Liberation Mono', monospace";
const SANS = "Arial, Helvetica, 'DejaVu Sans', 'Liberation Sans', sans-serif";

export function renderBolSvg(doc: BolDoc, rng: Rng): string {
  const W = 900;
  const H = 640;
  const tilt = (rng.next() - 0.5) * 1.4;
  const specks = Array.from({ length: 26 }, () =>
    `<circle cx="${rng.int(10, W - 10)}" cy="${rng.int(10, H - 10)}" r="${(0.4 + rng.next() * 1.3).toFixed(1)}" fill="#555" opacity="${(0.15 + rng.next() * 0.35).toFixed(2)}"/>`,
  ).join("");
  const text = (x: number, y: number, s: string, size = 15, font = MONO, extra = "", fill = "#1b1b1b") =>
    `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
  const label = (x: number, y: number, s: string) => text(x, y, s, 11, SANS, `fill-opacity="0.7" letter-spacing="0.5"`);
  const box = (x: number, y: number, w: number, h: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#2a2a2a" stroke-width="1.2"/>`;

  const parts: string[] = [];
  parts.push(text(40, 58, doc.carrierName.toUpperCase(), 24, SANS, `font-weight="bold"`));
  parts.push(text(40, 80, `SCAC ${doc.scac}   STRAIGHT BILL OF LADING - SHORT FORM - NOT NEGOTIABLE`, 12, SANS));
  parts.push(box(620, 30, 240, 60), label(630, 48, "B/L NUMBER"), text(630, 76, doc.bolNo, 22, MONO, `font-weight="bold"`));

  parts.push(box(40, 105, 260, 50), label(50, 122, "SHIP DATE"), text(50, 145, doc.shipDate));
  parts.push(box(300, 105, 280, 50), label(310, 122, "TRAILER NO."), text(310, 145, doc.trailer));
  parts.push(box(580, 105, 280, 50), label(590, 122, "SEAL NO."), text(590, 145, doc.seal));

  parts.push(box(40, 165, 410, 90), label(50, 183, "SHIPPER (FROM)"), text(50, 210, doc.shipper.name), text(50, 235, doc.shipper.address, 13));
  parts.push(box(450, 165, 410, 90), label(460, 183, "CONSIGNEE (TO)"), text(460, 210, doc.consignee.name), text(460, 235, doc.consignee.address, 13));

  // Line table: one lot per bill.
  parts.push(box(40, 270, 820, 110));
  parts.push(`<line x1="40" y1="298" x2="860" y2="298" stroke="#2a2a2a" stroke-width="1"/>`);
  for (const x of [250, 640, 740]) parts.push(`<line x1="${x}" y1="270" x2="${x}" y2="380" stroke="#2a2a2a" stroke-width="1"/>`);
  parts.push(label(50, 289, "LOT NO."), label(260, 289, "DESCRIPTION OF ARTICLES"), label(650, 289, "CASES"), label(750, 289, "WEIGHT (LB)"));
  parts.push(text(50, 326, doc.lot, 17, MONO, `font-weight="bold"`), text(260, 326, doc.description, 13), text(650, 326, String(doc.cases), 17), text(750, 326, String(doc.weightLb), 15));
  parts.push(text(260, 360, "KEEP REFRIGERATED 33-38F", 12, SANS, `fill-opacity="0.75"`));

  parts.push(text(40, 410, "Received, subject to the classifications and tariffs in effect on the date of issue of this Bill of Lading.", 10, SANS, `fill-opacity="0.7"`));
  parts.push(label(40, 450, "SHIPPER SIGNATURE"), `<line x1="40" y1="480" x2="330" y2="480" stroke="#2a2a2a"/>`);
  parts.push(`<path d="M55 472 c 12 -22, 22 8, 34 -6 s 16 -12, 26 4 s 18 2, 30 -10" fill="none" stroke="#24316b" stroke-width="1.6"/>`);
  parts.push(label(380, 450, "CARRIER SIGNATURE / PICKUP DATE"), `<line x1="380" y1="480" x2="650" y2="480" stroke="#2a2a2a"/>`);
  parts.push(`<path d="M395 474 c 8 -18, 18 10, 28 -4 s 12 -8, 22 2" fill="none" stroke="#24316b" stroke-width="1.6"/>`);
  parts.push(text(560, 474, doc.shipDate, 13, MONO, "", "#24316b"));

  if (doc.stamp) {
    const s = doc.stamp;
    const cx = 700;
    const cy = 540;
    const rot = -8 - rng.next() * 8;
    parts.push(
      `<g transform="rotate(${rot.toFixed(1)} ${cx} ${cy})" opacity="0.82">` +
        `<rect x="${cx - 140}" y="${cy - 62}" width="280" height="124" rx="10" fill="none" stroke="#b3202a" stroke-width="3.5"/>` +
        `<text x="${cx}" y="${cy - 26}" text-anchor="middle" font-family="${SANS}" font-size="28" font-weight="bold" fill="#b3202a" letter-spacing="3">${s.label}</text>` +
        `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="${MONO}" font-size="18" font-weight="bold" fill="#b3202a">${esc(s.date)}</text>` +
        `<text x="${cx}" y="${cy + 28}" text-anchor="middle" font-family="${MONO}" font-size="15" fill="#b3202a">${esc(`CASES: ${s.cases}${s.note ? `  ${s.note}` : ""}`)}</text>` +
        `<text x="${cx}" y="${cy + 50}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="#b3202a">${esc(s.by)}</text>` +
        `</g>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#f7f5ee"/>` +
    `<g transform="rotate(${tilt.toFixed(2)} ${W / 2} ${H / 2})">${parts.join("")}</g>` +
    specks +
    `</svg>`
  );
}

/** Sans and mono faces the form uses, in the places Windows, macOS and common Linux images keep them. */
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/cour.ttf", "C:/Windows/Fonts/courbd.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Courier New.ttf", "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
];

let fontFiles: string[] | null = null;

/**
 * Rasterise a BOL SVG to PNG. Loading every system font on each call is slow,
 * so known font files are passed directly; with none found it falls back to
 * the system font scan.
 */
export function renderBolPng(svg: string): Buffer {
  return new Resvg(svg, renderOptions()).render().asPng();
}

/** Same as `renderBolPng`, rendered on resvg's worker threads. */
export async function renderBolPngAsync(svg: string): Promise<Buffer> {
  return (await renderAsync(svg, renderOptions())).asPng();
}

function renderOptions(): ResvgRenderOptions {
  fontFiles ??= FONT_CANDIDATES.filter((f) => existsSync(f));
  return {
    background: "#f7f5ee",
    fitTo: { mode: "width", value: 900 },
    font: fontFiles.length
      ? { loadSystemFonts: false, fontFiles, defaultFontFamily: fontFiles.some((f) => /arial/i.test(f)) ? "Arial" : "DejaVu Sans" }
      : { loadSystemFonts: true, defaultFontFamily: "Arial" },
  };
}
