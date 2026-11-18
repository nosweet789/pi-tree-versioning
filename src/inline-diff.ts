import { diffArrays } from "diff";

export interface InlineSpan {
  text: string;
  changed: boolean;
}

interface InlineChange {
  removed: InlineSpan[];
  added: InlineSpan[];
}

interface NumericValue {
  edited?: boolean;
  replaced?: boolean;
}

interface Grapheme {
  text: string;
  number?: NumericValue;
  edited?: boolean;
}

interface Anchor {
  text: string;
  start: number;
  end: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Match fields and standalone signed numeric literals, not digits inside identifiers.
const inlineToken = /(?<field>[\p{ID_Start}$][\p{ID_Continue}$]*(?=[ \t]*(?:=(?!=)|:)))|(?<number>(?<![\p{ID_Continue}$.])[+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\p{Nd}+(?:\.\p{Nd}*)?|\.\p{Nd}+)(?:[eE][+-]?\p{Nd}+)?)(?![\p{ID_Continue}$]))|[\p{ID_Continue}$]+/uy;
const inlineCodeUnitLimit = 8192;
const inlineEditLimit = 2048;
const pairWorkMs = 12;
const viewWorkMs = 40;
const viewCodeUnitLimit = 64 * 1024;

function tokenize(text: string) {
  const segments = Array.from(segmenter.segment(text));
  const fields: Anchor[] = [], structure: Anchor[] = [];
  const glyphs: Grapheme[] = [];
  for (let start = 0; start < segments.length;) {
    const offset = segments[start].index;
    inlineToken.lastIndex = offset;
    const match = inlineToken.exec(text);
    let end = start + 1;
    while (end < segments.length && segments[end].index < inlineToken.lastIndex) end++;
    const token = text.slice(offset, segments[end]?.index ?? text.length);
    const wholeToken = match?.[0] === token;
    const number: NumericValue | undefined = wholeToken && match.groups?.number ? {} : undefined;
    if (wholeToken && match.groups?.field) {
      const field = { text: token, start, end };
      fields.push(field);
      structure.push(field);
    } else if (/^[=,:;()[\]{}]$/.test(token)) {
      structure.push({ text: token, start, end });
    }
    for (let index = start; index < end; index++) glyphs.push({ text: segments[index].segment, number });
    start = end;
  }
  return { glyphs, fields, structure };
}

function spans(glyphs: Grapheme[]): InlineSpan[] {
  const result: InlineSpan[] = [];
  for (const glyph of glyphs) {
    const changed = !!(glyph.edited || glyph.number?.replaced);
    const last = result.at(-1);
    if (last && last.changed === changed) last.text += glyph.text;
    else result.push({ text: glyph.text, changed });
  }
  return result;
}

function diffTokens<T extends { text: string }>(old: T[], next: T[], deadline: number) {
  const timeout = deadline - performance.now();
  if (timeout <= 0) return undefined;
  return diffArrays(old, next, { comparator: (a, b) => a.text === b.text, maxEditLength: inlineEditLimit, timeout });
}

function markGap(old: Grapheme[], next: Grapheme[], deadline: number) {
  if (!old.length && !next.length) return true;
  const diff = diffTokens(old, next, deadline);
  if (!diff) return false;

  const alignedNumbers: [NumericValue, NumericValue][] = [];
  let oldIndex = 0, nextIndex = 0;
  for (const part of diff) {
    for (let i = 0; i < part.value.length; i++) {
      if (part.removed || part.added) {
        const glyph = part.removed ? old[oldIndex++] : next[nextIndex++];
        glyph.edited = true;
        if (glyph.number) glyph.number.edited = true;
      } else {
        const left = old[oldIndex++].number, right = next[nextIndex++].number;
        const previous = alignedNumbers.at(-1);
        if (left && right && (previous?.[0] !== left || previous[1] !== right)) alignedNumbers.push([left, right]);
      }
    }
  }
  // Extend emphasis over a number only if both aligned values changed.
  // A digit added to or removed from an otherwise unchanged value stays one-sided.
  for (const [left, right] of alignedNumbers) {
    if (left.edited && right.edited) left.replaced = right.replaced = true;
  }
  return true;
}

function isSubsequence(shorter: Grapheme[], longer: Grapheme[]) {
  if (shorter.length >= longer.length) return false;
  let matched = 0;
  for (const glyph of longer) {
    if (glyph.text === shorter[matched]?.text) matched++;
  }
  return matched === shorter.length;
}

function markEdits(old: ReturnType<typeof tokenize>, next: ReturnType<typeof tokenize>, deadline: number) {
  // A one-sided edit can change word boundaries (e.g. splitting "foo" with a
  // space). Do not let the coarser anchors turn it into a replacement.
  if (isSubsequence(old.glyphs, next.glyphs) || isSubsequence(next.glyphs, old.glyphs)) {
    return markGap(old.glyphs, next.glyphs, deadline);
  }
  // Identical delimiters can anchor lists and expressions. If the structure
  // changed, keep only field names as anchors; value text must not outrank keys.
  const sameStructure = old.structure.length === next.structure.length &&
    old.structure.every((anchor, index) => anchor.text === next.structure[index].text);
  const oldAnchors = sameStructure ? old.structure : old.fields;
  const nextAnchors = sameStructure ? next.structure : next.fields;
  const alignment = diffTokens(oldAnchors, nextAnchors, deadline);
  if (!alignment) return false;

  let oldAnchor = 0, nextAnchor = 0, oldStart = 0, nextStart = 0;
  for (const part of alignment) {
    if (part.removed) oldAnchor += part.count;
    else if (part.added) nextAnchor += part.count;
    else for (let index = 0; index < part.count; index++) {
      const left = oldAnchors[oldAnchor++], right = nextAnchors[nextAnchor++];
      if ((oldStart < left.start || nextStart < right.start) &&
          !markGap(old.glyphs.slice(oldStart, left.start), next.glyphs.slice(nextStart, right.start), deadline)) return false;
      oldStart = left.end;
      nextStart = right.end;
    }
  }
  return markGap(old.glyphs.slice(oldStart), next.glyphs.slice(nextStart), deadline);
}

function inlineDiff(before: string, after: string, deadline: number): InlineChange | undefined {
  const old = tokenize(before), next = tokenize(after);
  if (!markEdits(old, next, deadline)) return undefined;
  return { removed: spans(old.glyphs), added: spans(next.glyphs) };
}

export function createInlineDiffer() {
  const cache = new Map<string, InlineChange | undefined>();
  let remainingText = viewCodeUnitLimit;
  let remainingMs = viewWorkMs;
  return (before: string, after: string): InlineChange | undefined => {
    if (before.length > inlineCodeUnitLimit || after.length > inlineCodeUnitLimit) return undefined;
    // Patch lines never contain a newline. Reuse even failed attempts across redraws.
    const key = before + "\n" + after;
    if (cache.has(key)) return cache.get(key);
    const size = before.length + after.length;
    if (remainingMs <= 0 || remainingText <= 0) return undefined;
    if (size > remainingText) {
      remainingText = 0;
      return undefined;
    }
    remainingText -= size;
    const start = performance.now();
    const change = inlineDiff(before, after, start + Math.min(pairWorkMs, remainingMs));
    remainingMs -= performance.now() - start;
    cache.set(key, change);
    return change;
  };
}
