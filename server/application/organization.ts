import type { WorkspaceStore } from './ports.ts';
import { fail, uid } from '../domain/rules.ts';
import type { Folder, Presentation } from '../domain/types.ts';
export class Organization {
  private store: WorkspaceStore;
  constructor(store: WorkspaceStore) {
    this.store = store;
  }
  private check(revision: number) {
    if (revision !== Number(this.store.meta('layoutRevision') || 0))
      fail('LAYOUT_STALE', '文件树已变化，请刷新后再操作。', 409);
  }
  private name(name: unknown) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 40)
      fail('INVALID_NAME', '名称应为 1–40 个字符。');
    return (name as string).trim();
  }
  private bump() {
    this.store.setMeta('layoutRevision', String(Number(this.store.meta('layoutRevision') || 0) + 1));
  }
  folder(input: { id?: string; name: string; parentId: string | null; expectedLayoutRevision: number }) {
    return this.store.transaction(() => {
      if (!input || !(input.parentId === null || typeof input.parentId === 'string'))
        fail('INVALID_FOLDER', '请明确目标文件夹，根目录使用 null。');
      this.check(input.expectedLayoutRevision);
      const folders = this.store.folders(),
        name = this.name(input.name),
        id = input.id || uid();
      if (input.id && !folders.some((f) => f.id === id)) fail('NOT_FOUND', '文件夹不存在。', 404);
      if (input.parentId && !folders.some((f) => f.id === input.parentId))
        fail('NOT_FOUND', '目标文件夹不存在。', 404);
      let parent = input.parentId;
      const visited = new Set<string>();
      while (parent) {
        if (parent === id || visited.has(parent)) fail('FOLDER_CYCLE', '不能移动到自身或子文件夹。');
        visited.add(parent);
        parent = folders.find((f) => f.id === parent)?.parentId || null;
      }
      if (folders.some((f) => f.id !== id && f.parentId === input.parentId && f.name === name))
        fail('DUPLICATE_FOLDER', '当前位置已有同名文件夹。');
      const folder: Folder = { id, name, parentId: input.parentId };
      this.store.saveFolder(folder);
      this.bump();
      return folder;
    });
  }
  presentation(
    documentId: string,
    input: { displayName?: string; folderId?: string | null; expectedLayoutRevision: number },
  ) {
    return this.store.transaction(() => {
      this.check(input.expectedLayoutRevision);
      this.store.document(documentId);
      const old = this.store.presentations().find((p) => p.documentId === documentId)!;
      if (input.folderId && !this.store.folders().some((f) => f.id === input.folderId))
        fail('NOT_FOUND', '目标文件夹不存在。', 404);
      const value: Presentation = {
        ...old,
        ...(input.displayName !== undefined ? { displayName: this.name(input.displayName) } : {}),
        ...(Object.hasOwn(input, 'folderId') ? { folderId: input.folderId ?? null } : {}),
      };
      this.store.savePresentation(value);
      this.bump();
      return value;
    });
  }
}
