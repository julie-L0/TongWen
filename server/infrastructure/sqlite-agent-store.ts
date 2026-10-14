import type { DatabaseSync } from 'node:sqlite';
import { fail, uid } from '../domain/rules.ts';
import type {
  AgentStore,
  Run,
  RunEvent,
  Difference,
  Proposal,
  ToolCall,
  ReviewBatch,
} from '../agent/types.ts';
import { sqliteTransaction } from './sqlite-transaction.ts';
import type { ConfirmedRelation } from '../../shared/contracts/agent.ts';

export class SQLiteAgentStore implements AgentStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
   CREATE TABLE IF NOT EXISTS confirmed_relations(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,source_member_id TEXT NOT NULL,source_block_id TEXT NOT NULL,target_member_id TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS confirmed_relation_source ON confirmed_relations(scope_id,source_member_id,source_block_id,status);
   CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_hash TEXT NOT NULL,scope_id TEXT NOT NULL REFERENCES scopes(id),source_member_id TEXT NOT NULL REFERENCES memberships(id),status TEXT NOT NULL,manifest_json TEXT NOT NULL,runtime_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS agent_runs_scope ON agent_runs(scope_id,status);
   CREATE TABLE IF NOT EXISTS agent_changes(run_id TEXT NOT NULL REFERENCES agent_runs(id),id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,id));
   CREATE TABLE IF NOT EXISTS agent_evidence(run_id TEXT NOT NULL REFERENCES agent_runs(id),id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,id));
   CREATE TABLE IF NOT EXISTS agent_relations(run_id TEXT NOT NULL REFERENCES agent_runs(id),id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,id));
   CREATE TABLE IF NOT EXISTS agent_findings(run_id TEXT NOT NULL REFERENCES agent_runs(id),id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,id));
   CREATE TABLE IF NOT EXISTS agent_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES agent_runs(id),kind TEXT NOT NULL,summary TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_tool_calls(run_id TEXT NOT NULL REFERENCES agent_runs(id),call_id TEXT NOT NULL,name TEXT NOT NULL,args_json TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,PRIMARY KEY(run_id,call_id));
   CREATE TABLE IF NOT EXISTS agent_round_inputs(run_id TEXT NOT NULL REFERENCES agent_runs(id),round INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,round));
   CREATE TABLE IF NOT EXISTS agent_differences(id TEXT PRIMARY KEY,issue_key TEXT NOT NULL,source_hash TEXT NOT NULL,target_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,target_member_id TEXT NOT NULL REFERENCES memberships(id),status TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(issue_key,source_hash,target_hash,policy_hash));
   CREATE TABLE IF NOT EXISTS agent_proposals(id TEXT PRIMARY KEY,difference_id TEXT NOT NULL REFERENCES agent_differences(id),created_run_id TEXT NOT NULL REFERENCES agent_runs(id),latest_run_id TEXT NOT NULL REFERENCES agent_runs(id),state TEXT NOT NULL,payload_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_run_proposals(run_id TEXT NOT NULL REFERENCES agent_runs(id),proposal_id TEXT NOT NULL REFERENCES agent_proposals(id),PRIMARY KEY(run_id,proposal_id));
   CREATE TABLE IF NOT EXISTS agent_review_batches(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_runs(id),payload_json TEXT NOT NULL);
  `);
  }
  transaction<T>(fn: () => T): T {
    return sqliteTransaction(this.db, fn);
  }
  confirmedRelations(): ConfirmedRelation[] {
    return this.db.prepare('SELECT payload_json FROM confirmed_relations ORDER BY rowid DESC').all()
      .map(r => JSON.parse(String(r.payload_json)));
  }
  saveConfirmedRelation(r: ConfirmedRelation) {
    this.db.prepare('INSERT INTO confirmed_relations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json')
      .run(r.id,r.scopeId,r.sourceMemberId,r.sourceBlockId,r.targetMemberId,r.status,JSON.stringify(r));
  }
  saveRoundInput(runId: string, round: number, input: unknown) {
    this.db.prepare('INSERT INTO agent_round_inputs VALUES(?,?,?)').run(runId, round, JSON.stringify(input));
  }
  roundInputs(runId: string) {
    return this.db.prepare('SELECT round,payload_json FROM agent_round_inputs WHERE run_id=? ORDER BY round').all(runId)
      .map((r) => ({ round: Number(r.round), input: JSON.parse(String(r.payload_json)) as unknown }));
  }
  reviewBatches(runId?: string): ReviewBatch[] {
    return (
      runId
        ? this.db
            .prepare('SELECT payload_json FROM agent_review_batches WHERE run_id=? ORDER BY rowid DESC')
            .all(runId)
        : this.db.prepare('SELECT payload_json FROM agent_review_batches ORDER BY rowid DESC').all()
    ).map((r) => JSON.parse(String(r.payload_json)));
  }
  saveReviewBatch(batch: ReviewBatch) {
    this.db
      .prepare(
        'INSERT INTO agent_review_batches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json',
      )
      .run(batch.id, batch.runId, JSON.stringify(batch));
  }
  createRun(run: Run) {
    this.db
      .prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        run.id,
        run.requestId,
        run.inputHash,
        run.manifest.source.scope.id,
        run.manifest.sourceMemberId,
        run.status,
        JSON.stringify(run.manifest),
        this.runtime(run),
        run.createdAt,
        run.updatedAt,
      );
    this.saveEntities(run);
  }
  saveRun(run: Run) {
    this.db
      .prepare('UPDATE agent_runs SET status=?,runtime_json=?,updated_at=? WHERE id=?')
      .run(run.status, this.runtime(run), run.updatedAt, run.id);
    this.saveEntities(run);
  }
  private runtime(run: Run) {
    const { manifest, changes, evidence, relations, findings, ...rest } = run;
    return JSON.stringify(rest);
  }
  private saveEntities(run: Run) {
    for (const [table, values] of [
      ['changes', run.changes],
      ['evidence', run.evidence],
      ['relations', run.relations],
      ['findings', run.findings],
    ] as const) {
      const statement = this.db.prepare(
        `INSERT INTO agent_${table} VALUES(?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET payload_json=excluded.payload_json`,
      );
      for (const value of values) statement.run(run.id, value.id, JSON.stringify(value));
      const activeIds = new Set(values.map((v) => v.id));
      for (const row of this.db.prepare(`SELECT id FROM agent_${table} WHERE run_id=?`).all(run.id))
        if (!activeIds.has(String(row.id)))
          this.db.prepare(`DELETE FROM agent_${table} WHERE run_id=? AND id=?`).run(run.id, String(row.id));
    }
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(id);
    if (!row) fail('NOT_FOUND', 'Agent 任务不存在。', 404);
    return this.mapRun(row!);
  }
  private mapRun(row: Record<string, unknown>): Run {
    const result = {
      ...JSON.parse(String(row.runtime_json)),
      manifest: JSON.parse(String(row.manifest_json)),
    };
    for (const table of ['changes', 'evidence', 'relations', 'findings'])
      result[table] = this.db
        .prepare(`SELECT payload_json FROM agent_${table} WHERE run_id=? ORDER BY rowid`)
        .all(String(row.id))
        .map((r) => JSON.parse(String(r.payload_json)));
    return result;
  }
  runs(): Run[] {
    return this.db
      .prepare('SELECT * FROM agent_runs ORDER BY rowid DESC')
      .all()
      .map((r) => this.mapRun(r));
  }
  request(id: string) {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE request_id=?').get(id);
    return row ? this.mapRun(row) : null;
  }
  event(runId: string, kind: string, summary: string, payload: unknown = null) {
    this.db
      .prepare('INSERT INTO agent_events(run_id,kind,summary,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(runId, kind, summary, JSON.stringify(payload), new Date().toISOString());
  }
  events(runId: string, cursor = 0): RunEvent[] {
    return this.db
      .prepare('SELECT * FROM agent_events WHERE run_id=? AND id>? ORDER BY id LIMIT 100')
      .all(runId, cursor)
      .map((r) => ({
        id: Number(r.id),
        runId: String(r.run_id),
        kind: String(r.kind),
        summary: String(r.summary),
        payload: JSON.parse(String(r.payload_json)),
        createdAt: String(r.created_at),
      }));
  }
  invocation(runId: string, callId: string) {
    const r = this.db
      .prepare('SELECT * FROM agent_tool_calls WHERE run_id=? AND call_id=?')
      .get(runId, callId);
    return r
      ? {
          name: String(r.name),
          args: JSON.parse(String(r.args_json)),
          status: String(r.status),
          result: r.result_json ? JSON.parse(String(r.result_json)) : null,
        }
      : null;
  }
  startInvocation(runId: string, call: ToolCall, args: unknown) {
    this.db
      .prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?,NULL)')
      .run(runId, call.id, call.function.name, JSON.stringify(args), 'pending');
  }
  commitInvocation(runId: string, callId: string, result: unknown) {
    this.db
      .prepare('UPDATE agent_tool_calls SET status=?,result_json=? WHERE run_id=? AND call_id=?')
      .run('committed', JSON.stringify(result), runId, callId);
  }
  difference(value: Omit<Difference, 'id' | 'createdAt' | 'status'>): Difference {
    const r = this.db
      .prepare(
        'SELECT * FROM agent_differences WHERE issue_key=? AND source_hash=? AND target_hash=? AND policy_hash=?',
      )
      .get(value.issueKey, value.sourceHash, value.targetHash, value.policyHash);
    if (r) return this.mapDifference(r);
    const d: Difference = { ...value, id: uid(), status: 'pending', createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO agent_differences VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        d.id,
        d.issueKey,
        d.sourceHash,
        d.targetHash,
        d.policyHash,
        d.targetMemberId,
        d.status,
        d.reason,
        d.createdAt,
      );
    return d;
  }
  private mapDifference(r: Record<string, unknown>): Difference {
    return {
      id: String(r.id),
      issueKey: String(r.issue_key),
      sourceHash: String(r.source_hash),
      targetHash: String(r.target_hash),
      policyHash: String(r.policy_hash),
      targetMemberId: String(r.target_member_id),
      status: r.status as Difference['status'],
      reason: String(r.reason),
      createdAt: String(r.created_at),
    };
  }
  differences() {
    return this.db
      .prepare('SELECT * FROM agent_differences ORDER BY rowid DESC')
      .all()
      .map((r) => this.mapDifference(r));
  }
  saveDifference(d: Difference) {
    this.db
      .prepare('UPDATE agent_differences SET status=?,reason=? WHERE id=?')
      .run(d.status, d.reason, d.id);
  }
  proposals(runId?: string): Proposal[] {
    const rows = runId
      ? this.db
          .prepare(
            'SELECT p.payload_json FROM agent_proposals p JOIN agent_run_proposals r ON p.id=r.proposal_id WHERE r.run_id=? ORDER BY p.rowid',
          )
          .all(runId)
      : this.db.prepare('SELECT payload_json FROM agent_proposals ORDER BY rowid DESC').all();
    return rows.map((r) => JSON.parse(String(r.payload_json)));
  }
  proposal(id: string): Proposal {
    const r = this.db.prepare('SELECT payload_json FROM agent_proposals WHERE id=?').get(id);
    if (!r) fail('NOT_FOUND', '修订提案不存在。', 404);
    return JSON.parse(String(r!.payload_json));
  }
  saveProposal(p: Proposal) {
    this.db
      .prepare(
        'INSERT INTO agent_proposals VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET latest_run_id=excluded.latest_run_id,state=excluded.state,payload_json=excluded.payload_json',
      )
      .run(p.id, p.differenceId, p.createdRunId, p.latestRunId, p.state, JSON.stringify(p));
  }
  linkProposal(runId: string, id: string) {
    this.db.prepare('INSERT OR IGNORE INTO agent_run_proposals VALUES(?,?)').run(runId, id);
  }
}
