// Structured memory backend integration
// Connects the structured memory store to OpenClaw's memory tool system

import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
  MemoryEmbeddingProbeResult,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { MemoryCompressionEngine } from "./compression-engine.js";
import { MarkdownSyncManager } from "./markdown-sync.js";
import { requireNodeSqlite } from "./sqlite.js";
import {
  StructuredMemoryStore,
  ensureStructuredMemorySchema,
  type StructuredMemory,
  type MemoryType,
} from "./structured-store.js";

const log = createSubsystemLogger("structured-memory-backend");

export interface StructuredMemoryBackendConfig {
  dbPath: string;
  workspaceDir: string;
  agentId: string;
  config: OpenClawConfig;
  memorySearchConfig: ResolvedMemorySearchConfig;
}

/**
 * Structured memory backend that implements MemorySearchManager interface
 * This allows it to be used as a drop-in replacement for the existing memory system
 */
export class StructuredMemoryBackend implements MemorySearchManager {
  private store: StructuredMemoryStore;
  private syncManager: MarkdownSyncManager;
  private compressionEngine: MemoryCompressionEngine;
  private db: DatabaseSync;
  private config: OpenClawConfig;
  private agentId: string;
  private workspaceDir: string;
  private closed = false;

  constructor(params: StructuredMemoryBackendConfig) {
    this.config = params.config;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;

    // Open database
    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(params.dbPath);

    // Ensure schema
    ensureStructuredMemorySchema(this.db);

    // Get structured memory config
    const structuredConfig = params.config.memory?.structured ?? {};

    // Initialize store
    this.store = new StructuredMemoryStore({
      db: this.db,
      config: structuredConfig,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
    });

    // Initialize sync manager
    this.syncManager = new MarkdownSyncManager({
      store: this.store,
      workspaceDir: params.workspaceDir,
      config: {
        enabled: structuredConfig.sync?.markdown ?? true,
        bidirectional: structuredConfig.sync?.bidirectional ?? true,
        debounceMs: structuredConfig.sync?.debounceMs ?? 1500,
        watchFiles: structuredConfig.sync?.watchFiles ?? true,
      },
      db: this.db,
    });

    // Initialize compression engine
    this.compressionEngine = new MemoryCompressionEngine({
      store: this.store,
      config: structuredConfig,
    });

    // Initial sync
    this.syncManager.syncFromMarkdown().catch((err) => {
      log.error("Initial sync failed", { error: String(err) });
    });
  }

  /**
   * Search memories using structured store
   */
  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    if (this.closed) {
      return [];
    }

    const maxResults = opts?.maxResults ?? 10;

    // Record search in access log
    this.store.recordAccess("search-query", "search", query);

    // Search structured memories
    const memories = this.store.searchMemories({
      query,
      limit: maxResults,
      orderBy: "relevance",
    });

    // Convert to MemorySearchResult format
    const results: MemorySearchResult[] = memories.map((memory, index) => {
      // Calculate a score based on importance and recency
      const score = this.calculateRelevanceScore(memory, query);

      // Extract snippet
      const snippet = this.extractSnippet(memory.content, query);

      // Determine line range (approximate)
      const lines = memory.content.split("\n");

      return {
        path: memory.sourcePath,
        startLine: 1,
        endLine: Math.min(lines.length, 20),
        score,
        snippet,
        source: "memory",
      };
    });

    // Sort by score
    results.sort((a, b) => b.score - a.score);

