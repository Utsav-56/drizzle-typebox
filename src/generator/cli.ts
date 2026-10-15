import { Glob } from "bun";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { parseArgs } from "node:util";
import {
  AUTO_GENERATED_HEADER,
  DEFAULT_OUT_DIR,
  DEFAULT_TYPEBOX_IMPORT,
  IGNORED_SCAN_DIRS,
} from "./constants";
import { extractAstFromDtFile } from "./ast-extractor";
import { emitTableSchemaFile, verifyTypeScriptSyntax } from "./emitter";
import type {
  CliOptions,
  EmittedSchemaResult,
  GeneratorConfigInput,
} from "./types";

// --- CLI & Environment Helpers ---

const getPackageRunner = (): string =>
  typeof Bun !== "undefined" ? "bunx" : "npx";

const relToCwd = (targetPath: string): string =>
  path.relative(process.cwd(), targetPath);

const shouldIgnorePath = (relPath: string): boolean =>
  relPath.split(/[\\/]/).some((seg) => IGNORED_SCAN_DIRS.has(seg));

export const parseCliArgs = (
  argv: string[] = Bun.argv.slice(2),
  scriptRoot: string = process.cwd(),
): CliOptions => {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", short: "d" },
      out: { type: "string", short: "o" },
      typebox: { type: "string", short: "t" },
      watch: { type: "boolean", short: "w" },
    },
    strict: true,
  });

  const cwd = process.cwd();
  return {
    searchDir: values.dir ? path.resolve(cwd, values.dir) : cwd,
    outDir: values.out
      ? path.resolve(cwd, values.out)
      : path.resolve(scriptRoot, DEFAULT_OUT_DIR),
    outDirExplicitlySet: Boolean(values.out),
    typeboxImportPath: values.typebox ?? DEFAULT_TYPEBOX_IMPORT,
    watch: Boolean(values.watch),
  };
};

/**
 * Writes a file, verifies disk integrity + TS syntax, and returns the written path.
 */
const writeAndVerifyFile = async (
  filePath: string,
  expectedContent: string,
): Promise<string> => {
  await Bun.write(filePath, expectedContent);

  const written = await Bun.file(filePath).text();
  if (written !== expectedContent) {
    throw new Error(`Disk integrity check failed for "${filePath}".`);
  }

  verifyTypeScriptSyntax(path.basename(filePath), written);
  return filePath;
};

/**
 * Formats all generated files in a single batch using `oxfmt` via `bunx` or `npx`.
 */
const formatFilesWithOxfmt = async (filePaths: string[]): Promise<void> => {
  if (!filePaths.length) return;

  const runner = getPackageRunner();

  await new Promise<void>((resolve) => {
    const proc = spawn(runner, ["oxfmt", ...filePaths], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`🎨 Formatted ${filePaths.length} file(s) with oxfmt.`);
      } else {
        console.warn(
          `⚠ oxfmt exited with code ${code} (files left unformatted).`,
        );
      }
      resolve();
    });

    proc.on("error", () => {
      console.warn(
        `⚠ Could not invoke "${runner} oxfmt". Skipping formatting.`,
      );
      resolve();
    });
  });
};

// --- Core Pipeline Steps ---

/**
 * Parses a single `.dt.ts` file, extracts its AST + runtime config, and emits its schema.
 */
const processDtFile = async (
  relPath: string,
  options: CliOptions,
): Promise<EmittedSchemaResult> => {
  const fullDtPath = path.resolve(options.searchDir, relPath);
  const sourceText = await Bun.file(fullDtPath).text();
  const fileAst = extractAstFromDtFile(fullDtPath, sourceText);

  const runtimeMod = await import(`${fullDtPath}?update=${Date.now()}`);
  const configMap: GeneratorConfigInput | undefined = runtimeMod.default;

  if (!configMap || typeof configMap !== "object") {
    throw new Error(
      `File "${relPath}" must have a default export created via GeneratorConfig({ ... }).`,
    );
  }

  const resolvedOutDir =
    !options.outDirExplicitlySet && configMap.emitPath
      ? path.resolve(process.cwd(), configMap.emitPath)
      : options.outDir;

  const emitted = emitTableSchemaFile(
    configMap,
    fileAst,
    fullDtPath,
    resolvedOutDir,
    options.typeboxImportPath,
  );

  return { ...emitted, resolvedOutDir };
};

