/**
 * Calendar helpers. The simulation counts whole days from `startDate`; these
 * turn a day index (plus minutes after midnight) into the strings partner
 * systems store. Everything is UTC so output never depends on the host clock.
 */

const MS_PER_DAY = 86_400_000;

function parse(iso: string): Date {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${iso}`);
  return d;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `YYYY-MM-DD` for day `day` counted from `start`. */
export function dayToIso(start: string, day: number): string {
  return new Date(parse(start).getTime() + day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD HH:MM:SS` — the timestamp format used in every `*_at` column. */
export function stamp(start: string, day: number, minutes: number): string {
  const extraDays = Math.floor(minutes / 1440);
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${dayToIso(start, day + extraDays)} ${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`;
}

/** Day of the year, 1-based. */
export function dayOfYear(iso: string): number {
  const d = parse(iso);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.round((d.getTime() - jan1) / MS_PER_DAY) + 1;
}

/** Julian-style `yyddd` (two-digit year + day of year), as printed on grower cartons. */
export function yyddd(iso: string): string {
  return iso.slice(2, 4) + pad(dayOfYear(iso), 3);
}

/** `yyMMdd`. */
export function yymmdd(iso: string): string {
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
}

/** Day of week, 0 = Sunday. */
export function weekday(iso: string): number {
  return parse(iso).getUTCDay();
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "September 4, 2026" — used in notice prose. */
export function longDate(iso: string): string {
  const d = parse(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
