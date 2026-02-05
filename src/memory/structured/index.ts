export { StructuredMemoryStore } from "./store.js";
export { MemoryCompressionService, DEFAULT_COMPRESSION_CONFIG } from "./compression.js";
export {
  ensureStructuredMemorySchema,
  type MemoryEntry,
  type MemoryTag,
  type MemoryAccessLog,
  type MemoryType,
  type MemorySearchFilters,
} from "./schema.js";
export type {
  StructuredMemorySearchResult,
  CreateMemoryInput,
  UpdateMemoryInput,
} from "./store.js";
export type { CompressionConfig } from "./compression.js";
