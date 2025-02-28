import {
  addDependenciesToPackageJson,
  addProjectConfiguration,
  convertNxGenerator,
  ensurePackage,
  extractLayoutDirectory,
  formatFiles,
  generateFiles,
  GeneratorCallback,
  getWorkspaceLayout,
  joinPathFragments,
  names,
  offsetFromRoot,
  ProjectConfiguration,
  readJson,
  toJS,
  Tree,
  updateJson,
  writeJson,
} from '@nrwl/devkit';
import { getImportPath } from 'nx/src/utils/path';
import { runTasksInSerial } from '@nrwl/workspace/src/utilities/run-tasks-in-serial';
import {
  getRelativePathToRootTsConfig,
  updateRootTsConfig,
} from '../../utils/typescript/ts-config';
import { join } from 'path';
import { addMinimalPublishScript } from '../../utils/minimal-publish-script';
import { LibraryGeneratorSchema } from '../../utils/schema';
import { addSwcConfig } from '../../utils/swc/add-swc-config';
import { addSwcDependencies } from '../../utils/swc/add-swc-dependencies';
import {
  esbuildVersion,
  nxVersion,
  typesNodeVersion,
} from '../../utils/versions';
import jsInitGenerator from '../init/init';

export async function libraryGenerator(
  tree: Tree,
  schema: LibraryGeneratorSchema
) {
  const { layoutDirectory, projectDirectory } = extractLayoutDirectory(
    schema.directory
  );
  schema.directory = projectDirectory;
  const libsDir = layoutDirectory ?? getWorkspaceLayout(tree).libsDir;
  return projectGenerator(tree, schema, libsDir, join(__dirname, './files'));
}

export async function projectGenerator(
  tree: Tree,
  schema: LibraryGeneratorSchema,
  destinationDir: string,
  filesDir: string
) {
  await jsInitGenerator(tree, {
    js: schema.js,
    skipFormat: true,
  });
  const tasks: GeneratorCallback[] = [];
  const options = normalizeOptions(tree, schema, destinationDir);

  createFiles(tree, options, `${filesDir}/lib`);

  addProject(tree, options, destinationDir);

  tasks.push(addProjectDependencies(tree, options));

  if (options.bundler === 'vite') {
    ensurePackage(tree, '@nrwl/vite', nxVersion);
    // nx-ignore-next-line
    const { viteConfigurationGenerator } = require('@nrwl/vite');
    const viteTask = await viteConfigurationGenerator(tree, {
      project: options.name,
      newProject: true,
      uiFramework: 'none',
      includeVitest: options.unitTestRunner === 'vitest',
      includeLib: true,
    });
    tasks.push(viteTask);
  }

  if (schema.bundler === 'webpack' || schema.bundler === 'rollup') {
    ensureBabelRootConfigExists(tree);
  }

  if (options.linter !== 'none') {
    const lintCallback = await addLint(tree, options);
    tasks.push(lintCallback);
  }
  if (options.unitTestRunner === 'jest') {
    const jestCallback = await addJest(tree, options);
    tasks.push(jestCallback);
    if (options.compiler === 'swc') {
      replaceJestConfig(tree, options, `${filesDir}/jest-config`);
    }
  } else if (
    options.unitTestRunner === 'vitest' &&
    options.bundler !== 'vite' // Test would have been set up already
  ) {
    ensurePackage(tree, '@nrwl/vite', nxVersion);
    // nx-ignore-next-line
    const { vitestGenerator } = require('@nrwl/vite');
    const vitestTask = await vitestGenerator(tree, {
      project: options.name,
      uiFramework: 'none',
      coverageProvider: 'c8',
    });
    tasks.push(vitestTask);
  }

  if (!schema.skipTsConfig) {
    updateRootTsConfig(tree, options);
  }

  if (!options.skipFormat) {
    await formatFiles(tree);
  }

  return runTasksInSerial(...tasks);
}

export interface NormalizedSchema extends LibraryGeneratorSchema {
  name: string;
  fileName: string;
  projectRoot: string;
  projectDirectory: string;
  parsedTags: string[];
  importPath?: string;
}

