// Keep punctuation, digits, negation, and qualifiers: they can change the answer set.
export function normalize(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}
