import path from "node:path";
import ts from "typescript";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { AUTO_GENERATED_HEADER } from "./constants";
import { applyColumnModifiers } from "./modifiers";
import { resolveBaseSchema, shouldOmitColumn } from "./column-to-schema";
import type {
  ExtractedFileAst,
  ExtractedModeAst,
  ModeConfig,
} from "./types";

const IGNORED_IMPORTS = new Set([
  "t",
  "Static",
  "createSelectConfig",
  "createInsertConfig",
  "createUpdateConfig",
]);

const toPascalCase = (str: string): string =>
  str.replace(/(?:^|[-_]+)(.)/g, (_, ch) => (ch ? ch.toUpperCase() : ""));

const toCamelCase = (str: string): string =>
  toPascalCase(str).replace(/^(.)/, (ch) => ch.toLowerCase());

const formatKey = (key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);

/**
 * Extracts `<baseName>` from `/path/to/<baseName>.dt.ts`.
 */
export const getDtBaseName = (dtFilePath: string): string =>
  path.basename(dtFilePath).replace(/\.dt\.ts$/, "");

/**
 * Validates the Drizzle table, excluded columns, and AST refinements in a single pass.
 */
const parseAndValidateMode = (
  tableName: string,
  { mode, table, options }: ModeConfig,
  ast?: ExtractedModeAst,
) => {
  const columns = getTableColumns(table);
  const excluded = new Set([
    ...(options.columnsToExclude ?? []),
    ...(options.columnsToexclude ?? []),
  ]);
  const refinements = ast?.refinements ?? {};

  const assertColumnExists = (colKey: string, source: string) => {
    if (!(colKey in columns)) {
      const available = Object.keys(columns).join(", ");
      throw new Error(
        `[${tableName} -> ${mode}] ${source} "${colKey}" does not exist on table "${tableName}". Available: ${available}`,
      );
    }
  };

  excluded.forEach((key) =>
    assertColumnExists(key, "Column in columnsToExclude"),
  );
  Object.keys(refinements).forEach((key) =>
    assertColumnExists(key, "Refinement key"),
  );

  return {
    mode,
    columns,
    excluded,
    refinements,
    extend: ast?.extend ?? {},
    composites: ast?.composites ?? [],
  };
};

/**
 * Emits a single mode block (select, insert, or update) for a specific table.
 */
const emitModeSection = (
  tableName: string,
  config: ModeConfig,
  modeAst?: ExtractedModeAst,
): string => {
  const { mode, columns, excluded, refinements, extend, composites } =
    parseAndValidateMode(tableName, config, modeAst);

  const safeTablePrefix = toCamelCase(tableName);

  // 1. Standalone composite declarations scoped by table + mode
  const compositeVars = composites.map(
    (_, idx) => `_${safeTablePrefix}_${mode}Composite${idx + 1}`,
  );
  const compositeDecls = composites.map(
    (code, idx) => `const ${compositeVars[idx]} = ${code};`,
  );

  // 2. Column & extended property entries
  const fields: string[] = [];

  for (const [key, col] of Object.entries(columns)) {
    if (shouldOmitColumn(key, col, mode, excluded)) continue;
    const expr = applyColumnModifiers(
      resolveBaseSchema(key, col, mode, refinements),
      col,
      mode,
    );
    fields.push(`${formatKey(key)}: ${expr}`);
  }

  for (const [key, code] of Object.entries(extend)) {
    fields.push(`${formatKey(key)}: ${code}`);
  }

  // 3. Schema assembly
  const baseObject = `t.Object({ ${fields.join(", ")} })`;
  const finalSchema = compositeVars.length
    ? `t.Composite([${baseObject}, ${compositeVars.join(", ")}])`
    : baseObject;

  // 4. Exports
  const pascalTable = toPascalCase(tableName);
  const camelSchema = `${toCamelCase(mode)}${pascalTable}Schema`;
  const snakeSchema = `${tableName}_${mode}_schema`;
  const staticType = `${toPascalCase(mode)}${pascalTable}`;

  return [
    ...compositeDecls,
    `export const ${camelSchema} = ${finalSchema};`,
    `export const ${snakeSchema} = ${camelSchema};`,
    `export type ${staticType} = Static<typeof ${camelSchema}>;`,
  ].join("\n");
};