function addProject(
  tree: Tree,
  options: NormalizedSchema,
  destinationDir: string
) {
  const projectConfiguration: ProjectConfiguration = {
    root: options.projectRoot,
    sourceRoot: joinPathFragments(options.projectRoot, 'src'),
    projectType: 'library',
    targets: {},
    tags: options.parsedTags,
  };

  if (options.buildable && options.config !== 'npm-scripts') {
    const outputPath = destinationDir
      ? `dist/${destinationDir}/${options.projectDirectory}`
      : `dist/${options.projectDirectory}`;
    projectConfiguration.targets.build = {
      executor: getBuildExecutor(options),
      outputs: ['{options.outputPath}'],
      options: {
        outputPath,
        main: `${options.projectRoot}/src/index` + (options.js ? '.js' : '.ts'),
        tsConfig: `${options.projectRoot}/tsconfig.lib.json`,
        // TODO(jack): assets for webpack and rollup have validation that we need to fix (assets must be under <project-root>/src)
        assets:
          options.bundler === 'webpack' || options.bundler === 'rollup'
            ? []
            : [`${options.projectRoot}/*.md`],
      },
    };

    if (options.bundler === 'webpack') {
      projectConfiguration.targets.build.options.babelUpwardRootMode = true;
    }

    if (options.compiler === 'swc' && options.skipTypeCheck) {
      projectConfiguration.targets.build.options.skipTypeCheck = true;
    }

    if (options.publishable) {
      const publishScriptPath = addMinimalPublishScript(tree);

      projectConfiguration.targets.publish = {
        executor: 'nx:run-commands',
        options: {
          command: `node ${publishScriptPath} ${options.name} {args.ver} {args.tag}`,
        },
        dependsOn: ['build'],
      };
    }
  }

  if (options.config === 'workspace' || options.config === 'project') {
    addProjectConfiguration(tree, options.name, projectConfiguration);
  } else {
    addProjectConfiguration(
      tree,
      options.name,
      {
        root: projectConfiguration.root,
        tags: projectConfiguration.tags,
        targets: {},
      },
      true
    );
  }
}

export async function addLint(
  tree: Tree,
  options: NormalizedSchema
): Promise<GeneratorCallback> {
  ensurePackage(tree, '@nrwl/linter', nxVersion);
  const { lintProjectGenerator } = require('@nrwl/linter');
  return lintProjectGenerator(tree, {
    project: options.name,
    linter: options.linter,
    skipFormat: true,
    tsConfigPaths: [
      joinPathFragments(options.projectRoot, 'tsconfig.lib.json'),
    ],
    unitTestRunner: options.unitTestRunner,
    eslintFilePatterns: [
      `${options.projectRoot}/**/*.${options.js ? 'js' : 'ts'}`,
    ],
    setParserOptionsProject: options.setParserOptionsProject,
  });
}

function updateTsConfig(tree: Tree, options: NormalizedSchema) {
  updateJson(tree, join(options.projectRoot, 'tsconfig.json'), (json) => {
    if (options.strict) {
      json.compilerOptions = {
        ...json.compilerOptions,
        forceConsistentCasingInFileNames: true,
        strict: true,
        noImplicitOverride: true,
        noPropertyAccessFromIndexSignature: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
      };
    }

    return json;
  });
}

function addBabelRc(tree: Tree, options: NormalizedSchema) {
  const filename = '.babelrc';

  const babelrc = {
    presets: [['@nrwl/js/babel', { useBuiltIns: 'usage' }]],
  };

  writeJson(tree, join(options.projectRoot, filename), babelrc);
}

function createFiles(tree: Tree, options: NormalizedSchema, filesDir: string) {
  const { className, name, propertyName } = names(options.name);
  generateFiles(tree, filesDir, options.projectRoot, {
    ...options,
    dot: '.',
    className,
    name,
    propertyName,
    js: !!options.js,
    cliCommand: 'nx',
    strict: undefined,
    tmpl: '',
    offsetFromRoot: offsetFromRoot(options.projectRoot),
    rootTsConfigPath: getRelativePathToRootTsConfig(tree, options.projectRoot),
    buildable: options.buildable === true,
    hasUnitTestRunner: options.unitTestRunner !== 'none',
  });

  if (options.compiler === 'swc') {
    addSwcDependencies(tree);
    addSwcConfig(tree, options.projectRoot);
  } else if (options.includeBabelRc) {
    addBabelRc(tree, options);
  }

  if (options.unitTestRunner === 'none') {
    tree.delete(
      join(options.projectRoot, 'src/lib', `${options.fileName}.spec.ts`)
    );
    tree.delete(
      join(options.projectRoot, 'src/app', `${options.fileName}.spec.ts`)
    );
  }

  if (options.js) {
    toJS(tree);
  }

  const packageJsonPath = join(options.projectRoot, 'package.json');
  if (options.config === 'npm-scripts') {
    updateJson(tree, packageJsonPath, (json) => {
      json.scripts = {
        build: "echo 'implement build'",
        test: "echo 'implement test'",
      };
      return json;
    });
  } else if (!options.buildable) {
    tree.delete(packageJsonPath);
  }

  updateTsConfig(tree, options);
}

