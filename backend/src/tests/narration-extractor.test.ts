import { describe, expect, test } from 'bun:test';

import { NarrationStreamExtractor } from '@/sdk/client/narration-extractor';

/** Feed every chunk and return the concatenation of the emitted deltas. */
function feedAll(chunks: readonly string[]): { text: string; deltas: string[] } {
  const extractor = new NarrationStreamExtractor();
  const deltas = chunks.map((chunk) => extractor.feed(chunk));
  return { text: deltas.join(''), deltas };
}

/** Split a string into chunks of at most `size` characters. */
function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe('NarrationStreamExtractor / key discovery', () => {
  test('emits nothing until the key, colon and opening quote have all arrived', () => {
    const extractor = new NarrationStreamExtractor();

    expect(extractor.feed('{')).toBe('');
    expect(extractor.feed('"narra')).toBe('');
    expect(extractor.feed('tive"')).toBe('');
    expect(extractor.feed(':')).toBe('');
    expect(extractor.feed(' ')).toBe('');
    expect(extractor.feed('"Ah')).toBe('Ah');
  });

  test('tolerates whitespace between the key, colon and value', () => {
    expect(feedAll(['{"narrative"\n\t :   "spaced"}']).text).toBe('spaced');
  });

  test('handles the whole tool input arriving in one chunk', () => {
    expect(feedAll(['{"narrative": "The door creaks open."}']).text).toBe('The door creaks open.');
  });

  test('ignores keys that precede narrative', () => {
    expect(feedAll(['{"other": "junk", "narrative": "real"}']).text).toBe('real');
  });

  test('emits nothing when narrative never appears', () => {
    expect(feedAll(['{"options": ["a", "b"]}']).text).toBe('');
  });

  test('emits nothing while the value is not a string', () => {
    const extractor = new NarrationStreamExtractor();
    expect(extractor.feed('{"narrative": null}')).toBe('');
    expect(extractor.isComplete).toBe(false);
  });

  test('streams character by character across single-character chunks', () => {
    const json = '{"narrative": "Hi there"}';
    expect(feedAll(chunked(json, 1)).text).toBe('Hi there');
  });
});

describe('NarrationStreamExtractor / escape decoding', () => {
  test('decodes every simple escape', () => {
    const json = String.raw`{"narrative": "a\nb\tc\"d\\e\/f\rg\bh\fi"}`;
    expect(feedAll([json]).text).toBe('a\nb\tc"d\\e/f\rg\bh\fi');
  });

  test('matches JSON.parse on a fully-buffered payload', () => {
    const value = 'Line one.\n"Quoted," she said.\tTab\\slash / and é.';
    const json = JSON.stringify({ narrative: value });

    expect(feedAll([json]).text).toBe(value);
    expect(feedAll(chunked(json, 3)).text).toBe(value);
  });

  test('passes through an unknown escape by dropping the backslash', () => {
    // Matches the Python original's fallback branch.
    expect(feedAll([String.raw`{"narrative": "a\qb"}`]).text).toBe('aqb');
  });

  test('passes a malformed \\u escape through verbatim', () => {
    expect(feedAll([String.raw`{"narrative": "x\u12g4y"}`]).text).toBe('x\\u12g4y');
  });

  test('decodes \\uXXXX escapes', () => {
    expect(feedAll([String.raw`{"narrative": "caf\u00e9 \uc548\ub155"}`]).text).toBe('café 안녕');
  });

  test('recombines a surrogate pair written as two \\u escapes', () => {
    // Each escape decodes to one UTF-16 code unit; concatenating them re-forms
    // the astral character.
    expect(feedAll([String.raw`{"narrative": "\ud83d\ude00"}`]).text).toBe('😀');
  });

  test('leaves literal non-ASCII characters untouched', () => {
    expect(feedAll(['{"narrative": "café 안녕 😀"}']).text).toBe('café 안녕 😀');
  });
});

