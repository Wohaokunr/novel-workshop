import type { DatabaseSync } from 'node:sqlite';
import type { OperationBatch } from '../shared/types.js';
import { upgradeChanges, upgradeWorkspace } from './upgrade.js';

export const STORE_SCHEMA_VERSION = 8;

const TERMINAL = ['completed', 'failed', 'cancelled'];
export const UPGRADE_STOPPED_RUN = '软件升级改变了作品结构（场景独立于章节，正文按场景段保存，人物演进改为状态变化），这条未完成的任务无法继续，请重新发起。';

/** Rename the prose target of a run or plan node: what was a scene's prose is now the passage with the scene's id. */
function passageTarget<T extends Record<string, unknown>>(value: T, keepScene = false): T {
  if (!value || typeof value !== 'object' || !('sceneId' in value)) return value;
  const { sceneId, ...rest } = value;
  return (keepScene ? { ...value, passageId: sceneId } : { ...rest, ...(sceneId === undefined ? {} : { passageId: sceneId }) }) as unknown as T;
}
type StoredCandidate = { status?: string; changes?: OperationBatch['changes'] };
type StoredRuntime = { plan?: { nodes?: Array<Record<string, unknown>> }; candidates?: StoredCandidate[]; waiting?: unknown };
/** Plan nodes name passages; an evolution node keeps its scene. Candidate changes move to the new collections. */
function upgradeRuntime(runtime: StoredRuntime | undefined, stop: boolean): void {
  if (!runtime) return;
  if (runtime.plan?.nodes) runtime.plan.nodes = runtime.plan.nodes.map(node => passageTarget(node, node.role === 'evolution'));
  for (const candidate of runtime.candidates ?? []) {
    if (Array.isArray(candidate.changes)) candidate.changes = upgradeChanges(candidate.changes);
    if (stop && candidate.status === 'awaitingApproval') candidate.status = 'stale';
  }
  if (stop) delete runtime.waiting;
}

/** Format 2 of the book (see upgrade.ts), and everything stored beside it that names scenes' prose. Unfinished runs cannot resume
 * across the change, so they end as failed with the reason, and every base snapshot (format 1) is dropped. */
function separateScenesFromChapters(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT id,data FROM projects').all() as Array<{ id: string; data: string }>) {
    const before = JSON.parse(row.data) as unknown, after = upgradeWorkspace(before);
    if (after !== before) db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(after), row.id);
  }
  for (const row of db.prepare('SELECT id,data FROM operations').all() as Array<{ id: string; data: string }>) {
    const batch = JSON.parse(row.data) as OperationBatch;
    db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify({ ...batch, changes: upgradeChanges(batch.changes ?? []) }), row.id);
  }
  const stopped = new Set<string>(), at = new Date().toISOString();
  for (const row of db.prepare('SELECT id,data FROM runs').all() as Array<{ id: string; data: string }>) {
    const run = passageTarget(JSON.parse(row.data) as Record<string, unknown>) as Record<string, unknown> & { status?: string; finishedAt?: string; runtime?: StoredRuntime };
    // Still going: not finished, or a stop that has not completed (a cancelled run without finishedAt).
    const stop = !TERMINAL.includes(String(run.status)) || (run.status === 'cancelled' && !run.finishedAt);
    if (stop) { stopped.add(row.id); run.status = 'failed'; run.error = UPGRADE_STOPPED_RUN; run.finishedAt = at; }
    upgradeRuntime(run.runtime, stop);
    db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), row.id);
  }
  for (const row of db.prepare('SELECT run_id,data FROM agent_states').all() as Array<{ run_id: string; data: string }>) {
    const state = JSON.parse(row.data) as StoredRuntime & { pauseReason?: string };
    const stop = stopped.has(row.run_id);
    upgradeRuntime(state, stop);
    if (stop) delete state.pauseReason;
    db.prepare('UPDATE agent_states SET data=? WHERE run_id=?').run(JSON.stringify(state), row.run_id);
  }
  db.exec(`
    DELETE FROM agent_snapshots;
    UPDATE story_digests SET kind='passage',
      data=json_remove(json_set(data, '$.kind', 'passage', '$.passageId', json_extract(data, '$.sceneId')), '$.sceneId')
      WHERE kind='scene';
    ALTER TABLE story_vectors RENAME COLUMN scene_id TO passage_id;
  `);
}

/** Version zero includes databases created before versioned migrations existed. A step is SQL, or a function for data rewrites. */
const migrations: Array<string | ((db: DatabaseSync) => void)> = [
  `
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), started_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS operations_project ON operations(project_id);
    CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id);
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS runs_scope ON runs(id, project_id);
    CREATE TABLE IF NOT EXISTS agent_states (
      run_id TEXT PRIMARY KEY REFERENCES runs(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id)
    );
    CREATE INDEX IF NOT EXISTS agent_states_project ON agent_states(project_id);
    CREATE TABLE IF NOT EXISTS agent_receipts (
      key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      data TEXT NOT NULL,
      FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id)
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      id TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_turns (
      run_id TEXT NOT NULL REFERENCES runs(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      step_id TEXT NOT NULL,
      turn INTEGER NOT NULL CHECK (turn >= 0),
      request TEXT NOT NULL,
      response TEXT,
      at TEXT NOT NULL,
      PRIMARY KEY (run_id, step_id, turn),
      FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id)
    );
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_memories_project ON agent_memories(project_id);
  `,
  `
    CREATE TABLE IF NOT EXISTS companion_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS companion_threads_project ON companion_threads(project_id, updated_at);
  `,
  `
    CREATE TABLE IF NOT EXISTS story_digests (
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (project_id, kind, target_id)
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS style_observations (
      project_id TEXT NOT NULL REFERENCES projects(id),
      key TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (project_id, key)
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS agent_snapshots (
      run_id TEXT PRIMARY KEY REFERENCES runs(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id)
    );
    CREATE INDEX IF NOT EXISTS agent_snapshots_project ON agent_snapshots(project_id);
  `,
  `
    CREATE TABLE IF NOT EXISTS story_vectors (
      project_id TEXT NOT NULL REFERENCES projects(id),
      scene_id TEXT NOT NULL,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (project_id, scene_id, start)
    );
  `,
  separateScenesFromChapters,
];

/** All upgrades use the store's connection and either commit together or roll back. */
export function migrateDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > STORE_SCHEMA_VERSION) throw new Error(`数据库版本 ${version} 高于当前支持的版本 ${STORE_SCHEMA_VERSION}`);
  if (version === STORE_SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = version; index < migrations.length; index++) {
      const step = migrations[index]!;
      if (typeof step === 'string') db.exec(step); else step(db);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
