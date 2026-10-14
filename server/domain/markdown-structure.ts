import { marked } from 'marked';
export function tableStructure(text: string) {
  const rows = text.trim().split('\n');
  const cells = (line: string) => {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const result: string[] = [];
    let cell = '',
      escaped = false;
    for (const char of value) {
      if (char === '|' && !escaped) {
        result.push(cell.trim());
        cell = '';
      } else cell += char;
      escaped = char === '\\' && !escaped;
    }
    result.push(cell.trim());
    return result;
  };
  if (rows.length < 2) throw new Error('表格缺少表头与分隔行。');
  const headers = cells(rows[0]),
    align = cells(rows[1]);
  if (!headers.length || align.length !== headers.length || align.some((c) => !/^:?-{3,}:?$/.test(c)))
    throw new Error('表格分隔行或列数无效。');
  const body = rows.slice(2).map(cells);
  if (body.some((r) => r.length !== headers.length))
    throw new Error('表格某行列数与表头不一致；保存已阻止。');
  return {
    columns: headers.map((name, index) => ({
      index,
      name,
      alignment: align[index].startsWith(':')
        ? align[index].endsWith(':')
          ? 'center'
          : 'left'
        : align[index].endsWith(':')
          ? 'right'
          : null,
    })),
    rows: body.map((row, index) => ({
      index,
      object: row[0],
      cells: row.map((raw, columnIndex) => ({ columnIndex, columnName: headers[columnIndex], raw })),
    })),
  };
}
export function markdownTokens(text: string) {
  const tokens = marked.lexer(text, { gfm: true });
  marked.walkTokens(tokens, (t) => {
    if (['html', 'image', 'hr', 'def'].includes(t.type))
      throw new Error(`暂不支持 ${t.type} Markdown；请移除或转换后导入，原文件未改变。`);
    if (t.type === 'heading' && (t as any).depth > 3) throw new Error('暂支持一至三级标题。');
    if (t.type === 'list' && (t as any).items.some((i: any) => i.task))
      throw new Error('暂不支持任务复选列表。');
  });
  return tokens.filter((t) => t.type !== 'space');
}
// Structural source differences are retrieval hints, not semantic change judgments.
// Compare row cell values as multisets so duplicate rows and harmless pipe spacing stay honest.
export function changedTableRows(before?: string, after?: string) {
  const side = (text?: string) =>
    text
      ? tableStructure(text).rows.map((row, index) => ({
          key: JSON.stringify(row.cells.map((c) => c.raw)),
          text: text.trim().split('\n')[index + 2],
        }))
      : [];
  const old = side(before),
    next = side(after);
  function unmatched(rows: typeof old, other: typeof old) {
    const counts = new Map<string, number>();
    for (const r of other) counts.set(r.key, (counts.get(r.key) || 0) + 1);
    return rows
      .filter((r) => {
        const n = counts.get(r.key) || 0;
        if (n) {
          counts.set(r.key, n - 1);
          return false;
        }
        return true;
      })
      .map((r) => r.text);
  }
  const headerChanged =
    !!before &&
    !!after &&
    JSON.stringify(tableStructure(before).columns.map((c) => c.name)) !==
      JSON.stringify(tableStructure(after).columns.map((c) => c.name));
  return {
    before: [...(headerChanged ? [before!.trim().split('\n')[0]] : []), ...unmatched(old, next)],
    after: [...(headerChanged ? [after!.trim().split('\n')[0]] : []), ...unmatched(next, old)],
  };
}
