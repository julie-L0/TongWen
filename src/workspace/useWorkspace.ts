import { useEffect, useRef, useState } from 'react';
import { api, type Snapshot } from '../api/client';
import type { Block, View } from '../../shared/contracts/workspace';
export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [activeId, setActiveId] = useState(''),
    [saving, setSaving] = useState('saved'),
    [switching, setSwitching] = useState(false),
    [error, setError] = useState('');
  const current = useRef<Snapshot | null>(null),
    draft = useRef<{ memberId: string; blocks: Block[] } | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    queue = useRef(Promise.resolve()),
    lock = useRef(false);
  const invalidFormat = useRef('');
  function update(value: Snapshot) {
    current.current = value;
    setSnapshot(value);
  }
  async function reload() {
    const value = await api<Snapshot>('/workspace');
    update(value);
    return value;
  }
  useEffect(() => {
    reload()
      .then((s) => setActiveId(s.views.find((v) => v.editable)?.member.id || s.views[0]?.member.id || ''))
      .catch((e) => setError(e.message));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (draft.current || invalidFormat.current || saving === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [saving]);
  async function flush() {
    if (invalidFormat.current) throw new Error(invalidFormat.current + '；请修正后再切换或导出。');
    if (timer.current) clearTimeout(timer.current);
    const job = queue.current.then(async () => {
      const pending = draft.current;
      if (!pending) return;
      const view = current.current!.views.find((v) => v.member.id === pending.memberId)!;
      setSaving('saving');
      try {
        await api(
          `/views/${pending.memberId}/content`,
          { expectedRevision: view.document.revision, blocks: pending.blocks },
          'PATCH',
        );
        await reload();
        if (draft.current === pending) draft.current = null;
        setSaving(draft.current ? 'unsaved' : 'saved');
      } catch (e) {
        setSaving('failed');
        throw e;
      }
    });
    queue.current = job.catch(() => {});
    return job;
  }
  function changed(blocks: Block[]) {
    invalidFormat.current = '';
    const view = current.current!.views.find((v) => v.member.id === activeId)!;
    if (!draft.current && JSON.stringify(view.version.blocks) === JSON.stringify(blocks)) return;
    draft.current = { memberId: activeId, blocks };
    setSaving('unsaved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush().catch((e) => setError(e.message)), 450);
  }
  async function activate(id: string) {
    if (id === activeId || lock.current) return;
    lock.current = true;
    setSwitching(true);
    setError('');
    try {
      await flush();
      if (draft.current) await flush();
      setActiveId(id);
    } catch (e: any) {
      setError('切换前保存失败：' + e.message);
    } finally {
      lock.current = false;
      setSwitching(false);
    }
  }
  async function synchronize(value?: Snapshot, nextId?: string) {
    if (value) update(value);
    else await reload();
    if (nextId) setActiveId(nextId);
  }
  const active: View | undefined = snapshot?.views.find((v) => v.member.id === activeId),
    blocks = draft.current?.memberId === activeId ? draft.current.blocks : active?.version.blocks || [];
  return {
    snapshot,
    active,
    activeId,
    blocks,
    saving,
    switching,
    error,
    setError,
    reload,
    flush,
    changed,
    activate,
    synchronize,
    formatError: (message: string) => {
      invalidFormat.current = message;
      setError(message);
      setSaving('failed');
    },
  };
}
