import type { Table } from "drizzle-orm";
import type { ModeConfig, ModeOptions, QueryMode, Refinements } from "./types";

let activeCollector: ModeConfig<any>[] | null = null;

/**
 * Starts capturing `create*Config` calls during `.dt.ts` module evaluation.
 */
export const beginConfigCollection = (): void => {
  activeCollector = [];
};

/**
 * Ends collection and returns all captured `ModeConfig` instances in top-to-bottom order.
 */
export const endConfigCollection = (): ModeConfig<any>[] => {
  const captured = activeCollector ?? [];
  activeCollector = null;
  return captured;
};

const createModeFactory =
  (mode: QueryMode) =>
  <TTable extends Table>(
    table: TTable,
    refinements: Refinements<TTable> = {},
    options: ModeOptions<TTable> = {},
  ): ModeConfig<TTable> => {
    const config: ModeConfig<TTable> = {
      __brand: "DrizzleTypeboxModeConfig",
      mode,
      table,
      refinements,
      options,
    };

    if (activeCollector !== null) {
      activeCollector.push(config);
    }

    return config;
  };

export const createSelectConfig = createModeFactory("select");
export const createInsertConfig = createModeFactory("insert");
export const createUpdateConfig = createModeFactory("update");