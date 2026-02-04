import type { StructuredMemoryConfig } from "../config/types.memory.js";
import type { StructuredMemoryStore, StructuredMemory, MemoryType } from "./structured-store.js";
// Memory compression engine - automatically summarize and compress old memories
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseDuration } from "./structured-store.js";

const log = createSubsystemLogger("memory-compression");

export interface CompressionResult {
  created: number;
  archived: number;
  errors: number;
}

export interface CompressionRule {
  name: string;
  sourceType: MemoryType | "all";
  targetType: MemoryType;
  minAge: number; // milliseconds
  minCount: number;
  compressionLevel: number;
  prompt: string;
}

/**
 * Engine for compressing memories through summarization
 */
export class MemoryCompressionEngine {
  private store: StructuredMemoryStore;
  private config: NonNullable<StructuredMemoryConfig["compression"]>;
  private importanceConfig: NonNullable<StructuredMemoryConfig["importance"]>;

  constructor(params: { store: StructuredMemoryStore; config: StructuredMemoryConfig }) {
    this.store = params.store;
    this.config = {
      enabled: true,
      dailyToWeekly: "7d",
      weeklyToMonthly: "30d",
      archiveAfter: "90d",
      minMemoriesForSummary: 5,
      ...params.config.compression,
    };
    this.importanceConfig = {
      enabled: true,
      decayFactor: 0.95,
      accessBoost: 0.05,
      recencyBoost: 0.1,
      manualBoost: 1.5,
      ...params.config.importance,
    };
  }

  /**
   * Run compression on all eligible memories
   */
  async compress(): Promise<CompressionResult> {
    if (!this.config.enabled) {
      return { created: 0, archived: 0, errors: 0 };
    }

    const result: CompressionResult = { created: 0, archived: 0, errors: 0 };

    try {
      // Daily → Weekly compression
      const weeklyResult = await this.compressToWeekly();
      result.created += weeklyResult.created;
      result.errors += weeklyResult.errors;

      // Weekly → Monthly compression
      const monthlyResult = await this.compressToMonthly();
      result.created += monthlyResult.created;
      result.errors += monthlyResult.errors;

      // Archive old memories
      const archiveResult = await this.archiveOldMemories();
      result.archived += archiveResult.archived;
      result.errors += archiveResult.errors;
    } catch (err) {
      log.error("Compression failed", { error: String(err) });
      result.errors++;
    }

    log.info("Compression complete", result);
    return result;
  }

  /**
   * Compress daily notes to weekly summaries
   */
  private async compressToWeekly(): Promise<{ created: number; errors: number }> {
    const minAge = parseDuration(this.config.dailyToWeekly!);
    const cutoff = Date.now() - minAge;

    const memories = this.store.getMemoriesForCompression({
      olderThan: cutoff,
      compressionLevel: 0,
      limit: 1000,
    });

    // Group by week
    const weeklyGroups = this.groupByWeek(memories);
    let created = 0;
    let errors = 0;

    for (const [weekKey, weekMemories] of weeklyGroups) {
      if (weekMemories.length < (this.config.minMemoriesForSummary ?? 5)) {
        continue;
      }

      try {
        const summary = await this.generateSummary(weekMemories, "weekly");
        if (summary) {
          this.store.createMemory({
            content: summary,
            sourcePath: `memory/summaries/week-${weekKey}.md`,
            memoryType: "summary",
            importanceLevel: this.calculateAverageImportance(weekMemories),
            importanceScore: Math.max(...weekMemories.map((m) => m.importanceScore)),
            tags: ["weekly-summary", "auto-generated"],
            compressedFrom: weekMemories.map((m) => m.id),
            compressionLevel: 1,
          });
          created++;

          // Mark originals as compressed
          for (const mem of weekMemories) {
            this.store.updateMemory(mem.id, {
              compressionLevel: 1,
            });
          }
        }
      } catch (err) {
        log.error("Failed to create weekly summary", { week: weekKey, error: String(err) });
        errors++;
      }
    }

    return { created, errors };
  }

