/** Timestamp parsing and conversion. Accepts what actually shows up in logs:
 *  epoch seconds/millis/micros/nanos, ISO 8601, and RFC 2822. */

export interface TimestampView {
  iso: string;
  utc: string;
  local: string;
  localDate: string;
  epochSeconds: string;
  epochMillis: string;
  rfc2822: string;
  relative: string;
  timeZone: string;
  dayOfWeek: string;
  /** How the input was read, so an ambiguous epoch is not silently misread. */
  interpretation: string;
}

const SECOND = 1000;
const UNITS: Array<[string, number]> = [
  ["year", 365 * 24 * 60 * 60 * SECOND],
  ["month", 30 * 24 * 60 * 60 * SECOND],
  ["day", 24 * 60 * 60 * SECOND],
  ["hour", 60 * 60 * SECOND],
  ["minute", 60 * SECOND],
  ["second", SECOND],
];

export function relativeTo(date: Date, now: Date = new Date()): string {
  const delta = date.getTime() - now.getTime();
  const magnitude = Math.abs(delta);
  if (magnitude < SECOND) return "now";

  for (const [unit, size] of UNITS) {
    if (magnitude >= size) {
      const count = Math.round(magnitude / size);
      const plural = count === 1 ? unit : `${unit}s`;
      return delta < 0 ? `${count} ${plural} ago` : `in ${count} ${plural}`;
    }
  }
  return "now";
}

/** Returns the instant plus a description of how the input was interpreted. */
export function parseTimestamp(input: string): { date: Date; interpretation: string } {
  const text = input.trim();
  if (!text) throw new Error("enter a timestamp");

  if (/^-?\d+$/.test(text)) {
    // Disambiguate by magnitude, which is what every log viewer does.
    const digits = text.replace("-", "").length;
    const [scaleToMillis, unit] =
      digits <= 10 ? [SECOND, "epoch seconds"]
      : digits <= 13 ? [1, "epoch milliseconds"]
      : digits <= 16 ? [1e-3, "epoch microseconds"]
      : [1e-6, "epoch nanoseconds"];

    const date = new Date(Number(text) * scaleToMillis);
    if (Number.isNaN(date.getTime())) throw new Error(`out of range: ${input}`);
    return { date, interpretation: unit };
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`cannot parse "${input}" - try 1700000000, or 2024-01-31T12:00:00Z`);
  }
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  return {
    date: parsed,
    interpretation: hasZone ? "ISO 8601 with offset" : "date string, read as local time",
  };
}

export function describeTimestamp(date: Date, now: Date = new Date()): Omit<TimestampView, "interpretation"> {
  return {
    iso: date.toISOString(),
    utc: date.toUTCString(),
    local: date.toLocaleString(),
    localDate: date.toLocaleDateString(),
    epochSeconds: Math.floor(date.getTime() / SECOND).toString(),
    epochMillis: date.getTime().toString(),
    rfc2822: date.toUTCString().replace("GMT", "+0000"),
    relative: relativeTo(date, now),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayOfWeek: date.toLocaleDateString(undefined, { weekday: "long" }),
  };
}
