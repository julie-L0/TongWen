import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { hash, uid, fail } from '../domain/rules.ts';
import type { Block, Document, Version, Membership, Scope, Operation, Decision } from '../domain/types.ts';
import { SQLiteAgentStore } from './sqlite-agent-store.ts';
import { sqliteTransaction } from './sqlite-transaction.ts';
import type { Folder, Presentation } from '../domain/types.ts';
export class SQLiteStore {
  private db: DatabaseSync;
  readonly agent: SQLiteAgentStore;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;');
    this.db.exec(`
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,format TEXT NOT NULL CHECK(format IN ('md','pdf')),asset_path TEXT,
    head_version_id TEXT REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),seq INTEGER NOT NULL,
    hash TEXT NOT NULL,blocks_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,seq));
   CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE IF NOT EXISTS memberships(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),document_id TEXT NOT NULL REFERENCES documents(id),
    role TEXT NOT NULL CHECK(role IN ('unconfigured','anchor','sync','history')),pin_version_id TEXT REFERENCES versions(id),
    baseline_version_id TEXT NOT NULL REFERENCES versions(id),compare_document_id TEXT REFERENCES documents(id));
   CREATE UNIQUE INDEX IF NOT EXISTS one_sync_head ON memberships(scope_id,document_id) WHERE role='sync';
   CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),member_id TEXT NOT NULL REFERENCES memberships(id),
    before_version_id TEXT NOT NULL REFERENCES versions(id),after_version_id TEXT NOT NULL REFERENCES versions(id),expected_revision INTEGER NOT NULL,
    request_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,undone_at TEXT);
   CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,command TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,issue_key TEXT NOT NULL,source_hash TEXT NOT NULL,target_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('retain','defer')),reason TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT);
   CREATE TRIGGER IF NOT EXISTS immutable_version_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
   CREATE TRIGGER IF NOT EXISTS immutable_version_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
   CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES folders(id));
   CREATE TABLE IF NOT EXISTS document_layout(document_id TEXT PRIMARY KEY REFERENCES documents(id),display_name TEXT NOT NULL,file_name TEXT NOT NULL,folder_id TEXT REFERENCES folders(id));
   CREATE TABLE IF NOT EXISTS version_labels(version_id TEXT PRIMARY KEY REFERENCES versions(id),source_name TEXT NOT NULL,label TEXT NOT NULL);
  `);
    const existing = this.meta('schemaVersion');
    if (existing && !['1', '2', '3'].includes(existing))
      fail('SCHEMA_VERSION', '数据库版本不兼容，不能自动覆盖。', 500);
    // Additive migration: existing document versions and user edits are preserved.
    this.agent = new SQLiteAgentStore(this.db);
    this.setMeta('schemaVersion', '3');
  }
  close() {
    this.db.close();
  }
  folders(): Folder[] {
    return this.db
      .prepare('SELECT * FROM folders ORDER BY rowid')
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        parentId: r.parent_id ? String(r.parent_id) : null,
      }));
  }
  saveFolder(f: Folder) {
    this.db
      .prepare(
        'INSERT INTO folders VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id',
      )
      .run(f.id, f.name, f.parentId);
  }
  presentations(): Presentation[] {
    return this.documents().map((d) => {
      const r = this.db.prepare('SELECT * FROM document_layout WHERE document_id=?').get(d.id);
      return {
        documentId: d.id,
        displayName: r ? String(r.display_name) : d.title,
        fileName: r ? String(r.file_name) : d.title + '.' + d.format,
        folderId: r?.folder_id ? String(r.folder_id) : null,
      };
    });
  }
  savePresentation(p: Presentation) {
    this.db
      .prepare(
        'INSERT INTO document_layout VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET display_name=excluded.display_name,file_name=excluded.file_name,folder_id=excluded.folder_id',
      )
      .run(p.documentId, p.displayName, p.fileName, p.folderId);
  }
  transaction<T>(fn: () => T): T {
    return sqliteTransaction(this.db, fn);
  }
  meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return r ? String(r.value) : null;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
  scopes(): Scope[] {
    return this.db
      .prepare('SELECT * FROM scopes ORDER BY rowid')
      .all()
      .map((r) => ({ id: String(r.id), name: String(r.name), revision: Number(r.revision) }));
  }
  scope(id: string) {
    const s = this.scopes().find((s) => s.id === id);
    if (!s) fail('NOT_FOUND', '资料组不存在。', 404);
    return s!;
  }
  ensureScope(name: string) {
    if (typeof name !== 'string') fail('INVALID_SCOPE', '请填写资料组名称。');
    const normalized = name.trim();
    if (!normalized || normalized.length > 100) fail('INVALID_SCOPE', '请填写 1—100 字的资料组名称。');
    const s = this.scopes().find((s) => s.name === normalized);
    if (s) return s;
    const id = uid();
    this.db.prepare('INSERT INTO scopes(id,name) VALUES(?,?)').run(id, normalized);
    return this.scope(id);
  }
  bumpScope(id: string) {
    this.db.prepare('UPDATE scopes SET revision=revision+1 WHERE id=?').run(id);
  }
  documents(): Document[] {
    return this.db
      .prepare('SELECT * FROM documents ORDER BY created_at,rowid')
      .all()
      .map((r) => ({
        id: String(r.id),
        title: String(r.title),
        format: r.format as Document['format'],
        assetPath: r.asset_path ? String(r.asset_path) : null,
        headVersionId: r.head_version_id ? String(r.head_version_id) : '',
        revision: Number(r.revision),
        createdAt: String(r.created_at),
      }));
  }
  document(id: string) {
    const d = this.documents().find((d) => d.id === id);
    if (!d) fail('NOT_FOUND', '文档不存在。', 404);
    return d!;
  }
  insertDocument(title: string, format: 'md' | 'pdf', assetPath: string | null = null) {
    const id = uid();
    this.db
      .prepare('INSERT INTO documents(id,title,format,asset_path,created_at) VALUES(?,?,?,?,?)')
      .run(id, title, format, assetPath, new Date().toISOString());
    return id;
  }
  version(id: string): Version {
    const r = this.db.prepare('SELECT * FROM versions WHERE id=?').get(id);
    if (!r) fail('NOT_FOUND', '版本不存在。', 404);
    return this.mapVersion(r!);
  }
  versions(documentId: string): Version[] {
    return this.db
      .prepare('SELECT * FROM versions WHERE document_id=? ORDER BY seq DESC')
      .all(documentId)
      .map((r) => this.mapVersion(r));
  }
  private mapVersion(r: Record<string, unknown>): Version {
    const label = this.db.prepare('SELECT * FROM version_labels WHERE version_id=?').get(String(r.id));
    return {
      id: String(r.id),
      documentId: String(r.document_id),
      seq: Number(r.seq),
      hash: String(r.hash),
      blocks: JSON.parse(String(r.blocks_json)),
      reason: String(r.reason),
      createdAt: String(r.created_at),
      ...(label ? { label: String(label.label), sourceName: String(label.source_name) } : {}),
    };
  }
  insertVersion(documentId: string, blocks: Block[], reason: string): Version {
    const current = this.document(documentId).headVersionId;
    const origin = current ? this.version(current) : null;
    const seq = Number(
        this.db
          .prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM versions WHERE document_id=?')
          .get(documentId)!.seq,
      ),
      id = uid();
    this.db
      .prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?)')
      .run(id, documentId, seq, hash(blocks), JSON.stringify(blocks), reason, new Date().toISOString());
    if (origin?.sourceName) this.labelVersion(id, origin.sourceName, origin.label || '');
    return this.version(id);
  }
  labelVersion(versionId: string, sourceName: string, label: string) {
    this.db
      .prepare(
        'INSERT INTO version_labels VALUES(?,?,?) ON CONFLICT(version_id) DO UPDATE SET source_name=excluded.source_name,label=excluded.label',
      )
      .run(versionId, sourceName, label);
  }
  setHead(documentId: string, versionId: string) {
    this.db
      .prepare('UPDATE documents SET head_version_id=?,revision=revision+1 WHERE id=?')
      .run(versionId, documentId);
  }
  members(): Membership[] {
    return this.db
      .prepare('SELECT * FROM memberships ORDER BY rowid')
      .all()
      .map((r) => ({
        id: String(r.id),
        scopeId: String(r.scope_id),
        documentId: String(r.document_id),
        role: r.role as Membership['role'],
        pinVersionId: r.pin_version_id ? String(r.pin_version_id) : null,
        baselineVersionId: String(r.baseline_version_id),
        compareDocumentId: r.compare_document_id ? String(r.compare_document_id) : null,
      }));
  }
  member(id: string) {
    const m = this.members().find((m) => m.id === id);
    if (!m) fail('NOT_FOUND', '资料视图不存在。', 404);
    return m!;
  }
  insertMember(value: Omit<Membership, 'id'>) {
    const id = uid();
    this.db
      .prepare('INSERT INTO memberships VALUES(?,?,?,?,?,?,?)')
      .run(
        id,
        value.scopeId,
        value.documentId,
        value.role,
        value.pinVersionId,
        value.baselineVersionId,
        value.compareDocumentId,
      );
    return this.member(id);
  }
  updateMember(m: Membership) {
    this.db
      .prepare(
        'UPDATE memberships SET scope_id=?,role=?,pin_version_id=?,baseline_version_id=?,compare_document_id=? WHERE id=?',
      )
      .run(m.scopeId, m.role, m.pinVersionId, m.baselineVersionId, m.compareDocumentId, m.id);
  }
  addOperation(o: Operation) {
    this.db
      .prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        o.id,
        o.documentId,
        o.memberId,
        o.beforeVersionId,
        o.afterVersionId,
        o.expectedRevision,
        o.requestId,
        o.createdAt,
        o.undoneAt,
      );
  }
  operations(): Operation[] {
    return this.db
      .prepare('SELECT * FROM operations ORDER BY rowid DESC')
      .all()
      .map((r) => ({
        id: String(r.id),
        documentId: String(r.document_id),
        memberId: String(r.member_id),
        beforeVersionId: String(r.before_version_id),
        afterVersionId: String(r.after_version_id),
        expectedRevision: Number(r.expected_revision),
        requestId: String(r.request_id),
        createdAt: String(r.created_at),
        undoneAt: r.undone_at ? String(r.undone_at) : null,
      }));
  }
  markUndone(id: string) {
    this.db.prepare('UPDATE operations SET undone_at=? WHERE id=?').run(new Date().toISOString(), id);
  }
  priorRequest(id: string, command: string, input: unknown) {
    const r = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (!r) return null;
    if (r.command !== command || r.input_hash !== hash(input))
      fail('REQUEST_REUSED', '请求 ID 已用于不同操作。', 409);
    return JSON.parse(String(r.result_json));
  }
  saveRequest(id: string, command: string, input: unknown, result: unknown) {
    this.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?)')
      .run(id, command, hash(input), JSON.stringify(result));
  }
  decisions(): Decision[] {
    return this.db
      .prepare('SELECT * FROM decisions ORDER BY rowid DESC')
      .all()
      .map((r) => ({
        id: String(r.id),
        issueKey: String(r.issue_key),
        sourceHash: String(r.source_hash),
        targetHash: String(r.target_hash),
        policyHash: String(r.policy_hash),
        action: r.action as Decision['action'],
        reason: String(r.reason),
        createdAt: String(r.created_at),
        revokedAt: r.revoked_at ? String(r.revoked_at) : null,
      }));
  }
  addDecision(d: Decision) {
    this.db
      .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        d.id,
        d.issueKey,
        d.sourceHash,
        d.targetHash,
        d.policyHash,
        d.action,
        d.reason,
        d.createdAt,
        d.revokedAt,
      );
  }
  revokeDecision(id: string) {
    this.db.prepare('UPDATE decisions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), id);
  }
}