    // Take top results
    return results.slice(0, maxResults);
  }

  /**
   * Read a memory file
   */
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    if (this.closed) {
      return { text: "", path: params.relPath };
    }

    // Search for memories from this path
    const memories = this.store.searchMemories({
      query: undefined,
      limit: 100,
    });

    // Filter to matching path
    const matchingMemories = memories.filter((m) => m.sourcePath === params.relPath);

    if (matchingMemories.length === 0) {
      // Fall back to reading from filesystem
      return this.readFromFilesystem(params);
    }

    // Record access
    for (const memory of matchingMemories) {
      this.store.recordAccess(memory.id, "read");
    }

    // Combine memories into single text
    const text = matchingMemories.map((m) => m.content).join("\n\n---\n\n");

    // Apply line range if specified
    let finalText = text;
    if (params.from !== undefined || params.lines !== undefined) {
      const lines = text.split("\n");
      const start = (params.from ?? 1) - 1;
      const end = params.lines !== undefined ? start + params.lines : lines.length;
      finalText = lines.slice(start, end).join("\n");
    }

    return { text: finalText, path: params.relPath };
  }

  /**
   * Get status of the structured memory backend
   */
  status(): MemoryProviderStatus {
    const tags = this.store.getAllTags();

    return {
      backend: "builtin", // Report as builtin for compatibility
      provider: "structured",
      files: this.getMemoryCount(),
      chunks: this.getMemoryCount(),
      workspaceDir: this.workspaceDir,
      custom: {
        structuredEnabled: true,
        tagCount: tags.length,
        topTags: tags.slice(0, 5).map((t) => t.name),
      },
    };
  }

  /**
   * Sync memories (trigger sync from markdown)
   */
  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }

    log.debug("Starting sync", { reason: params?.reason });

    const result = await this.syncManager.syncFromMarkdown();

    if (params?.progress) {
      params.progress({
        completed: result.added + result.updated + result.unchanged,
        total: result.added + result.updated + result.removed + result.unchanged,
        label: `Sync: ${result.added} added, ${result.updated} updated, ${result.removed} removed`,
      });
    }

    // Run compression after sync
    await this.compressionEngine.compress();

    // Recalculate importance scores
    this.store.recalculateImportance();

    log.debug("Sync complete", result);
  }

  /**
   * Close the backend and release resources
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.syncManager.stopWatching();
    this.db.close();

    log.debug("Structured memory backend closed");
  }

  /**
   * Probe embedding availability (not used in structured backend)
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true }; // Structured backend doesn't require embeddings
  }

  /**
   * Probe vector availability (not used in structured backend)
   */
  async probeVectorAvailability(): Promise<boolean> {
    return false; // Structured backend uses full-text search, not vectors
  }

  /**
   * Get total memory count
   */
  private getMemoryCount(): number {
    const result = this.db.prepare("SELECT COUNT(*) as count FROM structured_memories").get() as {
      count: number;
    };
    return result.count;
  }

  /**
   * Calculate relevance score for a memory
   */
  private calculateRelevanceScore(memory: StructuredMemory, query: string): number {
    const structuredConfig = this.config.memory?.structured ?? {};
    const importanceWeight = structuredConfig.query?.importanceWeight ?? 0.3;
    const recencyWeight = structuredConfig.query?.recencyWeight ?? 0.2;

    // Base score from importance
    let score = memory.importanceScore * importanceWeight;

    // Recency boost
    const ageInDays = (Date.now() - memory.createdAt) / (24 * 60 * 60 * 1000);
    const recencyScore = Math.max(0, 1 - ageInDays / 30) * recencyWeight;
    score += recencyScore;

    // Text match score (simple)
    const queryWords = query.toLowerCase().split(/\s+/);
    const contentLower = memory.content.toLowerCase();
    let matchCount = 0;
    for (const word of queryWords) {
      if (contentLower.includes(word)) {
        matchCount++;
      }
    }
    const textScore = (matchCount / queryWords.length) * (1 - importanceWeight - recencyWeight);
    score += textScore;

    return Math.min(1, Math.max(0, score));
  }

  /**
   * Extract snippet around query match
   */
  private extractSnippet(content: string, query: string): string {
    const maxSnippetLength = 700;

    if (content.length <= maxSnippetLength) {
      return content;
    }

    // Find query match position
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    const matchIndex = contentLower.indexOf(queryLower);

    if (matchIndex === -1) {
      // No match, return beginning
      return content.slice(0, maxSnippetLength) + "...";
    }

    // Extract context around match
    const contextBefore = 200;
    const contextAfter = maxSnippetLength - contextBefore;

    const start = Math.max(0, matchIndex - contextBefore);
    const end = Math.min(content.length, matchIndex + query.length + contextAfter);

    let snippet = content.slice(start, end);

    if (start > 0) {
      snippet = "..." + snippet;
    }
    if (end < content.length) {
      snippet = snippet + "...";
    }

    return snippet;
  }

  /**
   * Read file from filesystem (fallback)
   */
  private async readFromFilesystem(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const fs = await import("node:fs/promises");
    const absPath = path.join(this.workspaceDir, params.relPath);

    try {
      let content = await fs.readFile(absPath, "utf-8");

      // Apply line range
      if (params.from !== undefined || params.lines !== undefined) {
        const lines = content.split("\n");
        const start = (params.from ?? 1) - 1;
        const end = params.lines !== undefined ? start + params.lines : lines.length;
        content = lines.slice(start, end).join("\n");
      }

      return { text: content, path: params.relPath };
    } catch (err) {
      return { text: "", path: params.relPath };
    }
  }
}
