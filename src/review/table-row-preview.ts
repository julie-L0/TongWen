// A single quoted Markdown row has no header. Show only changed cell values,
// using the real row object rather than inventing column names.
function cells(text: string) {
  const line = text.trim();
  if (!line.startsWith('|') || !line.endsWith('|') || line.includes('\n')) return null;
  const result: string[] = [];
  let cell = '', escaped = false;
  for (const c of line.slice(1, -1)) {
    if (escaped) { cell += c; escaped = false; }
    else if (c === '\\') escaped = true;
    else if (c === '|') { result.push(cell.trim()); cell = ''; }
    else cell += c;
  }
  result.push(cell.trim());
  return result.length > 1 && !result.every((c) => /^:?-+:?$/.test(c)) ? result : null;
}
export function tableRowPreview(before: string, after: string) {
  const a = cells(before), b = cells(after);
  if (!a || !b || a.length !== b.length) return null;
  return a.flatMap((value, i) => value === b[i] ? [] : [{ label: i ? (b[0] || a[0]) : '条目', before: value, after: b[i] }]);
}
