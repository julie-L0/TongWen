export function textDifference(before: string, after: string) {
  if (before === after) return { prefix: before, removed: '', inserted: '', suffix: '' };
  if (/^\d+$/.test(before) && /^\d+$/.test(after) && before !== after)
    return { prefix: '', removed: before, inserted: after, suffix: '' };
  const a = [...before],
    b = [...after];
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end])
    end++;
  while (start > 0 && /\d/.test(a[start - 1]) && /\d/.test(b[start - 1])) start--;
  while (end > 0 && /\d/.test(a[a.length - end]) && /\d/.test(b[b.length - end])) end--;
  return {
    prefix: a.slice(0, start).join(''),
    removed: a.slice(start, a.length - end).join(''),
    inserted: b.slice(start, b.length - end).join(''),
    suffix: end ? a.slice(a.length - end).join('') : '',
  };
}