async function addJest(
  tree: Tree,
  options: NormalizedSchema
): Promise<GeneratorCallback> {
  ensurePackage(tree, '@nrwl/jest', nxVersion);
  const { jestProjectGenerator } = require('@nrwl/jest');
  return await jestProjectGenerator(tree, {
    ...options,
    project: options.name,
    setupFile: 'none',
    supportTsx: false,
    skipSerializers: true,
    testEnvironment: options.testEnvironment,
    skipFormat: true,
    compiler: options.compiler,
  });
}

function replaceJestConfig(
  tree: Tree,
  options: NormalizedSchema,
  filesDir: string
) {
  // the existing config has to be deleted otherwise the new config won't overwrite it
  const existingJestConfig = joinPathFragments(
    filesDir,
    `jest.config.${options.js ? 'js' : 'ts'}`
  );
  if (tree.exists(existingJestConfig)) {
    tree.delete(existingJestConfig);
  }

  // replace with JS:SWC specific jest config
  generateFiles(tree, filesDir, options.projectRoot, {
    ext: options.js ? 'js' : 'ts',
    js: !!options.js,
    project: options.name,
    offsetFromRoot: offsetFromRoot(options.projectRoot),
    projectRoot: options.projectRoot,
  });
}

function normalizeOptions(
  tree: Tree,
  options: LibraryGeneratorSchema,
  destinationDir: string
): NormalizedSchema {
  if (options.publishable) {
    if (!options.importPath) {
      throw new Error(
        `For publishable libs you have to provide a proper "--importPath" which needs to be a valid npm package name (e.g. my-awesome-lib or @myorg/my-lib)`
      );
    }
    options.buildable = true;
  }

  const { Linter } = require('@nrwl/linter');
  if (options.config === 'npm-scripts') {
    options.unitTestRunner = 'none';
    options.linter = Linter.None;
    options.buildable = false;
  }
  options.compiler ??= 'tsc';

  if (options.compiler === 'swc' && options.skipTypeCheck == null) {
    options.skipTypeCheck = false;
  }

  const name = names(options.name).fileName;
  const projectDirectory = options.directory
    ? `${names(options.directory).fileName}/${name}`
    : name;

  if (!options.unitTestRunner && options.bundler === 'vite') {
    options.unitTestRunner = 'vitest';
  } else if (!options.unitTestRunner && options.config !== 'npm-scripts') {
    options.unitTestRunner = 'jest';
  }

  if (!options.linter && options.config !== 'npm-scripts') {
    options.linter = Linter.EsLint;
  }

  const projectName = projectDirectory.replace(new RegExp('/', 'g'), '-');
  const fileName = getCaseAwareFileName({
    fileName: options.simpleModuleName ? name : projectName,
    pascalCaseFiles: options.pascalCaseFiles,
  });

  const { npmScope } = getWorkspaceLayout(tree);

  const projectRoot = joinPathFragments(destinationDir, projectDirectory);

  const parsedTags = options.tags
    ? options.tags.split(',').map((s) => s.trim())
    : [];

  const importPath =
    options.importPath || getImportPath(npmScope, projectDirectory);

  return {
    ...options,
    fileName,
    name: projectName,
    projectRoot,
    projectDirectory,
    parsedTags,
    importPath,
  };
}

function getCaseAwareFileName(options: {
  pascalCaseFiles: boolean;
  fileName: string;
}) {
  const normalized = names(options.fileName);

  return options.pascalCaseFiles ? normalized.className : normalized.fileName;
}

function addProjectDependencies(
  tree: Tree,
  options: NormalizedSchema
): GeneratorCallback {
  if (options.bundler == 'esbuild') {
    return addDependenciesToPackageJson(
      tree,
      {},
      {
        '@nrwl/esbuild': nxVersion,
        '@types/node': typesNodeVersion,
        esbuild: esbuildVersion,
      }
    );
  }

  if (options.bundler == 'rollup') {
    return addDependenciesToPackageJson(
      tree,
      {},
      { '@nrwl/rollup': nxVersion, '@types/node': typesNodeVersion }
    );
  }

  if (options.bundler == 'webpack') {
    return addDependenciesToPackageJson(
      tree,
      {},
      { '@nrwl/webpack': nxVersion, '@types/node': typesNodeVersion }
    );
  }

  // noop
  return () => {};
}

function getBuildExecutor(options: NormalizedSchema) {
  switch (options.bundler) {
    case 'esbuild':
      return `@nrwl/esbuild:esbuild`;
    case 'rollup':
      return `@nrwl/rollup:rollup`;
    case 'webpack':
      return `@nrwl/webpack:webpack`;
    default:
      return `@nrwl/js:${options.compiler}`;
  }
}

function ensureBabelRootConfigExists(tree: Tree) {
  if (tree.exists('babel.config.json')) return;

  writeJson(tree, 'babel.config.json', {
    babelrcRoots: ['*'],
  });
}

export default libraryGenerator;
export const librarySchematic = convertNxGenerator(libraryGenerator);