  /**
   * Compress weekly summaries to monthly summaries
   */
  private async compressToMonthly(): Promise<{ created: number; errors: number }> {
    const minAge = parseDuration(this.config.weeklyToMonthly!);
    const cutoff = Date.now() - minAge;

    const memories = this.store.getMemoriesForCompression({
      olderThan: cutoff,
      compressionLevel: 1, // Already compressed to weekly
      limit: 1000,
    });

    // Group by month
    const monthlyGroups = this.groupByMonth(memories);
    let created = 0;
    let errors = 0;

    for (const [monthKey, monthMemories] of monthlyGroups) {
      if (monthMemories.length < 2) {
        continue;
      }

      try {
        const summary = await this.generateSummary(monthMemories, "monthly");
        if (summary) {
          this.store.createMemory({
            content: summary,
            sourcePath: `memory/summaries/month-${monthKey}.md`,
            memoryType: "summary",
            importanceLevel: "high",
            importanceScore: Math.max(...monthMemories.map((m) => m.importanceScore)),
            tags: ["monthly-summary", "auto-generated"],
            compressedFrom: monthMemories.map((m) => m.id),
            compressionLevel: 2,
          });
          created++;

          // Mark originals as compressed
          for (const mem of monthMemories) {
            this.store.updateMemory(mem.id, {
              compressionLevel: 2,
            });
          }
        }
      } catch (err) {
        log.error("Failed to create monthly summary", { month: monthKey, error: String(err) });
        errors++;
      }
    }

    return { created, errors };
  }

  /**
   * Archive very old memories
   */
  private async archiveOldMemories(): Promise<{ archived: number; errors: number }> {
    const minAge = parseDuration(this.config.archiveAfter!);
    const cutoff = Date.now() - minAge;

    const memories = this.store.getMemoriesForCompression({
      olderThan: cutoff,
      compressionLevel: 2, // Already compressed to monthly
      limit: 1000,
    });

    let archived = 0;
    let errors = 0;

    for (const memory of memories) {
      try {
        // Check if memory has been accessed recently
        if (memory.accessedAt && memory.accessedAt > cutoff) {
          continue; // Skip recently accessed memories
        }

        this.store.updateMemory(memory.id, {
          memoryType: "archive",
        });
        archived++;
      } catch (err) {
        log.error("Failed to archive memory", { id: memory.id, error: String(err) });
        errors++;
      }
    }

    return { archived, errors };
  }

  /**
   * Group memories by week
   */
  private groupByWeek(memories: StructuredMemory[]): Map<string, StructuredMemory[]> {
    const groups = new Map<string, StructuredMemory[]>();

    for (const memory of memories) {
      const date = new Date(memory.createdAt);
      const year = date.getFullYear();
      const week = this.getWeekNumber(date);
      const key = `${year}-W${week.toString().padStart(2, "0")}`;

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(memory);
    }

    return groups;
  }

  /**
   * Group memories by month
   */
  private groupByMonth(memories: StructuredMemory[]): Map<string, StructuredMemory[]> {
    const groups = new Map<string, StructuredMemory[]>();

    for (const memory of memories) {
      const date = new Date(memory.createdAt);
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const key = `${year}-${month}`;

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(memory);
    }

    return groups;
  }

  /**
   * Get ISO week number
   */
  private getWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((+d - +yearStart) / 86400000 + 1) / 7);
  }

  /**
   * Generate a summary from multiple memories
   * This is a placeholder - in production, this would use an LLM
   */
  private async generateSummary(
    memories: StructuredMemory[],
    level: "weekly" | "monthly",
  ): Promise<string | null> {
    // Collect all content
    const contents = memories.map((m) => m.content).join("\n\n---\n\n");

    // Simple heuristic summary (replace with LLM call in production)
    const lines = contents.split("\n");
    const headers = lines.filter((l) => l.startsWith("##") || l.startsWith("###"));

    let summary = `# ${level === "weekly" ? "Weekly" : "Monthly"} Summary\n\n`;
    summary += `Generated from ${memories.length} memories.\n\n`;

    if (headers.length > 0) {
      summary += "## Key Topics\n\n";
      for (const header of headers.slice(0, 10)) {
        summary += `- ${header.replace(/^#+\s*/, "")}\n`;
      }
    }

    // Extract important sentences (those with importance markers)
    const importantLines = lines.filter(
      (l) =>
        l.toLowerCase().includes("important") ||
        l.toLowerCase().includes("decision") ||
        l.toLowerCase().includes("conclusion") ||
        l.toLowerCase().includes("action item"),
    );

    if (importantLines.length > 0) {
      summary += "\n## Important Items\n\n";
      for (const line of importantLines.slice(0, 5)) {
        summary += `- ${line.trim()}\n`;
      }
    }

    return summary;
  }

  /**
   * Calculate average importance level
   */
  private calculateAverageImportance(
    memories: StructuredMemory[],
  ): "low" | "medium" | "high" | "critical" {
    const avgScore = memories.reduce((sum, m) => sum + m.importanceScore, 0) / memories.length;
    if (avgScore > 0.8) return "critical";
    if (avgScore > 0.6) return "high";
    if (avgScore > 0.4) return "medium";
    return "low";
  }
}
