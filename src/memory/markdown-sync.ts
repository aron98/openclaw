import type { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";
// Sync layer between markdown files and structured memory store
import fs from "node:fs/promises";
import path from "node:path";
import type { StructuredMemoryStore, StructuredMemory, MemoryType } from "./structured-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listMemoryFiles, buildFileEntry, type MemoryFileEntry } from "./internal.js";

const log = createSubsystemLogger("memory-sync");

export interface MarkdownSyncConfig {
  enabled: boolean;
  bidirectional: boolean;
  debounceMs: number;
  watchFiles: boolean;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

/**
 * Manages synchronization between markdown files and structured memory store
 */
export class MarkdownSyncManager {
  private store: StructuredMemoryStore;
  private workspaceDir: string;
  private config: MarkdownSyncConfig;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private db: DatabaseSync;

  constructor(params: {
    store: StructuredMemoryStore;
    workspaceDir: string;
    config: MarkdownSyncConfig;
    db: DatabaseSync;
  }) {
    this.store = params.store;
    this.workspaceDir = params.workspaceDir;
    this.config = params.config;
    this.db = params.db;

    if (this.config.watchFiles) {
      this.startWatching();
    }
  }

  /**
   * Start watching markdown files for changes
   */
  private startWatching(): void {
    const memoryDir = path.join(this.workspaceDir, "memory");
    const memoryFile = path.join(this.workspaceDir, "MEMORY.md");

    this.watcher = chokidar.watch([memoryFile, memoryDir], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });

    this.watcher.on("add", () => this.scheduleSync());
    this.watcher.on("change", () => this.scheduleSync());
    this.watcher.on("unlink", () => this.scheduleSync());

    log.debug("Started watching markdown files", { memoryDir, memoryFile });
  }

  /**
   * Schedule a sync with debouncing
   */
  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.syncFromMarkdown().catch((err) => {
        log.error("Scheduled sync failed", { error: String(err) });
      });
    }, this.config.debounceMs);
  }

  /**
   * Stop watching files
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Sync all markdown files to structured store
   */
  async syncFromMarkdown(): Promise<SyncResult> {
    if (!this.config.enabled) {
      return { added: 0, updated: 0, removed: 0, unchanged: 0 };
    }

    const result: SyncResult = { added: 0, updated: 0, removed: 0, unchanged: 0 };

    // Get all markdown files
    const files = await listMemoryFiles(this.workspaceDir);
    const fileEntries = await Promise.all(
      files.map((file) => buildFileEntry(file, this.workspaceDir)),
    );

    // Get existing structured memories
    const existingPaths = this.getExistingSourcePaths();

    // Process each file
    const currentPaths = new Set<string>();
    for (const entry of fileEntries) {
      currentPaths.add(entry.path);
      const syncResult = await this.syncFile(entry);
      result[syncResult]++;
    }

    // Remove memories for deleted files
    for (const existingPath of existingPaths) {
      if (!currentPaths.has(existingPath)) {
        this.removeMemoriesForPath(existingPath);
        result.removed++;
      }
    }

    log.debug("Sync from markdown complete", result);
    return result;
  }

  /**
   * Sync a single file to structured store
   */
  private async syncFile(entry: MemoryFileEntry): Promise<"added" | "updated" | "unchanged"> {
    // Check if we already have this file
    const existing = this.getMemoryBySourcePath(entry.path);

    if (existing && existing.updatedAt >= entry.mtimeMs) {
      return "unchanged";
    }

    // Parse the markdown content
    const content = await fs.readFile(entry.absPath, "utf-8");
    const sections = this.parseMarkdownSections(content, entry.path);

    if (existing) {
      // Update existing memories
      for (const section of sections) {
        const existingSection = this.findSectionByContent(existing, section.content);
        if (existingSection) {
          // Update
          this.store.updateMemory(existingSection.id, {
            content: section.content,
            memoryType: section.memoryType,
          });
        } else {
          // New section
          this.store.createMemory({
            content: section.content,
            sourcePath: entry.path,
            memoryType: section.memoryType,
            importanceLevel: "medium",
            importanceScore: 0.5,
            tags: section.tags,
          });
        }
      }
      return "updated";
    } else {
      // Create new memories
      for (const section of sections) {
        this.store.createMemory({
          content: section.content,
          sourcePath: entry.path,
          memoryType: section.memoryType,
          importanceLevel: "medium",
          importanceScore: 0.5,
          tags: section.tags,
        });
      }
      return "added";
    }
  }

  /**
   * Parse markdown content into sections
   */
  private parseMarkdownSections(
    content: string,
    sourcePath: string,
  ): Array<{
    content: string;
    memoryType: MemoryType;
    tags: string[];
  }> {
    const sections: Array<{ content: string; memoryType: MemoryType; tags: string[] }> = [];

    // Simple heuristic: split by headers (## or ###)
    // Each section becomes a memory
    const lines = content.split("\n");
    let currentSection: string[] = [];
    let currentTags: string[] = [];
    let currentType: MemoryType = "note";

    const flushSection = () => {
      if (currentSection.length > 0) {
        const sectionContent = currentSection.join("\n").trim();
        if (sectionContent.length > 50) {
          sections.push({
            content: sectionContent,
            memoryType: currentType,
            tags: currentTags,
          });
        }
      }
      currentSection = [];
    };

    for (const line of lines) {
      // Check for headers
      if (line.startsWith("## ") || line.startsWith("### ")) {
        flushSection();
        currentTags = this.extractTagsFromHeader(line);
        currentType = this.inferMemoryType(line, sourcePath);
      }
      currentSection.push(line);
    }

    flushSection();

    // If no sections found, treat entire content as one memory
    if (sections.length === 0 && content.trim().length > 50) {
      sections.push({
        content: content.trim(),
        memoryType: this.inferMemoryType("", sourcePath),
        tags: [],
      });
    }

    return sections;
  }

  /**
   * Extract tags from header text
   */
  private extractTagsFromHeader(header: string): string[] {
    const tags: string[] = [];
    const tagMatch = header.match(/#(\w+)/g);
    if (tagMatch) {
      tags.push(...tagMatch.map((t) => t.slice(1)));
    }
    return tags;
  }

  /**
   * Infer memory type from content and path
   */
  private inferMemoryType(header: string, sourcePath: string): MemoryType {
    const lower = header.toLowerCase();

    if (lower.includes("decision") || lower.includes("decided")) return "decision";
    if (lower.includes("todo") || lower.includes("task")) return "todo";
    if (lower.includes("preference") || lower.includes("like")) return "preference";
    if (lower.includes("summary") || lower.includes("overview")) return "summary";
    if (sourcePath.includes("archive")) return "archive";

    return "note";
  }

  /**
   * Get all source paths currently in the structured store
   */
  private getExistingSourcePaths(): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT source_path FROM structured_memories`)
      .all() as Array<{ source_path: string }>;
    return new Set(rows.map((r) => r.source_path));
  }

  /**
   * Get memories by source path
   */
  private getMemoryBySourcePath(sourcePath: string): StructuredMemory | null {
    // This is a simplified version - in production, should handle multiple memories per file
    const row = this.db
      .prepare(`SELECT * FROM structured_memories WHERE source_path = ? LIMIT 1`)
      .get(sourcePath) as
      | {
          id: string;
          updated_at: number;
        }
      | undefined;

    if (!row) return null;
    return this.store.getMemory(row.id);
  }

  /**
   * Find existing section by content similarity
   */
  private findSectionByContent(
    existing: StructuredMemory,
    content: string,
  ): StructuredMemory | null {
    // Simple heuristic: if existing content is similar to new content
    const similarity = this.calculateSimilarity(existing.content, content);
    if (similarity > 0.7) {
      return existing;
    }
    return null;
  }

  /**
   * Calculate simple similarity between two strings
   */
  private calculateSimilarity(a: string, b: string): number {
    const aWords = new Set(a.toLowerCase().split(/\s+/));
    const bWords = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...aWords].filter((x) => bWords.has(x)));
    return intersection.size / Math.max(aWords.size, bWords.size);
  }

  /**
   * Remove all memories for a deleted file
   */
  private removeMemoriesForPath(sourcePath: string): void {
    this.db.prepare(`DELETE FROM structured_memories WHERE source_path = ?`).run(sourcePath);
    log.debug("Removed memories for deleted file", { sourcePath });
  }
}