describe('NarrationStreamExtractor / chunk boundaries', () => {
  test('defers a trailing lone backslash to the next feed', () => {
    const extractor = new NarrationStreamExtractor();

    expect(extractor.feed('{"narrative": "line\\')).toBe('line');
    expect(extractor.feed('nbreak')).toBe('\nbreak');
  });

  test('defers an escaped quote split across the backslash boundary', () => {
    const extractor = new NarrationStreamExtractor();

    // The `\` must not be emitted, and the `"` must not be read as the closing quote.
    expect(extractor.feed('{"narrative": "she said \\')).toBe('she said ');
    expect(extractor.feed('"hi\\" back')).toBe('"hi" back');
    expect(extractor.isComplete).toBe(false);
    expect(extractor.feed('"}')).toBe('');
    expect(extractor.isComplete).toBe(true);
    expect(extractor.narrative).toBe('she said "hi" back');
  });

  test('defers an escaped backslash split across the boundary', () => {
    const extractor = new NarrationStreamExtractor();

    expect(extractor.feed('{"narrative": "a\\')).toBe('a');
    expect(extractor.feed('\\b')).toBe('\\b');
  });

  test('defers a \\uXXXX escape split across three chunks', () => {
    const extractor = new NarrationStreamExtractor();

    expect(extractor.feed('{"narrative": "caf\\u00')).toBe('caf');
    expect(extractor.feed('e')).toBe('');
    expect(extractor.feed('9!')).toBe('é!');
    expect(extractor.narrative).toBe('café!');
  });

  test('defers a \\u escape split at every possible offset', () => {
    const json = String.raw`{"narrative": "x\u00e9y"}`;
    for (let split = 1; split < json.length; split += 1) {
      const chunks = [json.slice(0, split), json.slice(split)];
      expect(feedAll(chunks).text).toBe('xéy');
    }
  });

  test('every split point of a payload full of escapes yields the same text', () => {
    const value = 'A "quote", a \\ slash,\na newline, é and 😀.';
    const json = JSON.stringify({ narrative: value, trailing: 'ignored' });

    for (let split = 1; split < json.length; split += 1) {
      expect(feedAll([json.slice(0, split), json.slice(split)]).text).toBe(value);
    }
  });
});

describe('NarrationStreamExtractor / closing quote', () => {
  test('stops at the unescaped closing quote', () => {
    const { text } = feedAll(['{"narrative": "done."', ', "options": ["a"]}']);

    expect(text).toBe('done.');
  });

  test('emits nothing more once complete, even across later feeds', () => {
    const extractor = new NarrationStreamExtractor();

    expect(extractor.feed('{"narrative": "end"')).toBe('end');
    expect(extractor.isComplete).toBe(true);
    expect(extractor.feed(', "narrative": "second"}')).toBe('');
    expect(extractor.narrative).toBe('end');
  });

  test('an embedded escaped quote does not terminate the value', () => {
    expect(feedAll([String.raw`{"narrative": "say \"hello\" now", "x": 1}`]).text).toBe('say "hello" now');
  });

  test('an empty narrative completes immediately with no text', () => {
    const extractor = new NarrationStreamExtractor();

    expect(extractor.feed('{"narrative": ""}')).toBe('');
    expect(extractor.isComplete).toBe(true);
    expect(extractor.narrative).toBe('');
  });
});

describe('NarrationStreamExtractor / accumulated state', () => {
  test('narrative accumulates exactly the concatenated deltas', () => {
    const json = JSON.stringify({
      narrative: 'The lantern gutters.\nSomething moves in the dark — "who\'s there?"',
    });
    const extractor = new NarrationStreamExtractor();
    let joined = '';

    for (const chunk of chunked(json, 7)) joined += extractor.feed(chunk);

    expect(extractor.narrative).toBe(joined);
    expect(joined).toBe(JSON.parse(json).narrative);
    expect(extractor.isComplete).toBe(true);
  });

  test('a fresh extractor starts empty', () => {
    const extractor = new NarrationStreamExtractor();

    expect(extractor.narrative).toBe('');
    expect(extractor.isComplete).toBe(false);
    expect(extractor.feed('')).toBe('');
  });
});
