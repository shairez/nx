import { applyChangesToString, ChangeType, Tree } from '@nrwl/devkit';

let tsModule: typeof import('typescript');

/**
 * Insert a statement after the last import statement in a file
 */
export function insertStatement(tree: Tree, path: string, statement: string) {
  if (!tsModule) {
    tsModule = require('typescript');
  }
  const { createSourceFile, isImportDeclaration, ScriptTarget } = tsModule;

  const contents = tree.read(path, 'utf-8');

  const sourceFile = createSourceFile(path, contents, ScriptTarget.ESNext);

  const importStatements = sourceFile.statements.filter(isImportDeclaration);
  const index =
    importStatements.length > 0
      ? importStatements[importStatements.length - 1].getEnd()
      : 0;

  if (importStatements.length > 0) {
    statement = `\n${statement}`;
  }

  const newContents = applyChangesToString(contents, [
    {
      type: ChangeType.Insert,
      index,
      text: statement,
    },
  ]);

  tree.write(path, newContents);
}
