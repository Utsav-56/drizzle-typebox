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
import { beginConfigCollection, endConfigCollection } from "./config";
import { extractAstFromDtFile } from "./ast-extractor";
import { emitSchemaFile, getDtBaseName, verifyTypeScriptSyntax } from "./emitter";
import { runInit } from "./init";
import type { CliOptions, EmittedSchemaResult } from "./types";

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
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", short: "d" },
      out: { type: "string", short: "o" },
       outDir: { type: "string" },
      typebox: { type: "string", short: "t" },
      watch: { type: "boolean", short: "w" },
      config: { type: "string", short: "c" },
      init: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });

  const cwd = process.cwd();
  const isInit = Boolean(values.init) || positionals[0] === "init";
  const rawOut = values.out ?? values.outDir;

  return {
    command: isInit ? "init" : "generate",
    searchDir: values.dir ? path.resolve(cwd, values.dir) : cwd,
    outDir: rawOut
      ? path.resolve(cwd, rawOut)
      : path.resolve(scriptRoot, DEFAULT_OUT_DIR),
    typeboxImportPath: values.typebox ?? DEFAULT_TYPEBOX_IMPORT,
    watch: Boolean(values.watch),
    drizzleConfigPath: values.config ?? positionals[1],
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
 * Evaluates a single `.dt.ts` file using the active collector, extracts its AST, and builds its output in memory.
 */
const processDtFile = async (
  relPath: string,
  options: CliOptions,
): Promise<EmittedSchemaResult> => {
  const fullDtPath = path.resolve(options.searchDir, relPath);
  const sourceText = await Bun.file(fullDtPath).text();
  const fileAst = extractAstFromDtFile(fullDtPath, sourceText);

  beginConfigCollection();
  let capturedConfigs;
  try {
    await import(`${fullDtPath}?update=${Date.now()}`);
    capturedConfigs = endConfigCollection();
  } catch (err) {
    endConfigCollection();
    throw err;
  }

  const emitted = emitSchemaFile(
    capturedConfigs,
    fileAst,
    fullDtPath,
    options.outDir,
    options.typeboxImportPath,
  );

  const targetPath = path.join(options.outDir, emitted.fileName);

  return {
    ...emitted,
    sourceRelPath: relPath,
    targetPath,
  };
};

/**
 * Writes all verified schemas and the `index.ts` barrel to the global output directory.
 */
const emitOutputDirectory = async (
  targetOutDir: string,
  schemas: EmittedSchemaResult[],
): Promise<string[]> => {
  await mkdir(targetOutDir, { recursive: true });
  schemas.sort((a, b) => a.baseName.localeCompare(b.baseName));

  const writtenFiles: string[] = [];

  for (const schema of schemas) {
    const outPath = await writeAndVerifyFile(schema.targetPath, schema.content);
    writtenFiles.push(outPath);
    console.log(`✔ Generated & verified: ${relToCwd(outPath)}`);
  }

  const barrelContent = [
    AUTO_GENERATED_HEADER,
    ...schemas.map((s) => `export * from "./${s.baseName}.schema";`),
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

  const dtRelPaths: string[] = [];
  const glob = new Glob("**/*.dt.ts");

  for await (const relPath of glob.scan({
    cwd: options.searchDir,
    onlyFiles: true,
  })) {
    if (!shouldIgnorePath(relPath)) {
      dtRelPaths.push(relPath);
    }
  }

  if (!dtRelPaths.length) {
    console.warn(`⚠ No *.dt.ts files found in "${options.searchDir}".`);
    return;
  }

  // 1. Pre-flight output path collision check BEFORE evaluating or writing any files
  const targetPathOwners = new Map<string, string>();
  for (const relPath of dtRelPaths) {
    const baseName = getDtBaseName(relPath);
    const targetPath = path.join(options.outDir, `${baseName}.schema.ts`);

    const existingOwner = targetPathOwners.get(targetPath);
    if (existingOwner) {
      throw new Error(
        `Output path collision detected: "${existingOwner}" and "${relPath}" both resolve to "${relToCwd(targetPath)}". Aborting generation.`,
      );
    }
    targetPathOwners.set(targetPath, relPath);
  }

  // 2. Process all .dt.ts files in memory first (atomic generation)
  const emittedSchemas: EmittedSchemaResult[] = [];
  for (const relPath of dtRelPaths) {
    const result = await processDtFile(relPath, options);
    emittedSchemas.push(result);
  }

  // 3. Write all schemas & barrel only after all files succeed
  const writtenFiles = await emitOutputDirectory(options.outDir, emittedSchemas);

  // 4. Format all generated files at once via oxfmt
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
    if (cliOptions.command === "init") {
      await runInit(cliOptions.drizzleConfigPath);
    } else {
      await runGenerator(cliOptions);
      if (cliOptions.watch) startWatcher(cliOptions);
    }
  } catch (error) {
    console.error(
      "❌ Generator failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}