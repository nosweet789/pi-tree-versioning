import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

interface StyledCharacter {
  text: string;
  foreground?: string;
  bold: boolean;
  underline: boolean;
}

export function styledCharacters(line: string): StyledCharacter[] {
  const characters: StyledCharacter[] = [];
  let foreground: string | undefined;
  let bold = false, underline = false;
  for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
    if (!/^\x1b\[[\d;]*m$/.test(part)) {
      for (const text of stripVTControlCharacters(part)) characters.push({ text, foreground, bold, underline });
      continue;
    }
    const codes = part.slice(2, -1).split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index];
      if (code === 0) { foreground = undefined; bold = underline = false; }
      else if (code === 1 || code === 22) bold = code === 1;
      else if (code === 4 || code === 24) underline = code === 4;
      else if (code === 39) foreground = undefined;
      else if (code >= 30 && code <= 37) foreground = `index:${code - 30}`;
      else if (code >= 90 && code <= 97) foreground = `index:${code - 90 + 8}`;
      else if (code === 38 || code === 48 || code === 58) {
        if (codes[index + 1] === 2) {
          if (code === 38) foreground = `rgb:${codes.slice(index + 2, index + 5).join(",")}`;
          index += 4;
        } else if (codes[index + 1] === 5) {
          if (code === 38) foreground = `index:${codes[index + 2]}`;
          index += 2;
        }
      }
    }
  }
  return characters;
}

export function assertStyledCharacters(actual: StyledCharacter[], theme: Theme, color: ThemeColor, ...spans: (string | [string])[]) {
  const foreground = styledCharacters(theme.fg(color, "x"))[0].foreground;
  const expected = spans.flatMap(span => {
    const changed = typeof span !== "string";
    return Array.from(changed ? span[0] : span, text => ({ text, foreground, bold: changed, underline: changed }));
  });
  assert.deepEqual(actual, expected, `Unexpected text or styles: ${JSON.stringify(expected.map(({ text }) => text).join(""))}`);
}
