/**
 * Incremental extraction of the Action Manager's `narration` tool argument. Its
 * input arrives as `input_json_delta` fragments that are only valid JSON once
 * the block completes, so streaming narration to the UI as the model writes it
 * means decoding the string value character by character as fragments land.
 */

/** Anything else after a backslash is passed through raw. */
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

// JSON insignificant whitespace, per RFC 8259.
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
  /** Unconsumed input: the pre-key prefix, or the tail of the string value. */
  private buffer = '';
  private inNarrative = false;
  /** Once the closing quote is seen, no further text is ever emitted. */
  private finished = false;
  private decoded = '';

  /** Returns the newly decoded delta, or `''` when nothing is unambiguous yet. */
  feed(partialJson: string): string {
    // Latch off, or JSON after the narrative value is emitted as narration.
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
      // The opening quote may not have arrived; retry on the next feed.
      if (afterColon.charAt(wsCount) !== '"') return '';

      this.inNarrative = true;
      // From here the buffer holds only a prefix of the raw string value.
      this.buffer = this.buffer.slice(
        keyIdx + NARRATIVE_KEY.length + colonIdx + 1 + wsCount + 1,
      );
    }

    return this.extractDelta();
  }

  get narrative(): string {
    return this.decoded;
  }

  get isComplete(): boolean {
    return this.finished;
  }

  /** Decode as much of the buffer as is unambiguously complete. */
  private extractDelta(): string {
    const buffer = this.buffer;
    let newText = '';
    let i = 0;
    // Cleared by any early exit that leaves an unconsumed tail behind.
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

      // A trailing backslash's meaning depends on bytes that have not arrived.
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
          // fromCharCode, not fromCodePoint: a surrogate pair arrives as two
          // \uXXXX escapes that re-form the astral character when appended.
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
