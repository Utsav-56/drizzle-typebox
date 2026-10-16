import ts from "typescript";
import { CALL_NAME_TO_MODE } from "./constants";
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

/**
 * Checks whether a statement contains a `create*Config(...)` call.
 */
const containsModeConfigCall = (
  node: ts.Node,
  sourceFile: ts.SourceFile,
): boolean => {
  let found = false;
  const check = (child: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const callee = child.expression.getText(sourceFile).trim();
      if (callee in CALL_NAME_TO_MODE) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, check);
  };
  check(node);
  return found;
};

/**
 * Collects top-level supporting statements (type aliases, interfaces, functions,
 * or helper `const` declarations that are not `create*Config` calls and not inlined).
 */
const collectSupportingStatements = (
  sourceFile: ts.SourceFile,
  inlinedConstNames: Set<string>,
): string[] => {
  const statements: string[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportAssignment(stmt)) continue;
    if (containsModeConfigCall(stmt, sourceFile)) continue;

    if (ts.isVariableStatement(stmt)) {
      const keptDecls = stmt.declarationList.declarations.filter((decl) => {
        if (!ts.isIdentifier(decl.name)) return true;
        return !inlinedConstNames.has(decl.name.text);
      });
      if (keptDecls.length === stmt.declarationList.declarations.length) {
        statements.push(stmt.getText(sourceFile).trim());
      }
      continue;
    }

    statements.push(stmt.getText(sourceFile).trim());
  }

  return statements;
};

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
  const inlinedConsts = new Set<string>();
  const calls: ExtractedModeAst[] = [];
  const seenTableModes = new Set<string>();

  const getText = (node: ts.Node): string => node.getText(sourceFile).trim();

  const getKey = (name: ts.PropertyName): string => stripQuotes(getText(name));

  const resolve = (expr?: ts.Expression): ts.Expression | undefined => {
    if (expr && ts.isIdentifier(expr) && consts.has(expr.text)) {
      inlinedConsts.add(expr.text);
      return consts.get(expr.text);
    }
    return expr;
  };

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
        if (val) inlinedConsts.add(key);
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

  const parseModeCall = (
    mode: QueryMode,
    call: ts.CallExpression,
  ): ExtractedModeAst => {
    const [tableArg, refinementsArg, optionsArg] = call.arguments;
    if (!tableArg) {
      throw new Error(
        `Missing table argument in ${getText(call.expression)}(...) at ${filePath}.`,
      );
    }

    const resolvedTableExpr = resolve(tableArg) ?? tableArg;
    const tableIdentifier = getText(resolvedTableExpr);

    const uniqueKey = `${tableIdentifier}::${mode}`;
    if (seenTableModes.has(uniqueKey)) {
      throw new Error(
        `Duplicate "${mode}" config for table "${tableIdentifier}" in "${filePath}". Each (table, mode) pair can only be configured once per file.`,
      );
    }
    seenTableModes.add(uniqueKey);

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
      mode,
      tableIdentifier,
      refinements: extractObjectMap(refinementsArg),
      composites,
      extend,
    };
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = getText(node.expression);
      const directMode = CALL_NAME_TO_MODE[callee];
      if (directMode) {
        calls.push(parseModeCall(directMode, node));
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    calls,
    externalImports: collectExternalImports(sourceFile),
    supportingStatements: collectSupportingStatements(
      sourceFile,
      inlinedConsts,
    ),
  };
};