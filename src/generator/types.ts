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

export interface ExtractedModeAst {
  mode: QueryMode;
  tableIdentifier: string;
  refinements: Record<string, string>;
  composites: string[];
  extend: Record<string, string>;
}

export interface ExtractedFileAst {
  calls: ExtractedModeAst[];
  externalImports: ExternalImport[];
  supportingStatements: string[];
}

export interface ExternalImport {
  rawStatement: string;
  moduleSpecifier: string;
  importedIdentifiers: string[];
}

export interface CliOptions {
  command: "generate" | "init";
  searchDir: string;
  outDir: string;
  typeboxImportPath: string;
  watch: boolean;
  drizzleConfigPath?: string;
}

export interface EmittedSchemaResult {
  baseName: string;
  fileName: string;
  sourceRelPath: string;
  targetPath: string;
  content: string;
}