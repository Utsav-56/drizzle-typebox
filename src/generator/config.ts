import type { Table } from "drizzle-orm";
import type {
  GeneratorConfigInput,
  GeneratorConfigOutput,
  ModeConfig,
  ModeOptions,
  QueryMode,
  Refinements,
} from "./types";

const createModeFactory =
  (mode: QueryMode) =>
  <TTable extends Table>(
    table: TTable,
    refinements: Refinements<TTable> = {},
    options: ModeOptions<TTable> = {},
  ): ModeConfig<TTable> => ({
    __brand: "DrizzleTypeboxModeConfig",
    mode,
    table,
    refinements,
    options,
  });

export const createSelectConfig = createModeFactory("select");
export const createInsertConfig = createModeFactory("insert");
export const createUpdateConfig = createModeFactory("update");

export const GeneratorConfig = <T extends GeneratorConfigInput>(
  config: T,
): T & GeneratorConfigOutput => ({
  ...config,
  __brand: "DrizzleTypeboxGeneratorConfig",
});
