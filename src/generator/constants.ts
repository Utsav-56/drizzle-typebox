import type { QueryMode } from "./types";

export const DEFAULT_OUT_DIR = "./src/generated/schemas";
export const DEFAULT_TYPEBOX_IMPORT = "@utsav56/typebox";

export const QUERY_MODES: readonly QueryMode[] = [
  "select",
  "insert",
  "update",
] as const;

export const CALL_NAME_TO_MODE: Record<string, QueryMode> = {
  createSelectConfig: "select",
  createInsertConfig: "insert",
  createUpdateConfig: "update",
};

export const IGNORED_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
]);

export const AUTO_GENERATED_HEADER =
  "// AUTO-GENERATED FILE BY DRIZZLE-TYPEBOX GENERATOR — DO NOT EDIT MANUALLY";
