import type { Column } from "drizzle-orm";
import type { QueryMode } from "./types";

const isAlreadyWrapped = (code: string, wrapperPrefix: string): boolean =>
  code.trimStart().startsWith(wrapperPrefix);

const isColumnOptional = (mode: QueryMode, col: Column): boolean => {
  if (mode === "update") return true;
  if (mode === "insert") return !col.notNull || col.hasDefault;
  return false;
};

/**
 * Applies `t.Nullable(...)` and `t.Optional(...)` without nested pyramids
 * or duplicate wrapping if the user refinement already included them.
 */
export const applyColumnModifiers = (
  baseCode: string,
  col: Column,
  mode: QueryMode,
): string => {
  const shouldBeNullable = !col.notNull;
  const shouldBeOptional = isColumnOptional(mode, col);

  let result = baseCode.trim();

  if (
    shouldBeNullable &&
    !isAlreadyWrapped(result, "t.Nullable(") &&
    !isAlreadyWrapped(result, "t.Optional(t.Nullable(")
  ) {
    result = `t.Nullable(${result})`;
  }

  if (shouldBeOptional && !isAlreadyWrapped(result, "t.Optional(")) {
    result = `t.Optional(${result})`;
  }

  return result;
};
