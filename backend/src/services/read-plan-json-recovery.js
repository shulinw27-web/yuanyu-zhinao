// Observed model failure: a redundant ] after an expression array. Recovery is
// deliberately narrower than JSON repair: no text/values/quotes/commas changed,
// no missing token inserted, no braces removed, no trailing root text accepted.
export function recoverReadPlanJson(source) {
  if (typeof source !== 'string' || source.length > 48000) return null;
  const stack = []; let inString = false; let escaped = false; let removed = 0; let result = '';
  for (const char of source) {
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') { if (stack.length >= 128) return null; stack.push(char); }
    else if (char === ']') {
      if (stack.at(-1) === '[') stack.pop();
      else if (stack.at(-1) === '{' && ++removed <= 8) continue;
      else return null;
    } else if (char === '}') { if (stack.pop() !== '{') return null; }
    result += char;
  }
  if (!removed || inString || stack.length) return null;
  try { return { parsed: JSON.parse(result), removedClosingBrackets: removed }; } catch { return null; }
}
