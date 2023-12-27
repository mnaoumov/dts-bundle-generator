import * as ts from 'typescript';

import { packageVersion } from './helpers/package-version';
import { getModifiers, getNodeName, modifiersToMap, recreateRootLevelNodeWithModifiers } from './helpers/typescript';

export interface ModuleImportsSet {
	defaultImports: Set<string>;
	starImport: string | null;
	namedImports: Map<string, string>;
	requireImports: Set<string>;
}

export interface OutputParams extends OutputHelpers {
	typesReferences: Set<string>;
	imports: Map<string, ModuleImportsSet>;
	statements: readonly ts.Statement[];
	renamedExports: Map<string, string>;
	wrappedNamespaces: Map<string, Map<string, string>>;
}

export interface NeedStripDefaultKeywordResult {
	needStrip: boolean;
	newName?: string;
}

export interface OutputHelpers {
	shouldStatementHasExportKeyword(statement: ts.Statement): boolean;
	needStripConstFromConstEnum(constEnum: ts.EnumDeclaration): boolean;
	needStripImportFromImportTypeNode(importType: ts.ImportTypeNode): boolean;
	resolveIdentifierName(identifier: ts.Identifier | ts.QualifiedName | ts.PropertyAccessEntityNameExpression): string | null;
}

export interface OutputOptions {
	umdModuleName?: string;
	sortStatements?: boolean;
	noBanner?: boolean;
}

export function generateOutput(params: OutputParams, options: OutputOptions = {}): string {
	const resultOutputParts: string[] = [];

	if (!options.noBanner) {
		resultOutputParts.push(`// Generated by dts-bundle-generator v${packageVersion()}`);
	}

	if (params.typesReferences.size !== 0) {
		const header = generateReferenceTypesDirective(Array.from(params.typesReferences));
		resultOutputParts.push(header);
	}

	if (params.imports.size !== 0) {
		// we need to have sorted imports of libraries to have more "stable" output
		const sortedEntries = Array.from(params.imports.entries()).sort((firstEntry: [string, ModuleImportsSet], secondEntry: [string, ModuleImportsSet]) => {
			return firstEntry[0].localeCompare(secondEntry[0]);
		});

		const importsArray: string[] = [];
		for (const [libraryName, libraryImports] of sortedEntries) {
			importsArray.push(...generateImports(libraryName, libraryImports));
		}

		if (importsArray.length !== 0) {
			resultOutputParts.push(importsArray.join('\n'));
		}
	}

	const statements = params.statements.map((statement: ts.Statement) => getStatementText(
		statement,
		Boolean(options.sortStatements),
		params
	));

	if (options.sortStatements) {
		statements.sort(compareStatementText);
	}

	if (statements.length !== 0) {
		resultOutputParts.push(statementsTextToString(statements));
	}

	if (params.wrappedNamespaces.size !== 0) {
		resultOutputParts.push(
			Array.from(params.wrappedNamespaces.entries())
				.map(([namespaceName, exportedNames]: [string, Map<string, string>]) => {
					return `declare namespace ${namespaceName} {\n\texport { ${
						Array.from(exportedNames.entries())
							.map(([exportedName, localName]: [string, string]) => renamedExportValue(exportedName, localName))
							.sort()
							.join(', ')
					} };\n}`;
				})
				.join('\n')
		);
	}

	if (params.renamedExports.size !== 0) {
		resultOutputParts.push(`export {\n\t${
			Array.from(params.renamedExports.entries())
				.map(([exportedName, localName]: [string, string]) => renamedExportValue(exportedName, localName))
				.sort()
				.join(',\n\t')
		},\n};`);
	}

	if (options.umdModuleName !== undefined) {
		resultOutputParts.push(`export as namespace ${options.umdModuleName};`);
	}

	// this is used to prevent importing non-exported nodes
	// see https://stackoverflow.com/questions/52583603/intentional-that-export-shuts-off-automatic-export-of-all-symbols-from-a-ty
	resultOutputParts.push(`export {};\n`);

	return resultOutputParts.join('\n\n');
}

