import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { MemoryCompressionService } from "../../memory/structured/compression.js";
import { StructuredMemoryStore } from "../../memory/structured/store.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { jsonResult, readStringParam, readNumberParam, readArrayParam } from "./common.js";

const CreateMemorySchema = Type.Object({
  content: Type.String({ description: "The memory content to store" }),
  summary: Type.Optional(Type.String({ description: "Optional summary of the memory" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags to categorize the memory" })),
  importance: Type.Optional(
    Type.Number({
      description: "Importance score from 0-1 (default 0.5)",
      minimum: 0,
      maximum: 1,
    }),
  ),
});

const SearchMemoriesSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Text search query" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags" })),
  type: Type.Optional(
    Type.String({ description: "Filter by memory type (note, summary, archive)" }),
  ),
  minImportance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  limit: Type.Optional(Type.Number({ default: 10 })),
});

const UpdateMemorySchema = Type.Object({
  id: Type.String({ description: "Memory ID to update" }),
  content: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const DeleteMemorySchema = Type.Object({
  id: Type.String({ description: "Memory ID to delete" }),
});

const GetMemorySchema = Type.Object({
  id: Type.String({ description: "Memory ID to retrieve" }),
});

function getStructuredMemoryStore(
  config: OpenClawConfig,
  agentId: string,
): StructuredMemoryStore | null {
  try {
    const agentDir = resolveAgentDir(config, agentId);
    const { DatabaseSync } = requireNodeSqlite();
    const dbPath = `${agentDir}/memory/structured.sqlite`;
    const db = new DatabaseSync(dbPath);
    return new StructuredMemoryStore(db);
  } catch (err) {
    return null;
  }
}

export function createStructuredMemoryCreateTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });

  return {
    label: "Structured Memory Create",
    name: "structured_memory_create",
    description:
      "Create a structured memory entry with metadata, tags, and importance scoring. Use this for important facts, decisions, or context that needs to be searchable and trackable.",
    parameters: CreateMemorySchema,
    execute: async (_toolCallId, params) => {
      const store = getStructuredMemoryStore(cfg, agentId);
      if (!store) {
        return jsonResult({ success: false, error: "Structured memory store not available" });
      }

      try {
        const content = readStringParam(params, "content", { required: true });
        const summary = readStringParam(params, "summary");
        const tags = readArrayParam(params, "tags") as string[] | undefined;
        const importance = readNumberParam(params, "importance");

        const memory = store.createMemory({
          content,
          summary: summary ?? undefined,
          tags,
          importanceScore: importance ?? undefined,
        });

        return jsonResult({
          success: true,
          memory: {
            id: memory.id,
            content: memory.content.substring(0, 200),
            tags: store.getMemoryTags(memory.id),
            importanceScore: memory.importanceScore,
            createdAt: memory.createdAt,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}

export function createStructuredMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });

  return {
    label: "Structured Memory Search",
    name: "structured_memory_search",
    description:
      "Search structured memories with filters for tags, importance, and memory type. Returns ranked results with metadata.",
    parameters: SearchMemoriesSchema,
    execute: async (_toolCallId, params) => {
      const store = getStructuredMemoryStore(cfg, agentId);
      if (!store) {
        return jsonResult({ results: [], disabled: true });
      }

      try {
        const query = readStringParam(params, "query") ?? undefined;
        const tags = readArrayParam(params, "tags") as string[] | undefined;
        const type = readStringParam(params, "type") as "note" | "summary" | "archive" | undefined;
        const minImportance = readNumberParam(params, "minImportance") ?? undefined;
        const limit = readNumberParam(params, "limit") ?? 10;

        const results = store.searchMemories({
          query,
          filters: {
            tags,
            memoryType: type,
            minImportance,
          },
          limit,
        });

        // Record access for importance tracking
        for (const result of results) {
          store.recordAccess(result.memory.id, query ?? undefined);
        }

        return jsonResult({
          results: results.map((r) => ({
            id: r.memory.id,
            content: r.memory.content.substring(0, 300),
            summary: r.memory.summary,
            tags: r.tags,
            importanceScore: r.memory.importanceScore,
            accessCount: r.memory.accessCount,
            memoryType: r.memory.memoryType,
            createdAt: r.memory.createdAt,
          })),
          total: results.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message });
      }
    },
  };
}

export function createStructuredMemoryUpdateTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });

  return {
    label: "Structured Memory Update",
    name: "structured_memory_update",
    description: "Update an existing structured memory entry by ID.",
    parameters: UpdateMemorySchema,
    execute: async (_toolCallId, params) => {
      const store = getStructuredMemoryStore(cfg, agentId);
      if (!store) {
        return jsonResult({ success: false, error: "Structured memory store not available" });
      }

      try {
        const id = readStringParam(params, "id", { required: true });
        const content = readStringParam(params, "content") ?? undefined;
        const summary = readStringParam(params, "summary") ?? undefined;
        const tags = readArrayParam(params, "tags") as string[] | undefined;
        const importance = readNumberParam(params, "importance") ?? undefined;

        const memory = store.updateMemory(id, {
          content,
          summary,
          tags,
          importanceScore: importance,
        });

        if (!memory) {
          return jsonResult({ success: false, error: "Memory not found" });
        }

        return jsonResult({
          success: true,
          memory: {
            id: memory.id,
            content: memory.content.substring(0, 200),
            updatedAt: memory.updatedAt,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}

export function createStructuredMemoryDeleteTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });

  return {
    label: "Structured Memory Delete",
    name: "structured_memory_delete",
    description: "Delete a structured memory entry by ID.",
    parameters: DeleteMemorySchema,
    execute: async (_toolCallId, params) => {
      const store = getStructuredMemoryStore(cfg, agentId);
      if (!store) {
        return jsonResult({ success: false, error: "Structured memory store not available" });
      }

      try {
        const id = readStringParam(params, "id", { required: true });
        const deleted = store.deleteMemory(id);

        return jsonResult({ success: deleted, id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ success: false, error: message });
      }
    },
  };
}

export function createStructuredMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });

  return {
    label: "Structured Memory Get",
    name: "structured_memory_get",
    description: "Retrieve a specific structured memory by ID with full content.",
    parameters: GetMemorySchema,
    execute: async (_toolCallId, params) => {
      const store = getStructuredMemoryStore(cfg, agentId);
      if (!store) {
        return jsonResult({ error: "Structured memory store not available" });
      }

      try {
        const id = readStringParam(params, "id", { required: true });
        const memory = store.getMemory(id);

        if (!memory) {
          return jsonResult({ error: "Memory not found" });
        }

        // Record access
        store.recordAccess(id);

        return jsonResult({
          memory: {
            id: memory.id,
            content: memory.content,
            summary: memory.summary,
            tags: store.getMemoryTags(id),
            importanceScore: memory.importanceScore,
            memoryType: memory.memoryType,
            accessCount: memory.accessCount,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            accessedAt: memory.accessedAt,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}

export function createStructuredMemoryStatsTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) return null;

  const agentId = resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg });

  return {
    label: "Structured Memory Stats",
    name: "structured_memory_stats",
    description: "Get statistics about the structured memory store.",
    parameters: Type.Object({}),
    execute: async () => {
      const store = getStructuredMemoryStore(cfg, agentId);
      if (!store) {
        return jsonResult({ error: "Structured memory store not available" });
      }

      try {
        const stats = store.getStats();
        return jsonResult({ stats });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}
