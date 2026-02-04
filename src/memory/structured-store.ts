// Structured Memory Store - SQLite-backed memory with metadata and compression support
// This module extends the existing memory system with structured storage capabilities

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("structured-memory");

// Table names
export const STRUCTURED_MEMORY_TABLE = "structured_memories";
export const MEMORY_TAGS_TABLE = "memory_tags";
export const TAGS_TABLE = "tags";
export const ACCESS_LOG_TABLE = "memory_access_log";
export const MEMORY_RELATIONS_TABLE = "memory_relations";

// Memory types for categorization
export type MemoryType = "note" | "summary" | "archive" | "decision" | "preference" | "todo";

// Importance level for prioritization
export type ImportanceLevel = "low" | "medium" | "high" | "critical";

// Memory entry in structured store
export interface StructuredMemory {
  id: string;
  content: string;
  summary?: string;
  sourcePath: string;
  memoryType: MemoryType;
  importanceLevel: ImportanceLevel;
  importanceScore: number; // 0.0 - 1.0, calculated from access patterns
  tags: string[];
  createdAt: number;
  updatedAt: number;
  accessedAt?: number;
  accessCount: number;
  // Compression tracking
  compressedFrom?: string[]; // IDs of memories this was summarized from
  compressionLevel?: number; // 0 = original, 1 = daily summary, 2 = weekly, 3 = monthly
  // Relations
  relatedMemories?: string[]; // IDs of related memories
  // Source tracking
  sourceSessionId?: string;
  sourceChannel?: string;
}

// Tag definition
export interface Tag {
  id: number;
  name: string;
  color?: string;
  description?: string;
  createdAt: number;
  memoryCount: number;
}

// Access log entry for importance scoring
export interface AccessLogEntry {
  id: number;
  memoryId: string;
  accessedAt: number;
  query?: string;
  action: "search" | "read" | "write" | "update";
}

// Configuration for structured memory
export interface StructuredMemoryConfig {
  enabled: boolean;
  // Sync settings
  sync: {
    markdown: boolean; // Sync with markdown files
    bidirectional: boolean;
    debounceMs: number;
    watchFiles: boolean;
  };
  // Compression settings
  compression: {
    enabled: boolean;
    dailyToWeekly: string; // Duration like "7d"
    weeklyToMonthly: string; // Duration like "30d"
    archiveAfter: string; // Duration like "90d"
    minMemoriesForSummary: number; // Min memories before creating summary
  };
  // Importance scoring
  importance: {
    enabled: boolean;
    decayFactor: number; // Daily decay (0.9 = 10% decay per day)
    accessBoost: number; // Score increase per access
    recencyBoost: number; // Boost for recent memories
    manualBoost: number; // Multiplier for manually marked important
  };
  // Query settings
  query: {
    importanceWeight: number; // 0.0 - 1.0, how much to weight importance in results
    recencyWeight: number; // 0.0 - 1.0, how much to weight recency
    defaultLimit: number;
  };
}

// Default configuration
export const DEFAULT_STRUCTURED_MEMORY_CONFIG: StructuredMemoryConfig = {
  enabled: false,
  sync: {
    markdown: true,
    bidirectional: true,
    debounceMs: 1500,
    watchFiles: true,
  },
  compression: {
    enabled: true,
    dailyToWeekly: "7d",
    weeklyToMonthly: "30d",
    archiveAfter: "90d",
    minMemoriesForSummary: 5,
  },
  importance: {
    enabled: true,
    decayFactor: 0.95,
    accessBoost: 0.05,
    recencyBoost: 0.1,
    manualBoost: 1.5,
  },
  query: {
    importanceWeight: 0.3,
    recencyWeight: 0.2,
    defaultLimit: 10,
  },
};

/**
 * Ensure the structured memory schema exists in the database
 */
