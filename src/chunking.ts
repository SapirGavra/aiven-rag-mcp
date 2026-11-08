// A first, lossless splitter: preserve original text and enforce a token budget.
export function splitText(
  text: string,
  countTokens: (text: string) => number,
  maxTokens = 200,
): string[] {
  if (!Number.isInteger(maxTokens) || maxTokens < 3 || maxTokens > 200) {
    throw new Error("The chunk token budget must be an integer between 3 and 200.");
  }
  if (!text.trim()) return [];
  return splitPart(text, countTokens, maxTokens);
}

function splitPart(
  text: string,
  countTokens: (text: string) => number,
  maxTokens: number,
): string[] {
  if (countTokens(text) <= maxTokens) return [text];

  // Array.from avoids splitting a Unicode character's surrogate pair.
  const characters = Array.from(text);
  if (characters.length < 2) {
    throw new Error("A single character exceeds the token budget.");
  }

  let splitAt = Math.floor(characters.length / 2);
  // Prefer a word boundary near the midpoint over cutting through a word.
  for (let i = splitAt; i >= Math.floor(splitAt / 2); i--) {
    if (i + 1 < characters.length && /\s/u.test(characters[i]!)) {
      splitAt = i + 1;
      break;
    }
  }

  const left = characters.slice(0, splitAt).join("");
  const right = characters.slice(splitAt).join("");
  return [
    ...splitPart(left, countTokens, maxTokens),
    ...splitPart(right, countTokens, maxTokens),
  ];
}
