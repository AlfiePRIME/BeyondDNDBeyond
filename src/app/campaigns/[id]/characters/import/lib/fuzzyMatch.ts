export function normalizeForMatch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dist[i][0] = i;
  for (let j = 0; j < cols; j++) dist[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }
  return dist[rows - 1][cols - 1];
}

/**
 * How closely `candidate` matches `target`, both normalized to lowercase
 * letters-only first (OCR noise tends to be punctuation/case/spacing, not
 * letter substitution). 1 = exact, 0 = completely unrelated.
 */
export function similarity(candidate: string, target: string): number {
  const a = normalizeForMatch(candidate);
  const b = normalizeForMatch(target);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // A row's OCR'd "run" often carries trailing noise after the real value
  // — e.g. a save/skill name immediately followed by its ability
  // abbreviation and stray bleed-in text ("StealthDEXBreath" for
  // "Stealth"). Penalizing purely by edit distance would tank the score
  // for a long, otherwise-clean prefix match, so a clean prefix/suffix
  // containment is scored high regardless of how much extra text tags
  // along, rather than falling through to whole-string edit distance.
  if (a.startsWith(b) || b.startsWith(a)) return 0.95;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Best match for `raw` among `options`, or null if nothing clears
 * `threshold` — callers treat null as "couldn't confidently tell, leave it
 * for the player to pick."
 */
export function bestFuzzyMatch<T extends string>(
  raw: string,
  options: readonly T[],
  threshold = 0.6
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const option of options) {
    const score = similarity(raw, option);
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return bestScore >= threshold ? best : null;
}
