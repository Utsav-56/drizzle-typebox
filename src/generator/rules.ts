import { t } from "@utsav56/typebox";
import type { TSchema, TType } from "@utsav56/typebox";
import { Column } from "drizzle-orm/column";
import type { QueryMode } from "./types";

const RAW_CODE = Symbol("RAW_CODE");

interface RawSchemaToken {
  readonly [RAW_CODE]: string;
  readonly schema: TSchema;
}

const isRawSchemaToken = (val: unknown): val is RawSchemaToken =>
  typeof val === "object" && val !== null && RAW_CODE in val;

const serializeArg = (arg: unknown): string =>
  isRawSchemaToken(arg) ? arg[RAW_CODE] : JSON.stringify(arg);

type CodeEmitterT = {
  [K in keyof TType]: TType[K] extends (...args: infer A) => unknown
    ? (...args: A) => string
    : never;
};

export const rawSchema = (code: string, schema: TSchema = t.Any()): TSchema =>
  ({ [RAW_CODE]: code, schema }) as unknown as TSchema;

/**
 * `$t` gives you 100% TypeScript autocomplete & parameter checking from `TType`.
 * At runtime, it executes the real `t.<method>(...)` first to verify validity,
 * then returns the deterministic `"t.<method>(...)"` code string.
 */

export const $t: CodeEmitterT = new Proxy({} as CodeEmitterT, {
  get(_target, prop: string | symbol) {
    if (typeof prop !== "string") return undefined;

    const targetMethod: unknown = Reflect.get(t, prop);
    if (typeof targetMethod !== "function") {
      throw new Error(
        `[Schema Rules] "t.${prop}" does not exist on your TypeBox instance.`,
      );
    }

    return (...args: unknown[]): string => {
      // 1. Unwrap any nested `rawSchema` tokens and run the REAL `t` method to validate
      const validationArgs = args.map((a) =>
        isRawSchemaToken(a) ? a.schema : a,
      );
      Reflect.apply(targetMethod, t, validationArgs);

      // 2. Trim trailing `undefined` arguments and serialize to TypeScript code
      let endIdx = args.length;
      while (endIdx > 0 && args[endIdx - 1] === undefined) {
        endIdx--;
      }

      const serialized = args.slice(0, endIdx).map(serializeArg).join(", ");
      return `t.${prop}(${serialized})`;
    };
  },
});

export interface NameRule {
  readonly pattern: RegExp;
  readonly resolve: (mode: QueryMode, col: Column) => string;
  readonly selectFallback?: (col: Column) => string;
}

/**
 * Creates a rule that applies across all query modes (`select`, `insert`, `update`).
 * Accepts either a pre-validated `$t.*` string or a `(mode, col) => string` callback.
 */
export const rule = (
  pattern: RegExp,
  codeOrResolver: string | ((mode: QueryMode, col: Column) => string),
): NameRule => ({
  pattern,
  resolve:
    typeof codeOrResolver === "function"
      ? codeOrResolver
      : () => codeOrResolver,
});

/**
 * Creates a rule that emits `writeCode` on `insert`/`update`, and `selectCode` on `select`.
 */
export const writeOnlyRule = (
  pattern: RegExp,
  writeCode: string,
  selectCode?: string,
): NameRule => ({
  pattern,
  resolve: () => writeCode,
  selectFallback: selectCode ? () => selectCode : undefined,
});