export function ensureStructuredMemorySchema(db: DatabaseSync): void {
  // Main memories table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${STRUCTURED_MEMORY_TABLE} (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      summary TEXT,
      source_path TEXT NOT NULL,
      memory_type TEXT DEFAULT 'note',
      importance_level TEXT DEFAULT 'medium',
      importance_score REAL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      compressed_from TEXT, -- JSON array of memory IDs
      compression_level INTEGER DEFAULT 0,
      related_memories TEXT, -- JSON array of memory IDs
      source_session_id TEXT,
      source_channel TEXT
    );
  `);

  // Indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_structured_memory_type 
    ON ${STRUCTURED_MEMORY_TABLE}(memory_type);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_structured_memory_importance 
    ON ${STRUCTURED_MEMORY_TABLE}(importance_score DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_structured_memory_created 
    ON ${STRUCTURED_MEMORY_TABLE}(created_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_structured_memory_accessed 
    ON ${STRUCTURED_MEMORY_TABLE}(accessed_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_structured_memory_source 
    ON ${STRUCTURED_MEMORY_TABLE}(source_path);
  `);

  // Tags table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TAGS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT,
      description TEXT,
      created_at INTEGER NOT NULL,
      memory_count INTEGER DEFAULT 0
    );
  `);

  // Memory-tag relationships
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMORY_TAGS_TABLE} (
      memory_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (memory_id, tag_id),
      FOREIGN KEY (memory_id) REFERENCES ${STRUCTURED_MEMORY_TABLE}(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES ${TAGS_TABLE}(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_tags_tag 
    ON ${MEMORY_TAGS_TABLE}(tag_id);
  `);

  // Access log for importance scoring
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ACCESS_LOG_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      accessed_at INTEGER NOT NULL,
      query TEXT,
      action TEXT DEFAULT 'read',
      FOREIGN KEY (memory_id) REFERENCES ${STRUCTURED_MEMORY_TABLE}(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_log_memory 
    ON ${ACCESS_LOG_TABLE}(memory_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_log_time 
    ON ${ACCESS_LOG_TABLE}(accessed_at DESC);
  `);

  // Memory relations for linking related memories
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MEMORY_RELATIONS_TABLE} (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT DEFAULT 'related',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, target_id),
      FOREIGN KEY (source_id) REFERENCES ${STRUCTURED_MEMORY_TABLE}(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES ${STRUCTURED_MEMORY_TABLE}(id) ON DELETE CASCADE
    );
  `);

  log.debug("Structured memory schema ensured");
}

/**
 * Parse duration string like "7d", "30d", "24h" to milliseconds
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Expected format: 7d, 24h, 60m`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    d: 24 * 60 * 60 * 1000, // days
    h: 60 * 60 * 1000, // hours
    m: 60 * 1000, // minutes
  };
  return value * multipliers[unit];
}

/**
 * Main class for structured memory operations
 */
export class StructuredMemoryStore {
  private db: DatabaseSync;
  private config: StructuredMemoryConfig;
  private agentId: string;
  private workspaceDir: string;

  constructor(params: {
    db: DatabaseSync;
    config?: Partial<StructuredMemoryConfig>;
    agentId: string;
    workspaceDir: string;
  }) {
    this.db = params.db;
    // Deep merge config with defaults
    this.config = {
      ...DEFAULT_STRUCTURED_MEMORY_CONFIG,
      ...params.config,
      sync: {
        ...DEFAULT_STRUCTURED_MEMORY_CONFIG.sync,
        ...params.config?.sync,
      },
      compression: {
        ...DEFAULT_STRUCTURED_MEMORY_CONFIG.compression,
        ...params.config?.compression,
      },
      importance: {
        ...DEFAULT_STRUCTURED_MEMORY_CONFIG.importance,
        ...params.config?.importance,
      },
      query: {
        ...DEFAULT_STRUCTURED_MEMORY_CONFIG.query,
        ...params.config?.query,
      },
    };
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;

    // Ensure schema exists
    ensureStructuredMemorySchema(this.db);
  }