/**
 * Resolves external imports from `.dt.ts` referenced inside the generated body.
 */
const resolveNeededExternalImports = (
  ast: ExtractedFileAst,
  body: string,
  dtFilePath: string,
  outDir: string,
): string[] => {
  const dtDir = path.dirname(dtFilePath);

  return ast.externalImports.flatMap(
    ({ importedIdentifiers, moduleSpecifier }) => {
      const used = importedIdentifiers.filter(
        (id) =>
          !IGNORED_IMPORTS.has(id) && new RegExp(`\\b${id}\\b`).test(body),
      );
      if (!used.length) return [];

      let specifier = moduleSpecifier;
      if (specifier.startsWith(".")) {
        const rel = path
          .relative(outDir, path.resolve(dtDir, specifier))
          .replace(/\\/g, "/");
        specifier = rel.startsWith(".") ? rel : `./${rel}`;
      }

      return [`import { ${used.join(", ")} } from "${specifier}";`];
    },
  );
};

/**
 * Verifies that generated TypeScript code has zero syntax errors.
 */
export const verifyTypeScriptSyntax = (
  fileName: string,
  code: string,
): void => {
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (sourceFile as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;

  if (!diagnostics?.length) return;

  const messages = diagnostics
    .map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file || d.start === undefined) return msg;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `Line ${line + 1}:${character + 1} - ${msg}`;
    })
    .join("\n");

  throw new Error(
    `Syntax verification failed for "${fileName}":\n${messages}\n\nGenerated Code:\n${code}`,
  );
};

export const emitSchemaFile = (
  configs: ModeConfig[],
  fileAst: ExtractedFileAst,
  dtFilePath: string,
  resolvedOutDir: string,
  typeboxImportPath: string,
): { baseName: string; fileName: string; content: string } => {
  if (!configs.length) {
    throw new Error(
      `No active mode configs (createSelectConfig, createInsertConfig, createUpdateConfig) found in ${dtFilePath}.`,
    );
  }

  if (configs.length !== fileAst.calls.length) {
    throw new Error(
      `Mismatch between AST config calls (${fileAst.calls.length}) and runtime executed configs (${configs.length}) in ${dtFilePath}. Ensure create*Config calls are at the top level.`,
    );
  }

  const seenRuntimeTableModes = new Set<string>();
  const sections: string[] = [];

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const callAst = fileAst.calls[i];

    if (!cfg.table || !isTable(cfg.table)) {
      throw new Error(
        `Invalid Drizzle table passed to ${cfg.mode} config in ${dtFilePath}. Expected a Drizzle Table instance.`,
      );
    }

    const tableName = getTableName(cfg.table);
    const runtimeKey = `${tableName}::${cfg.mode}`;

    if (seenRuntimeTableModes.has(runtimeKey)) {
      throw new Error(
        `Duplicate "${cfg.mode}" config for table "${tableName}" in "${dtFilePath}".`,
      );
    }
    seenRuntimeTableModes.add(runtimeKey);

    sections.push(emitModeSection(tableName, cfg, callAst));
  }

  const baseName = getDtBaseName(dtFilePath);
  const fileName = `${baseName}.schema.ts`;

  const bodyParts = [
    ...fileAst.supportingStatements,
    ...sections,
  ];
  const body = bodyParts.join("\n\n");

  const imports = [
    AUTO_GENERATED_HEADER,
    `import { type Static } from "@sinclair/typebox";`,
    `import { t } from "${typeboxImportPath}";`,
    ...resolveNeededExternalImports(fileAst, body, dtFilePath, resolvedOutDir),
  ].join("\n");

  const content = `${imports}\n\n${body}\n`;

  verifyTypeScriptSyntax(fileName, content);

  return { baseName, fileName, content };
};