import type { DatabaseSync } from 'node:sqlite';

export const STORE_SCHEMA_VERSION = 7;

/** Version zero includes databases created before versioned migrations existed. */
const migrations = [
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
      db.exec(migrations[index]!);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
