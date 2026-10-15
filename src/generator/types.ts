import type { TSchema } from "@sinclair/typebox";
import type { Table } from "drizzle-orm";

export type QueryMode = "select" | "insert" | "update";

export type ColumnKeys<TTable extends Table> = keyof TTable["_"]["columns"] &
  string;

export type Refinements<TTable extends Table> = Partial<
  Record<ColumnKeys<TTable>, TSchema>
>;

export interface ModeOptions<TTable extends Table> {
  /** Supports both camelCase and lowercase 'e' as specified */
  columnsToExclude?: ColumnKeys<TTable>[];
  columnsToexclude?: ColumnKeys<TTable>[];
  /** Array of TObject / TSchema expressions to merge via t.Composite */
  composites?: TSchema[];
  /** Optional extra virtual fields injected directly into t.Object */
  extend?: Record<string, TSchema>;
}

export interface ModeConfig<TTable extends Table = Table> {
  readonly __brand: "DrizzleTypeboxModeConfig";
  readonly mode: QueryMode;
  readonly table: TTable;
  readonly refinements: Refinements<TTable>;
  readonly options: ModeOptions<TTable>;
}

export interface GeneratorConfigInput {
  /** Optional custom folder path to store generated schemas */
  emitPath?: string;
  select?: ModeConfig<any>;
  insert?: ModeConfig<any>;
  update?: ModeConfig<any>;
}

export interface GeneratorConfigOutput extends GeneratorConfigInput {
  readonly __brand: "DrizzleTypeboxGeneratorConfig";
}

export interface ExtractedModeAst {
  refinements: Record<string, string>;
  composites: string[];
  extend: Record<string, string>;
}

export interface ExtractedFileAst {
  modes: Partial<Record<QueryMode, ExtractedModeAst>>;
  externalImports: ExternalImport[];
}

export interface ExternalImport {
  rawStatement: string;
  moduleSpecifier: string;
  importedIdentifiers: string[];
}

export interface CliOptions {
  searchDir: string;
  outDir: string;
  outDirExplicitlySet: boolean;
  typeboxImportPath: string;
  watch: boolean;
}

export interface EmittedSchemaResult {
  tableName: string;
  fileName: string;
  content: string;
  resolvedOutDir: string;
}
