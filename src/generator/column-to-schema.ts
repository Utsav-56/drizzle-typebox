import type { Column } from "drizzle-orm";
import type { QueryMode } from "./types";

// Adjust this import path to your actual TypeBox file
import { $t, rawSchema } from "./rules";
import { MODE_OMIT_PATTERNS, NAME_RULES } from "./named_rules";

/**
 * Dialect-specific properties present on PgArray, PgVarchar, PgChar, etc.
 * Kept separate from `Column` so it never collides with Drizzle's base `Column` types.
 */
interface ColumnDialectExtras {
  readonly baseColumn?: Column;
  readonly size?: number;
  readonly length?: number;
}

const getDialectExtras = (col: Column): ColumnDialectExtras =>
  col as unknown as ColumnDialectExtras;

const COORDINATE_COL_TYPES = new Set([
  "PgPointTuple",
  "PgPointObject",
  "PgGeometry",
  "PgGeometryObject",
]);

const NUMERIC_STRING_COL_TYPES = new Set(["PgNumeric", "PgDecimal"]);
const FIXED_CHAR_COL_TYPES = new Set(["PgChar", "PgBpChar"]);

const resolveStringColumn = (col: Column, mode: QueryMode): string => {
  // `col.enumValues` is natively typed on Drizzle's `Column`
  if (Array.isArray(col.enumValues) && col.enumValues.length > 0) {
    return $t.OneOf(col.enumValues as [string, ...string[]]);
  }

  if (col.columnType === "PgUUID") return $t.Uuid();
  if (NUMERIC_STRING_COL_TYPES.has(col.columnType)) return $t.Numeric();

  const { length } = getDialectExtras(col);
  if (typeof length === "number" && mode !== "select") {
    return FIXED_CHAR_COL_TYPES.has(col.columnType)
      ? $t.FixedLengthString(length)
      : $t.String({ maxLength: length });
  }

  return $t.String();
};

const resolveArrayColumn = (col: Column, mode: QueryMode): string => {
  const { baseColumn, size } = getDialectExtras(col);
  const innerCode = baseColumn
    ? resolveFromDrizzleColumn(baseColumn, mode)
    : $t.Unknown();

  const innerToken = rawSchema(innerCode);

  return typeof size === "number"
    ? $t.FixedSizeArray(innerToken, size)
    : $t.Array(innerToken);
};

const DATA_TYPE_RESOLVERS: Record<
  string,
  (col: Column, mode: QueryMode) => string
> = {
  number: () => $t.Numeric(),
  bigint: () => $t.Numeric(),
  boolean: () => $t.Boolean(),
  date: () => $t.DateTime(),
  json: () => $t.Any(),
  custom: () => $t.Any(),
  buffer: () => $t.Any(),
  array: resolveArrayColumn,
  string: resolveStringColumn,
};

export const shouldOmitColumn = (
  colName: string,
  col: Column,
  mode: QueryMode,
  excludedColumns: Set<string>,
): boolean => {
  if (excludedColumns.has(colName)) return true;

  // `col.primary`, `col.hasDefault`, and `col.generated` are natively typed on Drizzle's `Column`
  const isGeneratedPk =
    col.primary && (col.hasDefault || Boolean(col.generated));
  if (mode === "insert" && isGeneratedPk) return true;

  return MODE_OMIT_PATTERNS[mode].some((re) => re.test(colName));
};

export const resolveFromDrizzleColumn = (
  col: Column,
  mode: QueryMode,
): string => {
  if (COORDINATE_COL_TYPES.has(col.columnType)) {
    return $t.Coordinate();
  }

  const resolver = DATA_TYPE_RESOLVERS[col.dataType];
  return resolver ? resolver(col, mode) : $t.Unknown();
};

export const resolveBaseSchema = (
  colName: string,
  col: Column,
  mode: QueryMode,
  rawRefinements: Record<string, string>,
): string => {
  if (colName in rawRefinements) {
    return rawRefinements[colName];
  }

  const matchedRule = NAME_RULES.find((r) => r.pattern.test(col.name));
  if (matchedRule) {
    if (mode === "select" && matchedRule.selectFallback) {
      return matchedRule.selectFallback(col);
    }
    return matchedRule.resolve(mode, col);
  }

  return resolveFromDrizzleColumn(col, mode);
};