  /**
   * Create a new memory entry
   */
  createMemory(
    memory: Omit<StructuredMemory, "id" | "createdAt" | "updatedAt" | "accessCount">,
  ): StructuredMemory {
    const id = randomUUID();
    const now = Date.now();
    const fullMemory: StructuredMemory = {
      ...memory,
      id,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    };

    this.db
      .prepare(
        `INSERT INTO ${STRUCTURED_MEMORY_TABLE} (
          id, content, summary, source_path, memory_type, importance_level,
          importance_score, created_at, updated_at, access_count,
          compressed_from, compression_level, related_memories,
          source_session_id, source_channel
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fullMemory.id,
        fullMemory.content,
        fullMemory.summary ?? null,
        fullMemory.sourcePath,
        fullMemory.memoryType,
        fullMemory.importanceLevel,
        fullMemory.importanceScore,
        fullMemory.createdAt,
        fullMemory.updatedAt,
        fullMemory.accessCount,
        fullMemory.compressedFrom ? JSON.stringify(fullMemory.compressedFrom) : null,
        fullMemory.compressionLevel ?? 0,
        fullMemory.relatedMemories ? JSON.stringify(fullMemory.relatedMemories) : null,
        fullMemory.sourceSessionId ?? null,
        fullMemory.sourceChannel ?? null,
      );

    // Add tags if provided
    if (memory.tags && memory.tags.length > 0) {
      this.setTagsForMemory(id, memory.tags);
    }

    log.debug("Created memory", { id, type: memory.memoryType, path: memory.sourcePath });
    return fullMemory;
  }

  /**
   * Get a memory by ID
   */
  getMemory(id: string): StructuredMemory | null {
    const row = this.db.prepare(`SELECT * FROM ${STRUCTURED_MEMORY_TABLE} WHERE id = ?`).get(id) as
      | StructuredMemoryRow
      | undefined;

    if (!row) return null;

    return this.rowToMemory(row);
  }

  /**
   * Update an existing memory
   */
  updateMemory(
    id: string,
    updates: Partial<Omit<StructuredMemory, "id" | "createdAt">>,
  ): StructuredMemory | null {
    const existing = this.getMemory(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.content !== undefined) {
      sets.push("content = ?");
      values.push(updates.content);
    }
    if (updates.summary !== undefined) {
      sets.push("summary = ?");
      values.push(updates.summary);
    }
    if (updates.memoryType !== undefined) {
      sets.push("memory_type = ?");
      values.push(updates.memoryType);
    }
    if (updates.importanceLevel !== undefined) {
      sets.push("importance_level = ?");
      values.push(updates.importanceLevel);
    }
    if (updates.importanceScore !== undefined) {
      sets.push("importance_score = ?");
      values.push(updates.importanceScore);
    }
    if (updates.tags !== undefined) {
      this.setTagsForMemory(id, updates.tags);
    }

    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    if (sets.length > 1) {
      this.db
        .prepare(`UPDATE ${STRUCTURED_MEMORY_TABLE} SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values);
    }

