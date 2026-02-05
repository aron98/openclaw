import type { DatabaseSync } from "node:sqlite";

export type MemoryType = "note" | "summary" | "archive" | "session";

export type MemoryEntry = {
  id: string;
  content: string;
  summary?: string;
  sourcePath?: string;
  memoryType: MemoryType;
  importanceScore: number;
  createdAt: number;
  updatedAt: number;
  accessedAt?: number;
  accessCount: number;
  compressedFrom?: string;
};

export type MemoryTag = {
  id: number;
  name: string;
  color?: string;
  createdAt: number;
};

export type MemoryAccessLog = {
  id: number;
  memoryId: string;
  accessedAt: number;
  query?: string;
};

export type MemorySearchFilters = {
  tags?: string[];
  memoryType?: MemoryType;
  minImportance?: number;
  createdAfter?: number;
  createdBefore?: number;
};

/**
 * Schema for the structured memory store.
 * This adds metadata, tags, and access tracking to the existing memory system.
 */
export function ensureStructuredMemorySchema(db: DatabaseSync): void {
  // Core memories table with metadata
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      summary TEXT,
      source_path TEXT,
      memory_type TEXT DEFAULT 'note' CHECK (memory_type IN ('note', 'summary', 'archive', 'session')),
      importance_score REAL DEFAULT 0.5 CHECK (importance_score >= 0 AND importance_score <= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      compressed_from TEXT
    );
  `);

  // Tags for categorization
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // Memory-tag relationships
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
      tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (memory_id, tag_id)
    );
  `);

  // Track access patterns for importance scoring
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
      accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      query TEXT
    );
  `);

  // FTS5 virtual table for full-text search on structured memories
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      summary,
      content='memories',
      content_rowid='id'
    );
  `);

  // Triggers to keep FTS index in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, summary) 
      VALUES (new.id, new.content, new.summary);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
      UPDATE memories_fts SET content = new.content, summary = new.summary 
      WHERE rowid = old.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.id;
    END;
  `);

  // Indexes for efficient queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_log_memory ON memory_access_log(memory_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_log_time ON memory_access_log(accessed_at DESC);`);
}
