import type { Snapshot } from '../api/client.ts';
import type { View } from '../../shared/contracts/workspace.ts';
export const displayName = (s: Snapshot, v: View) =>
  s.presentations.find((p) => p.documentId === v.document.id)?.displayName || v.document.title;
export function folderDocuments(s: Snapshot, folderId: string | null): View[] {
  const folders = new Set<string | null>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of s.folders)
      if (f.parentId && folders.has(f.parentId) && !folders.has(f.id)) {
        folders.add(f.id);
        changed = true;
      }
  }
  return primaryViews(s).filter((v) =>
    folders.has(s.presentations.find((p) => p.documentId === v.document.id)?.folderId || null),
  );
}
export function primaryViews(s: Snapshot): View[] {
  const rank = { sync: 0, anchor: 1, unconfigured: 2, history: 3 };
  return [...new Set(s.views.map((v) => v.document.id))].map(
    (id) =>
      s.views
        .filter((v) => v.document.id === id)
        .sort((a, b) => rank[a.member.role] - rank[b.member.role])[0],
  );
}
export function toggleSelection(selected: string[], ids: string[], checked: boolean) {
  return checked ? [...new Set([...selected, ...ids])] : selected.filter((id) => !ids.includes(id));
}
