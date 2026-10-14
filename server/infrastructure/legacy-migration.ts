import fs from 'node:fs/promises';
import path from 'node:path';
import { uid } from '../domain/rules.ts';
import type { Block } from '../domain/types.ts';
import type { WorkspaceStore } from '../application/ports.ts';
export async function preserveLegacy(store: WorkspaceStore, runtime: string) {
  if (store.meta('legacyImport')) return;
  const file = path.join(runtime, 'workspace.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    store.setMeta('legacyImport', 'none');
    return;
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data.documents) || !Array.isArray(data.fragments))
    throw new Error('旧资料格式不完整，停止迁移，原文件未改动。');
  const backup = path.join(runtime, `workspace-legacy-${Date.now()}.json`);
  await fs.writeFile(backup, text, { flag: 'wx' });
  store.transaction(() => {
    const scope = store.ensureScope('旧原型资料 · 请配置属性');
    for (const d of data.documents) {
      const docId = store.insertDocument(
        d.title,
        d.type === 'pdf' ? 'pdf' : 'md',
        d.type === 'pdf' ? 'membership-guide.pdf' : null,
      );
      const blocks: Block[] = [{ id: uid(), kind: 'heading', level: 1, text: d.title }];
      for (const f of data.fragments.filter((f: any) => f.documentId === d.id)) {
        blocks.push({ id: uid(), kind: 'heading', level: 2, text: f.title });
        blocks.push({
          id: uid(),
          kind: 'paragraph',
          text: f.text,
          ...(f.locator?.kind === 'pdf' ? { locator: f.locator } : {}),
        });
        if (f.context) blocks.push({ id: uid(), kind: 'paragraph', text: `原资料上下文：${f.context}` });
      }
      const version = store.insertVersion(docId, blocks, '保留旧原型内容');
      store.setHead(docId, version.id);
      store.insertMember({
        scopeId: scope.id,
        documentId: docId,
        role: 'unconfigured',
        pinVersionId: null,
        baselineVersionId: version.id,
        compareDocumentId: null,
      });
    }
    store.setMeta('legacyImport', backup);
  });
}
