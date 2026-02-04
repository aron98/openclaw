import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd" | "structured";
export type MemoryCitationsMode = "auto" | "on" | "off";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  structured?: StructuredMemoryConfig;
};

// Structured memory store configuration
export type StructuredMemoryConfig = {
  enabled?: boolean;
  sync?: {
    markdown?: boolean;
    bidirectional?: boolean;
    debounceMs?: number;
    watchFiles?: boolean;
  };
  compression?: {
    enabled?: boolean;
    dailyToWeekly?: string; // Duration like "7d"
    weeklyToMonthly?: string; // Duration like "30d"
    archiveAfter?: string; // Duration like "90d"
    minMemoriesForSummary?: number;
  };
  importance?: {
    enabled?: boolean;
    decayFactor?: number;
    accessBoost?: number;
    recencyBoost?: number;
    manualBoost?: number;
  };
  query?: {
    importanceWeight?: number;
    recencyWeight?: number;
    defaultLimit?: number;
  };
};

export type MemoryQmdConfig = {
  command?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  embedInterval?: string;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