interface StatementText {
	text: string;
	sortingValue: string;
}

function statementsTextToString(statements: StatementText[]): string {
	const statementsText = statements.map(statement => statement.text).join('\n');
	return spacesToTabs(prettifyStatementsText(statementsText));
}

function renamedExportValue(exportedName: string, localName: string): string {
	return exportedName !== localName ? `${localName} as ${exportedName}` : exportedName;
}

function renamedImportValue(importedName: string, localName: string): string {
	return importedName !== localName ? `${importedName} as ${localName}` : importedName;
}

function prettifyStatementsText(statementsText: string): string {
	const sourceFile = ts.createSourceFile('output.d.ts', statementsText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const printer = ts.createPrinter(
		{
			newLine: ts.NewLineKind.LineFeed,
			removeComments: false,
		}
	);

	return printer.printFile(sourceFile).trim();
}

function compareStatementText(a: StatementText, b: StatementText): number {
	if (a.sortingValue > b.sortingValue) {
		return 1;
	} else if (a.sortingValue < b.sortingValue) {
		return -1;
	}

	return 0;
}

function getStatementText(statement: ts.Statement, includeSortingValue: boolean, helpers: OutputHelpers): StatementText {
	const shouldStatementHasExportKeyword = helpers.shouldStatementHasExportKeyword(statement);

	// re-export statements do not contribute to top-level names scope so we don't need to resolve their identifiers
	const needResolveIdentifiers = !ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined;

	const printer = ts.createPrinter(
		{
			newLine: ts.NewLineKind.LineFeed,
			removeComments: false,
		},
		{
			// eslint-disable-next-line complexity
			substituteNode: (hint: ts.EmitHint, node: ts.Node) => {
				if (node.parent === undefined) {
					return node;
				}

				if (needResolveIdentifiers) {
					if (ts.isPropertyAccessExpression(node)) {
						const resolvedName = helpers.resolveIdentifierName(node as ts.PropertyAccessEntityNameExpression);
						if (resolvedName !== null && resolvedName !== node.getText()) {
							const identifiers = resolvedName.split('.');

							let result: ts.PropertyAccessExpression | ts.Identifier = ts.factory.createIdentifier(identifiers[0]);

							for (let index = 1; index < identifiers.length; index += 1) {
								result = ts.factory.createPropertyAccessExpression(
									result as ts.PropertyAccessExpression,
									ts.factory.createIdentifier(identifiers[index])
								);
							}

							return result;
						}

						return node;
					}

					if (ts.isIdentifier(node) || ts.isQualifiedName(node)) {
						// QualifiedName and PropertyAccessExpression are handled separately
						if (ts.isIdentifier(node) && (ts.isQualifiedName(node.parent) || ts.isPropertyAccessExpression(node.parent))) {
							return node;
						}

						const resolvedName = helpers.resolveIdentifierName(node);
						if (resolvedName !== null && resolvedName !== node.getText()) {
							const identifiers = resolvedName.split('.');

							let result: ts.QualifiedName | ts.Identifier = ts.factory.createIdentifier(identifiers[0]);

							for (let index = 1; index < identifiers.length; index += 1) {
								result = ts.factory.createQualifiedName(
									result,
									ts.factory.createIdentifier(identifiers[index])
								);
							}

							return result;
						}

						return node;
					}
				}

				// `import('module').Qualifier` or `typeof import('module').Qualifier`
				if (ts.isImportTypeNode(node) && node.qualifier !== undefined && helpers.needStripImportFromImportTypeNode(node)) {
					if (node.isTypeOf) {
						return ts.factory.createTypeQueryNode(node.qualifier);
					}

					return ts.factory.createTypeReferenceNode(node.qualifier, node.typeArguments);
				}

				if (node !== statement) {
					return node;
				}

				const modifiersMap = modifiersToMap(getModifiers(node));

				if (
					ts.isEnumDeclaration(node)
					&& modifiersMap[ts.SyntaxKind.ConstKeyword]
					&& helpers.needStripConstFromConstEnum(node)
				) {
					modifiersMap[ts.SyntaxKind.ConstKeyword] = false;
				}

				const nodeName = getNodeName(node);

				const resolvedStatementName = nodeName !== undefined ? helpers.resolveIdentifierName(nodeName as ts.Identifier) || undefined : undefined;

				// strip the `default` keyword from node regardless
				if (modifiersMap[ts.SyntaxKind.DefaultKeyword]) {
					modifiersMap[ts.SyntaxKind.DefaultKeyword] = false;
					if (ts.isClassDeclaration(node)) {
						// for classes we need to replace `default` with `declare` instead otherwise it will produce an invalid syntax
						modifiersMap[ts.SyntaxKind.DeclareKeyword] = true;
					}
				}

				if (!shouldStatementHasExportKeyword) {
					modifiersMap[ts.SyntaxKind.ExportKeyword] = false;
				} else {
					modifiersMap[ts.SyntaxKind.ExportKeyword] = true;
				}

				// for some reason TypeScript allows to not write `declare` keyword for ClassDeclaration, FunctionDeclaration and VariableDeclaration
				// if it already has `export` keyword - so we need to add it
				// to avoid TS1046: Top-level declarations in .d.ts files must start with either a 'declare' or 'export' modifier.
				if (!modifiersMap[ts.SyntaxKind.ExportKeyword] &&
					(ts.isClassDeclaration(node)
						|| ts.isFunctionDeclaration(node)
						|| ts.isVariableStatement(node)
						|| ts.isEnumDeclaration(node)
						|| ts.isModuleDeclaration(node)
					)
				) {
					modifiersMap[ts.SyntaxKind.DeclareKeyword] = true;
				}

				return recreateRootLevelNodeWithModifiers(node, modifiersMap, resolvedStatementName, shouldStatementHasExportKeyword);
			},
		}
	);

	const statementText = printer.printNode(ts.EmitHint.Unspecified, statement, statement.getSourceFile()).trim();

	let sortingValue = '';

	if (includeSortingValue) {
		// it looks like there is no way to get node's text without a comment at the same time as printing it
		// so to get the actual node text we have to parse it again
		// hopefully it shouldn't take too long (we don't need to do type check, just parse the AST)
		// also let's do it opt-in so if someone isn't using node sorting it won't affect them
		const tempSourceFile = ts.createSourceFile('temp.d.ts', statementText, ts.ScriptTarget.ESNext);

		// we certainly know that there should be 1 statement at the root level (the printed statement)
		sortingValue = tempSourceFile.getChildren()[0].getText();
	}

	return { text: statementText, sortingValue };
}

function generateImports(libraryName: string, imports: ModuleImportsSet): string[] {
	const fromEnding = `from '${libraryName}';`;

	const result: string[] = [];

	// sort to make output more "stable"
	if (imports.starImport !== null) {
		result.push(`import * as ${imports.starImport} ${fromEnding}`);
	}

	Array.from(imports.requireImports).sort().forEach((importName: string) => result.push(`import ${importName} = require('${libraryName}');`));
	Array.from(imports.defaultImports).sort().forEach((importName: string) => result.push(`import ${importName} ${fromEnding}`));

	if (imports.namedImports.size !== 0) {
		result.push(`import { ${
			Array.from(imports.namedImports.entries())
				.map(([localName, importedName]: [string, string]) => renamedImportValue(importedName, localName))
				.sort()
				.join(', ')
		} } ${fromEnding}`);
	}

	return result;
}

function generateReferenceTypesDirective(libraries: string[]): string {
	return libraries.sort().map((library: string) => {
		return `/// <reference types="${library}" />`;
	}).join('\n');
}

function spacesToTabs(text: string): string {
	// eslint-disable-next-line no-regex-spaces
	return text.replace(/^(    )+/gm, (substring: string) => {
		return '\t'.repeat(substring.length / 4);
	});
}
