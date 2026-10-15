import ts from "typescript";
import { CALL_NAME_TO_MODE, QUERY_MODES } from "./constants";
import type {
  ExtractedFileAst,
  ExtractedModeAst,
  ExternalImport,
  QueryMode,
} from "./types";

const stripQuotes = (str: string): string => str.replace(/^['"`]|['"`]$/g, "");

/**
 * Collects top-level `const x = ...` declarations to resolve local variable references.
 */
const collectTopLevelConsts = (
  sourceFile: ts.SourceFile,
): Map<string, ts.Expression> => {
  const consts = new Map<string, ts.Expression>();

  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const { name, initializer } of stmt.declarationList.declarations) {
      if (ts.isIdentifier(name) && initializer) {
        consts.set(name.text, initializer);
      }
    }
  }

  return consts;
};

/**
 * Collects all top-level imports so external identifiers used in schemas can be re-imported.
 */
const collectExternalImports = (sourceFile: ts.SourceFile): ExternalImport[] =>
  sourceFile.statements.flatMap((stmt) => {
    if (
      !ts.isImportDeclaration(stmt) ||
      !stmt.importClause ||
      !ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      return [];
    }

    const { name, namedBindings } = stmt.importClause;
    const importedIdentifiers: string[] = [];

    if (name) importedIdentifiers.push(name.text);
    if (namedBindings) {
      if (ts.isNamespaceImport(namedBindings)) {
        importedIdentifiers.push(namedBindings.name.text);
      } else if (ts.isNamedImports(namedBindings)) {
        importedIdentifiers.push(
          ...namedBindings.elements.map((el) => el.name.text),
        );
      }
    }

    return [
      {
        rawStatement: stmt.getText(sourceFile),
        moduleSpecifier: stmt.moduleSpecifier.text,
        importedIdentifiers,
      },
    ];
  });

export const extractAstFromDtFile = (
  filePath: string,
  sourceText: string,
): ExtractedFileAst => {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const consts = collectTopLevelConsts(sourceFile);
  const modes: Partial<Record<QueryMode, ExtractedModeAst>> = {};

  // --- Scoped AST Helpers (avoids passing sourceFile & consts everywhere) ---

  const getText = (node: ts.Node): string => node.getText(sourceFile).trim();

  const getKey = (name: ts.PropertyName): string => stripQuotes(getText(name));

  const resolve = (expr?: ts.Expression): ts.Expression | undefined =>
    expr && ts.isIdentifier(expr) ? (consts.get(expr.text) ?? expr) : expr;

  const extractObjectMap = (expr?: ts.Expression): Record<string, string> => {
    const obj = resolve(expr);
    if (!obj || !ts.isObjectLiteralExpression(obj)) return {};

    const map: Record<string, string> = {};

    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const val = resolve(prop.initializer) ?? prop.initializer;
        map[getKey(prop.name)] = getText(val);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const key = prop.name.text;
        const val = consts.get(key);
        map[key] = val ? getText(val) : key;
      }
    }

    return map;
  };

  const extractArray = (expr?: ts.Expression): string[] => {
    const arr = resolve(expr);
    if (!arr || !ts.isArrayLiteralExpression(arr)) return [];
    return arr.elements.map((el) => getText(resolve(el) ?? el));
  };

  const parseModeCall = (call: ts.CallExpression): ExtractedModeAst => {
    const [, refinementsArg, optionsArg] = call.arguments;
    const optionsObj = resolve(optionsArg);

    let composites: string[] = [];
    let extend: Record<string, string> = {};

    if (optionsObj && ts.isObjectLiteralExpression(optionsObj)) {
      for (const prop of optionsObj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = getKey(prop.name);
        if (key === "composites") composites = extractArray(prop.initializer);
        if (key === "extend") extend = extractObjectMap(prop.initializer);
      }
    }

    return {
      refinements: extractObjectMap(refinementsArg),
      composites,
      extend,
    };
  };

  // --- AST Traversal ---

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = getText(node.expression);

      // 1. Direct helper call: createSelectConfig / createInsertConfig / createUpdateConfig
      const directMode = CALL_NAME_TO_MODE[callee];
      if (directMode) {
        modes[directMode] = parseModeCall(node);
      }

      // 2. Wrapper call: GeneratorConfig({ select: ..., insert: ..., update: ... })
      if (callee === "GeneratorConfig") {
        const configObj = resolve(node.arguments[0]);
        if (configObj && ts.isObjectLiteralExpression(configObj)) {
          for (const prop of configObj.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const mode = getKey(prop.name) as QueryMode;
            const target = resolve(prop.initializer);

            if (
              QUERY_MODES.includes(mode) &&
              target &&
              ts.isCallExpression(target)
            ) {
              modes[mode] = parseModeCall(target);
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    modes,
    externalImports: collectExternalImports(sourceFile),
  };
};
