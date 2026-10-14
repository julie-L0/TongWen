import React from 'react';
import type { JSONContent } from '@tiptap/core';
import { markdownManager } from '../workspace/markdown-codec';
import { textDifference } from './text-difference';
import { tableRowPreview } from './table-row-preview';

export function RevisionText({
  before,
  after,
  compact = false,
}: {
  before: string;
  after: string;
  compact?: boolean;
}) {
  const d = textDifference(before, after);
  const cut = (text: string) => (compact && text.length > 600 ? text.slice(0, 600) + '…' : text);
  return (
    <>
      {compact && d.prefix.length > 80 ? '…' + d.prefix.slice(-80) : d.prefix}
      {d.removed && (
        <del>
          <mark>{cut(d.removed)}</mark>
        </del>
      )}
      {d.inserted && (
        <ins>
          <mark>{cut(d.inserted)}</mark>
        </ins>
      )}
      {compact && d.suffix.length > 80 ? d.suffix.slice(0, 80) + '…' : d.suffix}
      {compact && (d.removed.length > 600 || d.inserted.length > 600) && (
        <small>（点击条目查看完整差异）</small>
      )}
    </>
  );
}

// Align identical siblings first so an inserted table row/list item does not shift every following row.
function align(before: JSONContent[], after: JSONContent[]) {
  const key = (n: JSONContent) => JSON.stringify(n);
  const a = before.map(key),
    b = after.map(key);
  const result: [JSONContent | undefined, JSONContent | undefined][] = [];
  if (a.length * b.length > 40000) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) result.push([before[i], after[i]]);
    return result;
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0,
    j = 0,
    fromA = 0,
    fromB = 0;
  const gap = (endA: number, endB: number) => {
    for (let k = 0; k < Math.max(endA - fromA, endB - fromB); k++)
      result.push([
        fromA + k < endA ? before[fromA + k] : undefined,
        fromB + k < endB ? after[fromB + k] : undefined,
      ]);
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      gap(i, j);
      result.push([before[i], after[j]]);
      fromA = ++i;
      fromB = ++j;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  gap(a.length, b.length);
  return result;
}
function nodes(before: JSONContent[], after: JSONContent[], path: string): React.ReactNode {
  return align(before, after).map(([a, b], i) => node(a, b, `${path}-${i}`));
}
function node(a: JSONContent | undefined, b: JSONContent | undefined, key: string): React.ReactNode {
  const n = b || a!;
  if (a && b && a.type !== b.type)
    return (
      <React.Fragment key={key}>
        {node(a, undefined, key + 'old')}
        {node(undefined, b, key + 'new')}
      </React.Fragment>
    );
  if (n.type === 'text') {
    let value: React.ReactNode = <RevisionText before={a?.text || ''} after={b?.text || ''} />;
    for (const mark of n.marks || []) {
      if (mark.type === 'bold') value = <strong>{value}</strong>;
      else if (mark.type === 'italic') value = <em>{value}</em>;
      else if (mark.type === 'code') value = <code>{value}</code>;
    }
    return <React.Fragment key={key}>{value}</React.Fragment>;
  }
  const content = nodes(a?.content || [], b?.content || [], key);
  const tags: Record<string, string> = {
    paragraph: 'p',
    bulletList: 'ul',
    orderedList: 'ol',
    listItem: 'li',
    blockquote: 'blockquote',
    tableRow: 'tr',
    tableCell: 'td',
    tableHeader: 'th',
  };
  if (n.type === 'table')
    return (
      <table key={key}>
        <tbody>{content}</tbody>
      </table>
    );
  if (n.type === 'heading')
    return React.createElement(`h${Math.min(3, Math.max(1, Number(n.attrs?.level || 2)))}`, { key }, content);
  if (n.type === 'codeBlock')
    return (
      <pre key={key}>
        <code>{content}</code>
      </pre>
    );
  if (n.type === 'hardBreak') return <br key={key} />;
  if (!tags[n.type!]) throw new Error(`暂不支持 ${n.type} 的结构化修订展示`);
  return React.createElement(
    tags[n.type!],
    { key, ...(n.type === 'orderedList' ? { start: n.attrs?.start || 1 } : {}) },
    content,
  );
}
export function RevisionPreview({ before, after }: { before: string; after: string }) {
  const row = tableRowPreview(before, after);
  if (row?.length) return <>{row.map((c, i) => <span className="revision-cell-preview" key={i}><small>{c.label}：</small><RevisionText before={c.before} after={c.after} compact /></span>)}</>;
  try {
    const old = markdownManager.parse(before).content?.[0], next = markdownManager.parse(after).content?.[0];
    if (old?.type === 'table' && next?.type === 'table') {
      const text = (n?: JSONContent): string => n?.text || (n?.content || []).map(text).join('');
      const headers = next.content?.[0].content || [];
      const changes: { label: string; before: string; after: string }[] = [];
      for (const [a, b] of align(old.content?.slice(1) || [], next.content?.slice(1) || [])) {
        for (let i = 0; i < Math.max(a?.content?.length || 0, b?.content?.length || 0); i++) {
          const before = text(a?.content?.[i]), after = text(b?.content?.[i]);
          if (before !== after) changes.push({ label: `${text(b?.content?.[0] || a?.content?.[0])} · ${text(headers[i])}`, before, after });
        }
      }
      if (changes.length) return <>{changes.slice(0, 6).map((c, i) => <span className="revision-cell-preview" key={i}><small>{c.label}：</small><RevisionText before={c.before} after={c.after} compact /></span>)}
        {changes.length > 6 && <small>另有 {changes.length - 6} 处表格差异，点击查看完整详情。</small>}</>;
    }
  } catch { /* Full detail retains unsupported-format feedback and original text. */ }
  return <RevisionText before={before} after={after} compact />;
}

export default function MarkdownRevision({ before, after }: { before: string; after: string }) {
  try {
    return (
      <div className="markdown-revision">
        {nodes(
          before ? markdownManager.parse(before).content || [] : [],
          after ? markdownManager.parse(after).content || [] : [],
          'revision',
        )}
      </div>
    );
  } catch (e) {
    return (
      <div className="markdown-revision">
        <p>此处无法结构化展示，以下保留完整原文差异：{e instanceof Error ? e.message : '格式不支持'}</p>
        <pre>
          <RevisionText before={before} after={after} />
        </pre>
      </div>
    );
  }
}
