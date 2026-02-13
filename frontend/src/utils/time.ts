/**
 * Shared timestamp utilities for parsing and formatting timestamps
 * that may arrive from the backend without timezone information.
 */

/**
 * Normalizes a timestamp string to ensure it's treated as UTC.
 * Backend timestamps may lack timezone info - this appends "Z" when needed.
 */
export function parseAsUTC(timestamp: string): Date {
  let isoString = timestamp;
  if (
    !timestamp.endsWith("Z") &&
    !timestamp.includes("+") &&
    !/T\d{2}:\d{2}:\d{2}.*-/.test(timestamp)
  ) {
    isoString = timestamp + "Z";
  }
  return new Date(isoString);
}

/**
 * Formats a timestamp as "HH:MM" in the user's local timezone.
 * Returns empty string if the timestamp is invalid.
 */
export function formatTimeShort(timestamp: string): string {
  const date = parseAsUTC(timestamp);
  if (isNaN(date.getTime())) {
    return "";
  }
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Formats a Date or string timestamp as "HH:MM" using toLocaleTimeString.
 * Unlike formatTimeShort, this accepts Date objects and does not apply UTC normalization
 * (suitable for components where the caller controls the Date construction).
 */
export function formatTimeLocal(ts: Date | string): string {
  const date = typeof ts === "string" ? new Date(ts) : ts;
  if (isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Formats a timestamp as a full date+time string for transcripts/exports.
 * Uses en-US locale with 24-hour format.
 */
export function formatTimestampFull(timestamp: string): string {
  const date = parseAsUTC(timestamp);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
