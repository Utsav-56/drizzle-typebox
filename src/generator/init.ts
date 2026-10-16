import { Glob } from "bun";
import path from "node:path";
import { stat } from "node:fs/promises";
import { isTable } from "drizzle-orm";
import { IGNORED_SCAN_DIRS } from "./constants";

const relToCwd = (targetPath: string): string =>
  path.relative(process.cwd(), targetPath);

const shouldIgnorePath = (relPath: string): boolean =>
  relPath.split(/[\\/]/).some((seg) => IGNORED_SCAN_DIRS.has(seg));

/**
 * Resolves the `drizzle.config.ts` path from CLI option or CWD auto-discovery.
 */
const resolveDrizzleConfigPath = async (
  customPath?: string,
): Promise<string> => {
  const cwd = process.cwd();
  const target = customPath
    ? path.resolve(cwd, customPath)
    : path.resolve(cwd, "drizzle.config.ts");

  const fileStat = await stat(target).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(
      `Could not find Drizzle config at "${relToCwd(target)}". Pass a valid path via --config or run from a directory containing drizzle.config.ts.`,
    );
  }

  return target;
};

/**
 * Expands the `schema` property from `drizzle.config.ts` (string or string[]) into absolute `.ts` file paths.
 */
const resolveSchemaFiles = async (
  schemaProp: unknown,
  configDir: string,
): Promise<string[]> => {
  const patterns: string[] = Array.isArray(schemaProp)
    ? schemaProp.filter((p): p is string => typeof p === "string")
    : typeof schemaProp === "string"
      ? [schemaProp]
      : [];

  if (!patterns.length) {
    throw new Error(
      `Invalid or missing "schema" property in drizzle.config.ts.`,
    );
  }

  const resolvedFiles = new Set<string>();

  for (const rawPattern of patterns) {
    const absCandidate = path.resolve(configDir, rawPattern);
    const candidateStat = await stat(absCandidate).catch(() => null);

    if (candidateStat?.isFile()) {
      if (!absCandidate.endsWith(".dt.ts") && absCandidate.endsWith(".ts")) {
        resolvedFiles.add(absCandidate);
      }
      continue;
    }

    if (candidateStat?.isDirectory()) {
      const dirGlob = new Glob("**/*.ts");
      for await (const rel of dirGlob.scan({
        cwd: absCandidate,
        onlyFiles: true,
      })) {
        if (shouldIgnorePath(rel) || rel.endsWith(".dt.ts")) continue;
        resolvedFiles.add(path.resolve(absCandidate, rel));
      }
      continue;
    }

    // Treat as glob pattern relative to configDir
    const normalizedPattern = rawPattern.replace(/^\.\//, "");
    const glob = new Glob(normalizedPattern);
    for await (const rel of glob.scan({ cwd: configDir, onlyFiles: true })) {
      if (shouldIgnorePath(rel) || rel.endsWith(".dt.ts")) continue;
      if (rel.endsWith(".ts")) {
        resolvedFiles.add(path.resolve(configDir, rel));
      }
    }
  }

  return [...resolvedFiles].sort();
};

/**
 * Generates the initial `.dt.ts` boilerplate for all Drizzle tables exported by a schema file.
 */
const buildDtTemplate = (
  schemaFilePath: string,
  tableExportNames: string[],
): string => {
  const schemaBaseName = path.basename(schemaFilePath, ".ts");
  const lines: string[] = [
    `import { createSelectConfig, createInsertConfig, createUpdateConfig } from "./config";`,
    `import { ${tableExportNames.join(", ")} } from "./${schemaBaseName}";`,
    "",
  ];

  for (const tableExport of tableExportNames) {
    lines.push(
      `createSelectConfig(${tableExport});`,
      `createInsertConfig(${tableExport});`,
      `createUpdateConfig(${tableExport});`,
      "",
    );
  }

  return lines.join("\n");
};

export const runInit = async (customConfigPath?: string): Promise<void> => {
  const configPath = await resolveDrizzleConfigPath(customConfigPath);
  const configDir = path.dirname(configPath);

  // 1. Lazily import drizzle.config.ts
  const mod = await import(`${configPath}?update=${Date.now()}`);
  const schemaProp: unknown = mod?.default?.schema ?? mod?.schema;

  // 2. Discover all matching schema files
  const schemaFiles = await resolveSchemaFiles(schemaProp, configDir);
  if (!schemaFiles.length) {
    console.warn(`⚠ No schema files matched in "${relToCwd(configPath)}".`);
    return;
  }

  let createdCount = 0;
  let skippedCount = 0;

  for (const schemaFile of schemaFiles) {
    const dtFilePath = schemaFile.replace(/\.ts$/, ".dt.ts");
    const existing = await stat(dtFilePath).catch(() => null);

    if (existing?.isFile()) {
      console.log(`⏭ Skipped (already exists): ${relToCwd(dtFilePath)}`);
      skippedCount++;
      continue;
    }

    const schemaMod = await import(`${schemaFile}?update=${Date.now()}`);
    const tableExports = Object.entries(schemaMod)
      .filter(([, val]) => isTable(val))
      .map(([exportName]) => exportName);

    if (!tableExports.length) {
      continue;
    }

    const content = buildDtTemplate(schemaFile, tableExports);
    await Bun.write(dtFilePath, content);
    console.log(`✔ Created: ${relToCwd(dtFilePath)} (${tableExports.join(", ")})`);
    createdCount++;
  }

  console.log(
    `✨ Init complete: ${createdCount} created, ${skippedCount} skipped.`,
  );
};