import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry, MemoryType } from "./schema.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { StructuredMemoryStore } from "./store.js";

const log = createSubsystemLogger("memory-compression");

export type CompressionConfig = {
  enabled: boolean;
  dailyToWeeklyDays: number;
  weeklyToMonthlyDays: number;
  archiveAfterDays: number;
  minAccessCountForCompression: number;
  summaryMaxLength: number;
};

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  enabled: true,
  dailyToWeeklyDays: 7,
  weeklyToMonthlyDays: 30,
  archiveAfterDays: 90,
  minAccessCountForCompression: 1,
  summaryMaxLength: 500,
};

/**
 * Service for compressing and summarizing old memories.
 * Uses LLM-based summarization to reduce memory store size while preserving important information.
 */
export class MemoryCompressionService {
  private store: StructuredMemoryStore;
  private config: CompressionConfig;

  constructor(db: DatabaseSync, config?: Partial<CompressionConfig>) {
    this.store = new StructuredMemoryStore(db);
    this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...config };
  }

  /**
   * Run compression on old memories.
   * Returns summary of what was compressed.
   */
  async compress(): Promise<{
    weeklySummariesCreated: number;
    monthlySummariesCreated: number;
    archivedCount: number;
  }> {
    if (!this.config.enabled) {
      return { weeklySummariesCreated: 0, monthlySummariesCreated: 0, archivedCount: 0 };
    }

    log.info("Starting memory compression");

    const weeklyResult = await this.compressDailyToWeekly();
    const monthlyResult = await this.compressWeeklyToMonthly();
    const archiveResult = await this.archiveOldMemories();

    log.info("Memory compression complete", {
      weekly: weeklyResult.created,
      monthly: monthlyResult.created,
      archived: archiveResult.archived,
    });

    return {
      weeklySummariesCreated: weeklyResult.created,
      monthlySummariesCreated: monthlyResult.created,
      archivedCount: archiveResult.archived,
    };
  }

  /**
   * Compress daily notes into weekly summaries.
   */
  private async compressDailyToWeekly(): Promise<{ created: number }> {
    const memories = this.store.getMemoriesForCompression({
      olderThanDays: this.config.dailyToWeeklyDays,
      minAccessCount: this.config.minAccessCountForCompression,
      limit: 50,
    });

    // Group by week
    const byWeek = this.groupByWeek(memories);
    let created = 0;

    for (const [weekKey, weekMemories] of Object.entries(byWeek)) {
      if (weekMemories.length < 2) continue; // Skip if only one memory

      const summary = await this.summarizeMemories(weekMemories, `Week of ${weekKey}`);
      if (summary) {
        this.store.createMemory({
          content: summary,
          memoryType: "summary",
          summary: `Weekly summary covering ${weekMemories.length} memories`,
          importanceScore: this.calculateAggregateImportance(weekMemories),
          tags: ["weekly-summary", "auto-compressed"],
        });

        // Mark original memories as compressed
        for (const memory of weekMemories) {
          this.store.updateMemory(memory.id, {
            content: `[Compressed into weekly summary] ${memory.content.substring(0, 100)}...`,
          });
        }

        created++;
      }
    }

    return { created };
  }

  /**
   * Compress weekly summaries into monthly summaries.
   */
  private async compressWeeklyToMonthly(): Promise<{ created: number }> {
    // Get weekly summaries older than threshold
    const weeklies = this.store.searchMemories({
      filters: { memoryType: "summary" },
      limit: 100,
    });

    const oldWeeklies = weeklies.filter(
      (r) =>
        r.memory.createdAt < Date.now() / 1000 - this.config.weeklyToMonthlyDays * 24 * 60 * 60,
    );

    // Group by month
    const byMonth = this.groupByMonth(oldWeeklies.map((r) => r.memory));
    let created = 0;

    for (const [monthKey, monthMemories] of Object.entries(byMonth)) {
      if (monthMemories.length < 2) continue;

      const summary = await this.summarizeMemories(monthMemories, `Month: ${monthKey}`);
      if (summary) {
        this.store.createMemory({
          content: summary,
          memoryType: "summary",
          summary: `Monthly summary covering ${monthMemories.length} weekly summaries`,
          importanceScore: this.calculateAggregateImportance(monthMemories),
          tags: ["monthly-summary", "auto-compressed"],
        });

        // Delete old weekly summaries (they're now in the monthly)
        for (const memory of monthMemories) {
          this.store.deleteMemory(memory.id);
        }

        created++;
      }
    }

    return { created };
  }

  /**
   * Archive cold memories (rarely accessed, old).
   */
  private async archiveOldMemories(): Promise<{ archived: number }> {
    const oldMemories = this.store.getMemoriesForCompression({
      olderThanDays: this.config.archiveAfterDays,
      minAccessCount: 0,
      limit: 100,
    });

    let archived = 0;
    for (const memory of oldMemories) {
      if (memory.memoryType === "archive") continue; // Already archived

      this.store.updateMemory(memory.id, {
        content: `[ARCHIVED] ${memory.content}`,
      });

      // Update type to archive
      this.store["db"]
        .prepare(`UPDATE memories SET memory_type = 'archive' WHERE id = ?`)
        .run(memory.id);

      archived++;
    }

    return { archived };
  }

  /**
   * Summarize a set of memories using LLM.
   * This is a placeholder - in real implementation, would call the agent's LLM.
   */
  private async summarizeMemories(
    memories: MemoryEntry[],
    context: string,
  ): Promise<string | null> {
    // For now, create a simple concatenation summary
    // In real implementation, this would call the LLM to generate a proper summary
    const combined = memories.map((m) => m.content).join("\n\n---\n\n");

    if (combined.length <= this.config.summaryMaxLength) {
      return combined;
    }

    // Simple truncation-based summary (placeholder for LLM summarization)
    const keyPoints = memories
      .map((m) => `- ${m.content.substring(0, 100)}${m.content.length > 100 ? "..." : ""}`)
      .join("\n");

    return `Summary of ${context}:\n\n${keyPoints}`;
  }

  /**
   * Group memories by week (YYYY-WW format).
   */
  private groupByWeek(memories: MemoryEntry[]): Record<string, MemoryEntry[]> {
    const groups: Record<string, MemoryEntry[]> = {};

    for (const memory of memories) {
      const date = new Date(memory.createdAt * 1000);
      const year = date.getFullYear();
      const week = this.getWeekNumber(date);
      const key = `${year}-W${week.toString().padStart(2, "0")}`;

      if (!groups[key]) groups[key] = [];
      groups[key].push(memory);
    }

    return groups;
  }

  /**
   * Group memories by month (YYYY-MM format).
   */
  private groupByMonth(memories: MemoryEntry[]): Record<string, MemoryEntry[]> {
    const groups: Record<string, MemoryEntry[]> = {};

    for (const memory of memories) {
      const date = new Date(memory.createdAt * 1000);
      const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`;

      if (!groups[key]) groups[key] = [];
      groups[key].push(memory);
    }

    return groups;
  }

  /**
   * Get ISO week number.
   */
  private getWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  /**
   * Calculate aggregate importance score for a group of memories.
   */
  private calculateAggregateImportance(memories: MemoryEntry[]): number {
    if (memories.length === 0) return 0.5;
    const avg = memories.reduce((sum, m) => sum + m.importanceScore, 0) / memories.length;
    // Boost importance slightly for compressed memories
    return Math.min(1, avg * 1.1);
  }
}
