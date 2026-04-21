/**
 * Heuristic for when the user's wording implies they need real repository
 * file content. Used to force a first-turn tool call so answers are not
 * fabricated from the map or parametric knowledge alone.
 */
export function userMessageWantsFileGrounding(message: string): boolean {
  const m = message.trim();
  if (m.length === 0) return false;
  if (/\bpackages\/[\w./-]+/i.test(m)) return true;
  if (/\bservices\/[\w./-]+\.(ts|tsx|js|jsx)\b/i.test(m)) return true;
  if (/\bread (the )?file\b/i.test(m)) return true;
  if (/\bline[- ]by[- ]line\b/i.test(m)) return true;
  if (/\bexact code\b/i.test(m)) return true;
  if (/\bshow (me )?the (exact )?code\b/i.test(m)) return true;
  if (/\bopen (the )?file\b/i.test(m)) return true;
  return false;
}
