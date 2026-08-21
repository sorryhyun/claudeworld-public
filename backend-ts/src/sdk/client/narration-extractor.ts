/**
 * Incremental extraction of the Action Manager's `narration` tool argument.
 *
 * Port of `NarrationStreamExtractor` in `backend/sdk/client/stream_parser.py`.
 *
 * The narration tool takes `{"narrative": "..."}`. Its input arrives as a
 * sequence of `input_json_delta` fragments that are only valid JSON once the
 * block completes, so `JSON.parse` cannot be used: to stream narration to the
 * UI while the model is still writing it, the string value has to be decoded
 * character by character as the fragments land.
 */

/** JSON single-character escapes; anything else after a backslash is passed through raw. */
const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  '"': '"',
  '\\': '\\',
  '/': '/',
  r: '\r',
  b: '\b',
  f: '\f',
};

const NARRATIVE_KEY = '"narrative"';

/** JSON insignificant whitespace, per RFC 8259. */
function countLeadingWhitespace(text: string): number {
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') break;
    i += 1;
  }
  return i;
}

export class NarrationStreamExtractor {
  /** Unconsumed input: the pre-key prefix, or (once inside) the tail of the string value. */
  private buffer = '';
  /** True once the opening quote of the narrative value has been located and consumed. */
  private inNarrative = false;
  /** True once the closing quote has been seen; no further text is ever emitted. */
  private finished = false;
  /** Everything decoded and returned so far. */
  private decoded = '';

  /**
   * Feed one partial-JSON fragment.
   *
   * @returns The newly decoded narrative text (a delta), or `''` if this
   * fragment produced nothing yet — the key was still incomplete, or the
   * fragment ended mid-escape.
   */
  feed(partialJson: string): string {
    // Deviation from the Python original, which keeps decoding after the
    // closing quote and would emit the JSON that follows the narrative value as
    // if it were narration. Harmless there only because the tool schema has a
    // single field; latching off is the behavior the name promises.
    if (this.finished) return '';

    this.buffer += partialJson;

    if (!this.inNarrative) {
      const keyIdx = this.buffer.indexOf(NARRATIVE_KEY);
      if (keyIdx === -1) return '';

      const rest = this.buffer.slice(keyIdx + NARRATIVE_KEY.length);
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) return '';

      const afterColon = rest.slice(colonIdx + 1);
      const wsCount = countLeadingWhitespace(afterColon);
      // The opening quote may not have arrived yet (or the value may not be a
      // string at all). Leave the buffer untouched and retry on the next feed.
      if (afterColon.charAt(wsCount) !== '"') return '';

      this.inNarrative = true;
      // Drop everything through the opening quote; from here the buffer holds
      // only (a prefix of) the raw string value.
      this.buffer = this.buffer.slice(
        keyIdx + NARRATIVE_KEY.length + colonIdx + 1 + wsCount + 1,
      );
    }

    return this.extractDelta();
  }

  /** The full narrative decoded so far. */
  get narrative(): string {
    return this.decoded;
  }

  /** True once the closing quote of the narrative value has been consumed. */
  get isComplete(): boolean {
    return this.finished;
  }

  /** Decode as much of the buffered string value as is unambiguously complete. */
  private extractDelta(): string {
    const buffer = this.buffer;
    let newText = '';
    let i = 0;
    // Set false by any early exit that leaves an unconsumed tail behind.
    let consumedAll = true;

    while (i < buffer.length) {
      const ch = buffer.charAt(i);

      if (ch === '"') {
        // Unescaped closing quote: the value is complete.
        this.buffer = buffer.slice(i + 1);
        consumedAll = false;
        this.finished = true;
        break;
      }

      if (ch !== '\\') {
        newText += ch;
        i += 1;
        continue;
      }

      // A backslash at the very end of the buffer is an escape whose meaning
      // depends on bytes that have not arrived. Defer it: keep it buffered and
      // decode it on the next feed rather than emitting a stray backslash.
      if (i + 1 >= buffer.length) {
        this.buffer = buffer.slice(i);
        consumedAll = false;
        break;
      }

      const esc = buffer.charAt(i + 1);

      if (esc === 'u') {
        // Needs four hex digits after `\u`; the chunk may have split them.
        if (i + 5 >= buffer.length) {
          this.buffer = buffer.slice(i);
          consumedAll = false;
          break;
        }
        const hex = buffer.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          // fromCharCode, not fromCodePoint: a JSON surrogate pair arrives as
          // two separate \uXXXX escapes, and appending the two UTF-16 code
          // units back to back re-forms the astral character for free.
          newText += String.fromCharCode(parseInt(hex, 16));
        } else {
          // Malformed escape: pass it through verbatim rather than dropping it.
          newText += `\\u${hex}`;
        }
        i += 6;
        continue;
      }

      newText += SIMPLE_ESCAPES[esc] ?? esc;
      i += 2;
    }

    if (consumedAll) this.buffer = '';

    this.decoded += newText;
    return newText;
  }
}