    log.debug("Updated memory", { id });
    return this.getMemory(id);
  }

  /**
   * Delete a memory by ID
   */
  deleteMemory(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM ${STRUCTURED_MEMORY_TABLE} WHERE id = ?`).run(id);
    const success = (result as { changes: number }).changes > 0;
    if (success) {
      log.debug("Deleted memory", { id });
    }
    return success;
  }

  /**
   * Search memories with filtering and ranking
   */
  searchMemories(params: {
    query?: string;
    tags?: string[];
    memoryType?: MemoryType;
    importanceLevel?: ImportanceLevel;
    limit?: number;
    offset?: number;
    orderBy?: "importance" | "recency" | "relevance";
  }): StructuredMemory[] {
    const {
      query,
      tags,
      memoryType,
      importanceLevel,
      limit = 10,
      offset = 0,
      orderBy = "relevance",
    } = params;

    let sql = `SELECT DISTINCT m.* FROM ${STRUCTURED_MEMORY_TABLE} m`;
    const whereConditions: string[] = [];
    const values: unknown[] = [];

    // Join with tags if filtering by tags
    if (tags && tags.length > 0) {
      sql += ` JOIN ${MEMORY_TAGS_TABLE} mt ON m.id = mt.memory_id
               JOIN ${TAGS_TABLE} t ON mt.tag_id = t.id`;
      whereConditions.push(`t.name IN (${tags.map(() => "?").join(",")})`);
      values.push(...tags);
    }

    // Add filters
    if (memoryType) {
      whereConditions.push("m.memory_type = ?");
      values.push(memoryType);
    }
    if (importanceLevel) {
      whereConditions.push("m.importance_level = ?");
      values.push(importanceLevel);
    }
    if (query) {
      whereConditions.push("(m.content LIKE ? OR m.summary LIKE ?)");
      values.push(`%${query}%`, `%${query}%`);
    }

    if (whereConditions.length > 0) {
      sql += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    // Order by
    const orderMap: Record<string, string> = {
      importance: "m.importance_score DESC",
      recency: "m.created_at DESC",
      relevance: "m.importance_score DESC, m.created_at DESC",
    };
    sql += ` ORDER BY ${orderMap[orderBy]}`;

    // Pagination - add limit and offset to values array
    sql += " LIMIT ? OFFSET ?";
    values.push(limit, offset);

    const rows = this.db.prepare(sql).all(...values) as unknown as StructuredMemoryRow[];
    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * Record an access to update importance scoring
   */
  recordAccess(memoryId: string, action: AccessLogEntry["action"], query?: string): void {
    const now = Date.now();

    // Add to access log
    this.db
      .prepare(
        `INSERT INTO ${ACCESS_LOG_TABLE} (memory_id, accessed_at, query, action) VALUES (?, ?, ?, ?)`,
      )
      .run(memoryId, now, query ?? null, action);

    // Update memory access stats
    this.db
      .prepare(
        `UPDATE ${STRUCTURED_MEMORY_TABLE} 
         SET access_count = access_count + 1, accessed_at = ? 
         WHERE id = ?`,
      )
      .run(now, memoryId);

    log.debug("Recorded access", { memoryId, action });
  }

  /**
   * Update importance scores based on access patterns
   */
  recalculateImportance(): void {
    if (!this.config.importance.enabled) return;

    const memories = this.db
      .prepare(
        `SELECT id, importance_score, access_count, created_at FROM ${STRUCTURED_MEMORY_TABLE}`,
      )
      .all() as Array<{
      id: string;
      importance_score: number;
      access_count: number;
      created_at: number;
    }>;

    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;

    for (const mem of memories) {
      const ageInDays = (now - mem.created_at) / dayInMs;
      const decayedScore =
        mem.importance_score * Math.pow(this.config.importance.decayFactor, ageInDays);
      const accessBoost = mem.access_count * this.config.importance.accessBoost;
      const recencyBoost = Math.max(0, 1 - ageInDays / 30) * this.config.importance.recencyBoost;

      const newScore = Math.min(1, Math.max(0, decayedScore + accessBoost + recencyBoost));

      this.db
        .prepare(`UPDATE ${STRUCTURED_MEMORY_TABLE} SET importance_score = ? WHERE id = ?`)
        .run(newScore, mem.id);
    }

    log.debug("Recalculated importance scores", { count: memories.length });
  }

  /**
   * Get or create tags for a memory
   */
  private setTagsForMemory(memoryId: string, tagNames: string[]): void {
    // Remove existing tags
    this.db.prepare(`DELETE FROM ${MEMORY_TAGS_TABLE} WHERE memory_id = ?`).run(memoryId);

    for (const tagName of tagNames) {
      // Get or create tag
      let tagRow = this.db.prepare(`SELECT id FROM ${TAGS_TABLE} WHERE name = ?`).get(tagName) as
        | { id: number }
        | undefined;

      if (!tagRow) {
        const result = this.db
          .prepare(`INSERT INTO ${TAGS_TABLE} (name, created_at, memory_count) VALUES (?, ?, 0)`)
          .run(tagName, Date.now());
        tagRow = { id: (result as { lastInsertRowid: number }).lastInsertRowid };
      }

      // Link tag to memory
      this.db
        .prepare(`INSERT OR IGNORE INTO ${MEMORY_TAGS_TABLE} (memory_id, tag_id) VALUES (?, ?)`)
        .run(memoryId, tagRow.id);

      // Update tag count
      this.db
        .prepare(
          `UPDATE ${TAGS_TABLE} SET memory_count = (
            SELECT COUNT(*) FROM ${MEMORY_TAGS_TABLE} WHERE tag_id = ?
          ) WHERE id = ?`,
        )
        .run(tagRow.id, tagRow.id);
    }
  }

  /**
   * Convert database row to StructuredMemory object
   */
  private rowToMemory(row: StructuredMemoryRow): StructuredMemory {
    return {
      id: row.id,
      content: row.content,
      summary: row.summary ?? undefined,
      sourcePath: row.source_path,
      memoryType: row.memory_type as MemoryType,
      importanceLevel: row.importance_level as ImportanceLevel,
      importanceScore: row.importance_score,
      tags: this.getTagsForMemory(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessedAt: row.accessed_at ?? undefined,
      accessCount: row.access_count,
      compressedFrom: row.compressed_from ? JSON.parse(row.compressed_from) : undefined,
      compressionLevel: row.compression_level,
      relatedMemories: row.related_memories ? JSON.parse(row.related_memories) : undefined,
      sourceSessionId: row.source_session_id ?? undefined,
      sourceChannel: row.source_channel ?? undefined,
    };
  }

  /**
   * Get tags for a memory
   */
  private getTagsForMemory(memoryId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name FROM ${TAGS_TABLE} t
         JOIN ${MEMORY_TAGS_TABLE} mt ON t.id = mt.tag_id
         WHERE mt.memory_id = ?`,
      )
      .all(memoryId) as Array<{ name: string }>;

    return rows.map((r) => r.name);
  }

  /**
   * Get all tags with counts
   */
  getAllTags(): Tag[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${TAGS_TABLE} ORDER BY memory_count DESC`)
      .all() as Array<{
      id: number;
      name: string;
      color?: string;
      description?: string;
      created_at: number;
      memory_count: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      description: row.description,
      createdAt: row.created_at,
      memoryCount: row.memory_count,
    }));
  }

  /**
   * Get memories that need compression (old, not yet summarized)
   */
  getMemoriesForCompression(params: {
    olderThan: number;
    compressionLevel: number;
    limit?: number;
  }): StructuredMemory[] {
    const { olderThan, compressionLevel, limit = 100 } = params;

    const rows = this.db
      .prepare(
        `SELECT * FROM ${STRUCTURED_MEMORY_TABLE}
         WHERE created_at < ?
         AND compression_level <= ?
         AND memory_type != 'summary'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(olderThan, compressionLevel, limit) as unknown as StructuredMemoryRow[];

    return rows.map((row) => this.rowToMemory(row));
  }
}

// Type for database rows
interface StructuredMemoryRow {
  id: string;
  content: string;
  summary: string | null;
  source_path: string;
  memory_type: string;
  importance_level: string;
  importance_score: number;
  created_at: number;
  updated_at: number;
  accessed_at: number | null;
  access_count: number;
  compressed_from: string | null;
  compression_level: number;
  related_memories: string | null;
  source_session_id: string | null;
  source_channel: string | null;
}
