import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  MemoryTag,
  MemoryAccessLog,
  MemoryType,
  MemorySearchFilters,
} from "./schema.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ensureStructuredMemorySchema } from "./schema.js";

const log = createSubsystemLogger("structured-memory");

export type StructuredMemorySearchResult = {
  memory: MemoryEntry;
  tags: string[];
  relevanceScore: number;
  textMatchScore?: number;
};

export type CreateMemoryInput = {
  content: string;
  summary?: string;
  sourcePath?: string;
  memoryType?: MemoryType;
  importanceScore?: number;
  tags?: string[];
  createdAt?: number;
};

export type UpdateMemoryInput = {
  content?: string;
  summary?: string;
  importanceScore?: number;
  tags?: string[];
};

/**
 * Structured memory store with metadata, tags, and access tracking.
 * Complements the existing chunk-based vector search with higher-level memory management.
 */
export class StructuredMemoryStore {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    ensureStructuredMemorySchema(db);
  }

  /**
   * Create a new memory entry.
   */
  createMemory(input: CreateMemoryInput): MemoryEntry {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const memory: MemoryEntry = {
      id,
      content: input.content,
      summary: input.summary,
      sourcePath: input.sourcePath,
      memoryType: input.memoryType ?? "note",
      importanceScore: input.importanceScore ?? 0.5,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      accessCount: 0,
    };

    this.db
      .prepare(
        `INSERT INTO memories 
         (id, content, summary, source_path, memory_type, importance_score, created_at, updated_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.content,
        memory.summary ?? null,
        memory.sourcePath ?? null,
        memory.memoryType,
        memory.importanceScore,
        memory.createdAt,
        memory.updatedAt,
        memory.accessCount,
      );

    // Add tags if provided
    if (input.tags && input.tags.length > 0) {
      this.setMemoryTags(id, input.tags);
    }

    log.debug("Created structured memory", { id, type: memory.memoryType });
    return memory;
  }

  /**
   * Get a memory by ID.
   */
  getMemory(id: string): MemoryEntry | null {
    const row = this.db
      .prepare(
        `SELECT id, content, summary, source_path, memory_type, importance_score,
                created_at, updated_at, accessed_at, access_count, compressed_from
         FROM memories WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          content: string;
          summary: string | null;
          source_path: string | null;
          memory_type: MemoryType;
          importance_score: number;
          created_at: number;
          updated_at: number;
          accessed_at: number | null;
          access_count: number;
          compressed_from: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      content: row.content,
      summary: row.summary ?? undefined,
      sourcePath: row.source_path ?? undefined,
      memoryType: row.memory_type,
      importanceScore: row.importance_score,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessedAt: row.accessed_at ?? undefined,
      accessCount: row.access_count,
      compressedFrom: row.compressed_from ?? undefined,
    };
  }

  /**
   * Update a memory entry.
   */
  updateMemory(id: string, input: UpdateMemoryInput): MemoryEntry | null {
    const existing = this.getMemory(id);
    if (!existing) return null;

    const now = Math.floor(Date.now() / 1000);
    const content = input.content ?? existing.content;
    const summary = input.summary ?? existing.summary;
    const importanceScore = input.importanceScore ?? existing.importanceScore;

    this.db
      .prepare(
        `UPDATE memories 
         SET content = ?, summary = ?, importance_score = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(content, summary ?? null, importanceScore, now, id);

    if (input.tags !== undefined) {
      this.setMemoryTags(id, input.tags);
    }

    return this.getMemory(id);
  }

  /**
   * Delete a memory entry.
   */
  deleteMemory(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Record an access to a memory for importance tracking.
   */
  recordAccess(memoryId: string, query?: string): void {
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(`INSERT INTO memory_access_log (memory_id, accessed_at, query) VALUES (?, ?, ?)`)
      .run(memoryId, now, query ?? null);

    this.db
      .prepare(
        `UPDATE memories 
         SET access_count = access_count + 1, accessed_at = ?
         WHERE id = ?`,
      )
      .run(now, memoryId);
  }

  /**
   * Get tags for a memory.
   */
  getMemoryTags(memoryId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name FROM tags t
         JOIN memory_tags mt ON t.id = mt.tag_id
         WHERE mt.memory_id = ?`,
      )
      .all(memoryId) as Array<{ name: string }>;

    return rows.map((r) => r.name);
  }

  /**
   * Set tags for a memory (replaces existing tags).
   */
  setMemoryTags(memoryId: string, tagNames: string[]): void {
    // Remove existing tags
    this.db.prepare(`DELETE FROM memory_tags WHERE memory_id = ?`).run(memoryId);

    // Add new tags
    for (const tagName of tagNames) {
      const tagId = this.getOrCreateTag(tagName);
      this.db
        .prepare(`INSERT INTO memory_tags (memory_id, tag_id) VALUES (?, ?)`)
        .run(memoryId, tagId);
    }
  }

  /**
   * Get or create a tag.
   */
  getOrCreateTag(name: string): number {
    const existing = this.db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;

    const result = this.db.prepare(`INSERT INTO tags (name) VALUES (?)`).run(name);
    return result.lastInsertRowid as number;
  }

  /**
   * Search memories with filters.
   */
  searchMemories(params: {
    query?: string;
    filters?: MemorySearchFilters;
    limit?: number;
    offset?: number;
  }): StructuredMemorySearchResult[] {
    const { query, filters, limit = 10, offset = 0 } = params;

    let sql = `SELECT DISTINCT m.id, m.content, m.summary, m.source_path, m.memory_type,
                m.importance_score, m.created_at, m.updated_at, m.accessed_at, m.access_count
               FROM memories m`;
    const whereConditions: string[] = [];
    const args: (string | number)[] = [];

    // Add FTS join if text query provided
    if (query) {
      sql += ` JOIN memories_fts fts ON m.id = fts.rowid`;
      whereConditions.push(`memories_fts MATCH ?`);
      args.push(query);
    }

    // Add tag join if tag filter provided
    if (filters?.tags && filters.tags.length > 0) {
      sql += ` JOIN memory_tags mt ON m.id = mt.memory_id
               JOIN tags t ON mt.tag_id = t.id`;
      whereConditions.push(`t.name IN (${filters.tags.map(() => "?").join(",")})`);
      args.push(...filters.tags);
    }

    // Add type filter
    if (filters?.memoryType) {
      whereConditions.push(`m.memory_type = ?`);
      args.push(filters.memoryType);
    }

    // Add importance filter
    if (filters?.minImportance !== undefined) {
      whereConditions.push(`m.importance_score >= ?`);
      args.push(filters.minImportance);
    }

    // Add date filters
    if (filters?.createdAfter) {
      whereConditions.push(`m.created_at >= ?`);
      args.push(filters.createdAfter);
    }
    if (filters?.createdBefore) {
      whereConditions.push(`m.created_at <= ?`);
      args.push(filters.createdBefore);
    }

    if (whereConditions.length > 0) {
      sql += ` WHERE ${whereConditions.join(" AND ")}`;
    }

    // Order by importance and recency
    sql += ` ORDER BY m.importance_score DESC, m.accessed_at DESC NULLS LAST, m.created_at DESC`;
    sql += ` LIMIT ? OFFSET ?`;
    args.push(limit, offset);

    const rows = this.db.prepare(sql).all(...args) as Array<{
      id: string;
      content: string;
      summary: string | null;
      source_path: string | null;
      memory_type: MemoryType;
      importance_score: number;
      created_at: number;
      updated_at: number;
      accessed_at: number | null;
      access_count: number;
    }>;

    return rows.map((row) => ({
      memory: {
        id: row.id,
        content: row.content,
        summary: row.summary ?? undefined,
        sourcePath: row.source_path ?? undefined,
        memoryType: row.memory_type,
        importanceScore: row.importance_score,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        accessedAt: row.accessed_at ?? undefined,
        accessCount: row.access_count,
      },
      tags: this.getMemoryTags(row.id),
      relevanceScore: row.importance_score,
    }));
  }

  /**
   * Get memories that need compression (old, frequently accessed notes).
   */
  getMemoriesForCompression(params: {
    olderThanDays: number;
    minAccessCount?: number;
    limit?: number;
  }): MemoryEntry[] {
    const { olderThanDays, minAccessCount = 1, limit = 100 } = params;
    const cutoffTime = Math.floor(Date.now() / 1000) - olderThanDays * 24 * 60 * 60;

    const rows = this.db
      .prepare(
        `SELECT id FROM memories 
         WHERE memory_type = 'note'
         AND created_at < ?
         AND access_count >= ?
         ORDER BY access_count DESC, created_at ASC
         LIMIT ?`,
      )
      .all(cutoffTime, minAccessCount, limit) as Array<{ id: string }>;

    return rows.map((r) => this.getMemory(r.id)!).filter(Boolean);
  }

  /**
   * Get statistics about the memory store.
   */
  getStats(): {
    totalMemories: number;
    byType: Record<MemoryType, number>;
    totalTags: number;
    avgImportance: number;
    oldestMemory?: number;
    newestMemory?: number;
  } {
    const totalResult = this.db.prepare(`SELECT COUNT(*) as count FROM memories`).get() as {
      count: number;
    };

    const byTypeResult = this.db
      .prepare(`SELECT memory_type, COUNT(*) as count FROM memories GROUP BY memory_type`)
      .all() as Array<{ memory_type: MemoryType; count: number }>;

    const tagsResult = this.db.prepare(`SELECT COUNT(*) as count FROM tags`).get() as {
      count: number;
    };

    const importanceResult = this.db
      .prepare(`SELECT AVG(importance_score) as avg FROM memories`)
      .get() as { avg: number | null };

    const dateRangeResult = this.db
      .prepare(`SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memories`)
      .get() as { oldest: number | null; newest: number | null };

    const byType: Record<MemoryType, number> = {
      note: 0,
      summary: 0,
      archive: 0,
      session: 0,
    };
    for (const row of byTypeResult) {
      byType[row.memory_type] = row.count;
    }

    return {
      totalMemories: totalResult.count,
      byType,
      totalTags: tagsResult.count,
      avgImportance: importanceResult.avg ?? 0,
      oldestMemory: dateRangeResult.oldest ?? undefined,
      newestMemory: dateRangeResult.newest ?? undefined,
    };
  }
}