/**
 * Writes all schemas and the `index.ts` barrel for a target output directory.
 */
const emitOutputDirectory = async (
  targetOutDir: string,
  schemas: EmittedSchemaResult[],
): Promise<string[]> => {
  await mkdir(targetOutDir, { recursive: true });
  schemas.sort((a, b) => a.tableName.localeCompare(b.tableName));

  const writtenFiles: string[] = [];

  for (const schema of schemas) {
    const outPath = await writeAndVerifyFile(
      path.join(targetOutDir, schema.fileName),
      schema.content,
    );
    writtenFiles.push(outPath);
    console.log(`✔ Generated & verified: ${relToCwd(outPath)}`);
  }

  const barrelContent = [
    AUTO_GENERATED_HEADER,
    ...schemas.map((s) => `export * from "./${s.tableName}.schema";`),
    "",
  ].join("\n");

  const barrelPath = await writeAndVerifyFile(
    path.join(targetOutDir, "index.ts"),
    barrelContent,
  );
  writtenFiles.push(barrelPath);

  console.log(
    `✔ Generated barrel:     ${relToCwd(barrelPath)} (${schemas.length} schema file(s))`,
  );

  return writtenFiles;
};

// --- Main Runner & Watcher ---

export const runGenerator = async (options: CliOptions): Promise<void> => {
  const startTime = performance.now();

  const dirStat = await stat(options.searchDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`Invalid search directory: ${options.searchDir}`);
  }

  const resultsByOutDir = new Map<string, EmittedSchemaResult[]>();
  const seenTables = new Map<string, string>();
  const glob = new Glob("**/*.dt.ts");

  for await (const relPath of glob.scan({
    cwd: options.searchDir,
    onlyFiles: true,
  })) {
    if (shouldIgnorePath(relPath)) continue;

    const result = await processDtFile(relPath, options);
    const { resolvedOutDir, tableName } = result;

    const uniqueKey = `${resolvedOutDir}::${tableName}`;
    if (seenTables.has(uniqueKey)) {
      throw new Error(
        `Duplicate table "${tableName}" in "${relPath}" and "${seenTables.get(uniqueKey)}" targeting "${resolvedOutDir}".`,
      );
    }
    seenTables.set(uniqueKey, relPath);

    const group = resultsByOutDir.get(resolvedOutDir) ?? [];
    group.push(result);
    resultsByOutDir.set(resolvedOutDir, group);
  }

  if (!seenTables.size) {
    console.warn(`⚠ No *.dt.ts files found in "${options.searchDir}".`);
    return;
  }

  // Write all schemas & barrels, tracking every written file path
  const writtenFiles: string[] = [];
  for (const [outDir, schemas] of resultsByOutDir) {
    const files = await emitOutputDirectory(outDir, schemas);
    writtenFiles.push(...files);
  }

  // Format all generated files at once via oxfmt
  await formatFilesWithOxfmt(writtenFiles);

  const elapsedMs = (performance.now() - startTime).toFixed(1);
  console.log(`✨ Generation complete in ${elapsedMs}ms.`);
};

const startWatcher = (options: CliOptions): void => {
  console.log(`👀 Watching for *.dt.ts changes in ${options.searchDir}...`);
  let timer: ReturnType<typeof setTimeout> | null = null;

  fsWatch(options.searchDir, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".dt.ts")) return;
    if (timer) clearTimeout(timer);

    timer = setTimeout(async () => {
      console.log(`\n🔄 Change detected in ${filename}. Regenerating...`);
      try {
        await runGenerator(options);
      } catch (err) {
        console.error("❌ Regeneration error:", err);
      }
    }, 120);
  });
};

if (import.meta.main) {
  try {
    const cliOptions = parseCliArgs();
    await runGenerator(cliOptions);
    if (cliOptions.watch) startWatcher(cliOptions);
  } catch (error) {
    console.error(
      "❌ Generator failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}
