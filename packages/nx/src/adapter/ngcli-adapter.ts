/* eslint-disable no-restricted-imports */
import type { Architect } from '@angular-devkit/architect';
import {
  fragment,
  logging,
  normalize,
  Path,
  PathFragment,
  schema,
  tags,
  virtualFs,
  workspaces,
} from '@angular-devkit/core';
import { createConsoleLogger, NodeJsSyncHost } from '@angular-devkit/core/node';
import { FileBuffer } from '@angular-devkit/core/src/virtual-fs/host/interface';
import * as chalk from 'chalk';
import { Stats } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { concat, from, Observable, of, zip } from 'rxjs';
import { catchError, concatMap, map, tap } from 'rxjs/operators';
import { GenerateOptions } from '../command-line/generate';
import { ProjectConfiguration } from '../config/workspace-json-project-json';
import { FsTree, Tree } from '../generators/tree';
import { readJson } from '../generators/utils/json';
import {
  addProjectConfiguration,
  getProjects,
  updateProjectConfiguration,
} from '../generators/utils/project-configuration';
import { createProjectGraphAsync } from '../project-graph/project-graph';
import { readJsonFile } from '../utils/fileutils';
import { parseJson } from '../utils/json';
import { NX_ERROR, NX_PREFIX } from '../utils/logger';
import { readModulePackageJson } from '../utils/package-json';
import { detectPackageManager } from '../utils/package-manager';
import { toNewFormat, toOldFormat } from './angular-json';

export async function scheduleTarget(
  root: string,
  opts: {
    project: string;
    target: string;
    configuration: string;
    runOptions: any;
  },
  verbose: boolean
): Promise<Observable<import('@angular-devkit/architect').BuilderOutput>> {
  const { Architect } = require('@angular-devkit/architect');
  const {
    WorkspaceNodeModulesArchitectHost,
  } = require('@angular-devkit/architect/node');

  const logger = getLogger(verbose);
  const fsHost = new NxScopedHost(root);
  const { workspace } = await workspaces.readWorkspace(
    'angular.json',
    workspaces.createWorkspaceHost(fsHost)
  );

  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);
  registry.addSmartDefaultProvider('unparsed', () => {
    // This happens when context.scheduleTarget is used to run a target using nx:run-commands
    return [];
  });
  const architectHost = new WorkspaceNodeModulesArchitectHost(workspace, root);
  const architect: Architect = new Architect(architectHost, registry);
  const run = await architect.scheduleTarget(
    {
      project: opts.project,
      target: opts.target,
      configuration: opts.configuration,
    },
    opts.runOptions,
    { logger }
  );

  let lastOutputError: string;
  return run.output.pipe(
    tap(
      (output) =>
        (lastOutputError = !output.success ? output.error : undefined),
      (error) => {}, // do nothing, this could be an intentional error
      () => {
        lastOutputError ? logger.error(lastOutputError) : 0;
      }
    )
  );
}

function createWorkflow(
  fsHost: virtualFs.Host<Stats>,
  root: string,
  opts: any
): import('@angular-devkit/schematics/tools').NodeWorkflow {
  const NodeWorkflow = require('@angular-devkit/schematics/tools').NodeWorkflow;
  const workflow = new NodeWorkflow(fsHost, {
    force: false,
    dryRun: opts.dryRun,
    packageManager: detectPackageManager(),
    root: normalize(root),
    registry: new schema.CoreSchemaRegistry(
      require('@angular-devkit/schematics').formats.standardFormats
    ),
    resolvePaths: [process.cwd(), root],
  });
  workflow.registry.addPostTransform(schema.transforms.addUndefinedDefaults);
  workflow.engineHost.registerOptionsTransform(
    require('@angular-devkit/schematics/tools').validateOptionsWithSchema(
      workflow.registry
    )
  );
  if (opts.interactive) {
    workflow.registry.usePromptProvider(createPromptProvider());
  }
  return workflow;
}

function getCollection(workflow: any, name: string) {
  const collection = workflow.engine.createCollection(name);
  if (!collection) throw new Error(`Cannot find collection '${name}'`);
  return collection;
}

async function createRecorder(
  host: NxScopedHost,
  record: {
    loggingQueue: string[];
    error: boolean;
  },
  logger: logging.Logger
) {
  return (event: import('@angular-devkit/schematics').DryRunEvent) => {
    let eventPath = event.path.startsWith('/')
      ? event.path.slice(1)
      : event.path;

    if (event.kind === 'error') {
      record.error = true;
      logger.warn(
        `ERROR! ${eventPath} ${
          event.description == 'alreadyExist'
            ? 'already exists'
            : 'does not exist.'
        }.`
      );
    } else if (event.kind === 'update') {
      record.loggingQueue.push(
        tags.oneLine`${chalk.white('UPDATE')} ${eventPath}`
      );
    } else if (event.kind === 'create') {
      record.loggingQueue.push(
        tags.oneLine`${chalk.green('CREATE')} ${eventPath}`
      );
    } else if (event.kind === 'delete') {
      record.loggingQueue.push(`${chalk.yellow('DELETE')} ${eventPath}`);
    } else if (event.kind === 'rename') {
      record.loggingQueue.push(
        `${chalk.blue('RENAME')} ${eventPath} => ${event.to}`
      );
    }
  };
}

async function runSchematic(
  host: NxScopedHost,
  root: string,
  workflow: import('@angular-devkit/schematics/tools').NodeWorkflow,
  logger: logging.Logger,
  opts: GenerateOptions,
  schematic: import('@angular-devkit/schematics').Schematic<
    import('@angular-devkit/schematics/tools').FileSystemCollectionDescription,
    import('@angular-devkit/schematics/tools').FileSystemSchematicDescription
  >,
  printDryRunMessage = true,
  recorder: any = null
): Promise<{ status: number; loggingQueue: string[] }> {
  const record = { loggingQueue: [] as string[], error: false };
  workflow.reporter.subscribe(
    recorder || (await createRecorder(host, record, logger))
  );

  try {
    await workflow
      .execute({
        collection: opts.collectionName,
        schematic: opts.generatorName,
        options: opts.generatorOptions,
        debug: false,
        logger,
      })
      .toPromise();
  } catch (e) {
    console.log(e);
    throw e;
  }
  if (!record.error) {
    record.loggingQueue.forEach((log) => logger.info(log));
  }
  if (opts.dryRun && printDryRunMessage) {
    logger.warn(`\nNOTE: The "dryRun" flag means no changes were made.`);
  }
  return { status: 0, loggingQueue: record.loggingQueue };
}

export class NxScopedHost extends virtualFs.ScopedHost<any> {
  constructor(private root: string) {
    super(new NodeJsSyncHost(), normalize(root));
  }

  read(path: Path): Observable<FileBuffer> {
    if (path === 'angular.json' || path === '/angular.json') {
      return this.readMergedProjectConfiguration().pipe(
        map((r) => Buffer.from(JSON.stringify(toOldFormat(r))))
      );
    } else {
      return super.read(path);
    }
  }

  private readMergedProjectConfiguration() {
    return zip(
      from(createProjectGraphAsync()),
      this.readExistingAngularJson()
    ).pipe(
      concatMap((arg) => {
        const graph = arg[0] as any;
        const ret = (arg[1] || { projects: {} }) as any;
        const projectJsonReads: Observable<
          [string, ProjectConfiguration & { version: string }]
        >[] = [];
        for (let projectName of Object.keys(graph.nodes)) {
          if (!ret.projects[projectName]) {
            projectJsonReads.push(
              zip(
                of(projectName),
                this.readExistingProjectJson(
                  join(graph.nodes[projectName].data.root, 'project.json')
                )
              )
            );
          }
        }
        return zip(...projectJsonReads).pipe(
          map((reads) => {
            reads
              .filter(([, p]) => p !== null)
              .forEach(([projectName, project]) => {
                delete project.version;
                ret.projects[projectName] = {
                  ...project,
                  root: graph.nodes[projectName].data.root,
                };
              });

            return ret;
          })
        );
      }),
      catchError((err) => {
        console.log('Unable to read angular.json');
        console.log(err);
        process.exit(1);
      })
    );
  }

  write(path: Path, content: FileBuffer): Observable<void> {
    if (path === 'angular.json' || path === '/angular.json') {
      const configV2 = toNewFormat(parseJson(content.toString()));
      const root = this.root;

      return zip(
        this.readMergedProjectConfiguration(),
        this.readExistingAngularJson()
      ).pipe(
        concatMap((arg) => {
          const existingConfig = arg[0] as any;
          const existingAngularJson = arg[1] as any;

          const projectsInAngularJson = existingAngularJson
            ? Object.keys(existingAngularJson.projects)
            : [];
          const projects = configV2.projects;
          const allObservables = [];
          Object.keys(projects).forEach((projectName) => {
            if (projectsInAngularJson.includes(projectName)) {
              // ignore updates to angular.json
            } else {
              updateProjectConfiguration(
                {
                  root,
                  exists: () => true,
                  write: (path: string, content) => {
                    if (existingConfig.projects[projectName]) {
                      const updatedContent = this.mergeProjectConfiguration(
                        existingConfig.projects[projectName],
                        projects[projectName],
                        projectName
                      );
                      if (updatedContent) {
                        delete updatedContent.root;
                        allObservables.push(
                          super.write(
                            path as any,
                            Buffer.from(JSON.stringify(updatedContent, null, 2))
                          )
                        );
                      }
                    } else {
                      allObservables.push(
                        super.write(path as any, Buffer.from(content))
                      );
                    }
                  },
                } as any,
                projectName,
                projects[projectName]
              );
            }
          });
          return concat(...allObservables);
        })
      ) as any;
    } else {
      return super.write(path, content);
    }
  }

  isFile(path: Path): Observable<boolean> {
    if (path === 'angular.json' || path === '/angular.json') {
      return of(true);
    } else {
      return super.isFile(path);
    }
  }

  exists(path: Path): Observable<boolean> {
    if (path === 'angular.json' || path === '/angular.json') {
      return of(true);
    } else {
      return super.exists(path);
    }
  }

  mergeProjectConfiguration(
    existing: ProjectConfiguration,
    updated: ProjectConfiguration,
    projectName: string
  ) {
    const res = { ...existing };

    if (!res.targets) {
      res.targets = {};
    }

    let modified = false;
    for (let target of Object.keys(updated.targets)) {
      if (!res.targets[target]) {
        res.targets[target] = updated.targets[target];
        modified = true;
      }
    }
    if (!res.name) {
      res.name = updated.name || projectName;
      modified = true;
    }

    return modified ? res : null;
  }

  readExistingAngularJson() {
    return super
      .exists('angular.json' as any)
      .pipe(
        concatMap((r) =>
          r
            ? super
                .read('angular.json' as any)
                .pipe(map((r) => parseJson(arrayBufferToString(r))))
            : of(null)
        )
      );
  }

  readExistingProjectJson(path: string) {
    return super
      .exists(path as any)
      .pipe(
        concatMap((r) =>
          r
            ? super
                .read(path as any)
                .pipe(
                  map((r) => toNewFormat(parseJson(arrayBufferToString(r))))
                )
            : of(null)
        )
      );
  }
}

export function arrayBufferToString(buffer: any) {
  const array = new Uint8Array(buffer);
  let result = '';
  const chunkSize = 8 * 1024;
  let i = 0;
  for (i = 0; i < array.length / chunkSize; i++) {
    result += String.fromCharCode.apply(
      null,
      array.subarray(i * chunkSize, (i + 1) * chunkSize)
    );
  }
  result += String.fromCharCode.apply(null, array.subarray(i * chunkSize));
  return result;
}

export class NxScopeHostUsedForWrappedSchematics extends NxScopedHost {
  constructor(root: string, private readonly host: Tree) {
    super(root);
  }

  read(path: Path): Observable<FileBuffer> {
    if (path == 'angular.json' || path == '/angular.json') {
      const projectJsonConfig = toOldFormat({
        projects: Object.fromEntries(getProjects(this.host)),
      });
      return super.readExistingAngularJson().pipe(
        map((angularJson) => {
          if (angularJson) {
            return Buffer.from(
              JSON.stringify({
                version: 1,
                projects: {
                  ...projectJsonConfig.projects,
                  ...angularJson.projects,
                },
              })
            );
          } else {
            return Buffer.from(JSON.stringify(projectJsonConfig));
          }
        })
      );
    } else {
      const match = findMatchingFileChange(this.host, path);
      if (match) {
        return of(Buffer.from(match.content));
      } else {
        return super.read(path);
      }
    }
  }

  exists(path: Path): Observable<boolean> {
    if (this.host.exists(path)) {
      return of(true);
    } else if (path === 'angular.json' || path === '/angular.json') {
      return of(true);
    } else {
      return super.exists(path);
    }
  }

  isDirectory(path: Path): Observable<boolean> {
    if (this.host.exists(path) && !this.host.isFile(path)) {
      return of(true);
    } else if (path === 'angular.json' || path === '/angular.json') {
      return of(false);
    } else {
      return super.isDirectory(path);
    }
  }

  isFile(path: Path): Observable<boolean> {
    if (this.host.isFile(path)) {
      return of(true);
    } else if (path === 'angular.json' || path === '/angular.json') {
      return of(true);
    } else {
      return super.isFile(path);
    }
  }

  list(path: Path): Observable<PathFragment[]> {
    const fragments = this.host.children(path).map((child) => fragment(child));
    return of(fragments);
  }
}

function findMatchingFileChange(host: Tree, path: Path) {
  const targetPath = normalize(
    path.startsWith('/') ? path.substring(1) : path.toString()
  );
  return host
    .listChanges()
    .find((f) => f.type !== 'DELETE' && normalize(f.path) === targetPath);
}

export async function generate(
  root: string,
  opts: GenerateOptions,
  verbose: boolean
) {
  const logger = getLogger(verbose);
  const fsHost = new NxScopeHostUsedForWrappedSchematics(
    root,
    new FsTree(root, verbose)
  );
  const workflow = createWorkflow(fsHost, root, opts);
  const collection = getCollection(workflow, opts.collectionName);
  const schematic = collection.createSchematic(opts.generatorName, true);
  return (
    await runSchematic(
      fsHost,
      root,
      workflow,
      logger as any,
      { ...opts, generatorName: schematic.description.name },
      schematic
    )
  ).status;
}

function createPromptProvider() {
  interface Prompt {
    name: string;
    type: 'input' | 'select' | 'multiselect' | 'confirm' | 'numeral';
    message: string;
    initial?: any;
    choices?: (string | { name: string; message: string })[];
    validate?: (value: string) => boolean | string;
  }

  return (definitions: Array<any>) => {
    const questions: Prompt[] = definitions.map((definition) => {
      const question: Prompt = {
        name: definition.id,
        message: definition.message,
      } as any;

      if (definition.default) {
        question.initial = definition.default;
      }

      const validator = definition.validator;
      if (validator) {
        question.validate = (input) => validator(input);
      }

      switch (definition.type) {
        case 'string':
        case 'input':
          return { ...question, type: 'input' };
        case 'boolean':
        case 'confirmation':
        case 'confirm':
          return { ...question, type: 'confirm' };
        case 'number':
        case 'numeral':
          return { ...question, type: 'numeral' };
        case 'list':
          return {
            ...question,
            type: !!definition.multiselect ? 'multiselect' : 'select',
            choices:
              definition.items &&
              definition.items.map((item) => {
                if (typeof item == 'string') {
                  return item;
                } else {
                  return {
                    message: item.label,
                    name: item.value,
                  };
                }
              }),
          };
        default:
          return { ...question, type: definition.type };
      }
    });

    return require('enquirer').prompt(questions);
  };
}

export async function runMigration(
  root: string,
  packageName: string,
  migrationName: string,
  isVerbose: boolean
) {
  const logger = getLogger(isVerbose);
  const fsHost = new NxScopeHostUsedForWrappedSchematics(
    root,
    new FsTree(root, isVerbose)
  );
  const workflow = createWorkflow(fsHost, root, {});
  const collection = resolveMigrationsCollection(packageName);

  const record = { loggingQueue: [] as string[], error: false };
  workflow.reporter.subscribe(await createRecorder(fsHost, record, logger));

  await workflow
    .execute({
      collection,
      schematic: migrationName,
      options: {},
      debug: false,
      logger: logger as any,
    })
    .toPromise();

  return {
    loggingQueue: record.loggingQueue,
    madeChanges: record.loggingQueue.length > 0,
  };
}

function resolveMigrationsCollection(name: string): string {
  let collectionPath: string | undefined = undefined;

  if (name.startsWith('.') || name.startsWith('/')) {
    name = resolve(name);
  }

  if (extname(name)) {
    collectionPath = require.resolve(name);
  } else {
    const { path: packageJsonPath, packageJson } = readModulePackageJson(name, [
      process.cwd(),
    ]);

    let pkgJsonSchematics =
      packageJson['nx-migrations'] ?? packageJson['ng-update'];
    if (!pkgJsonSchematics) {
      throw new Error(`Could not find migrations in package: "${name}"`);
    }
    if (typeof pkgJsonSchematics != 'string') {
      pkgJsonSchematics = pkgJsonSchematics.migrations;
    }
    collectionPath = require.resolve(pkgJsonSchematics, {
      paths: [dirname(packageJsonPath)],
    });
  }

  try {
    if (collectionPath) {
      readJsonFile(collectionPath);
      return collectionPath;
    }
  } catch {
    throw new Error(`Invalid migration file in package: "${name}"`);
  }
  throw new Error(`Collection cannot be resolved: "${name}"`);
}

let collectionResolutionOverrides = null;
let mockedSchematics = null;

/**
 * By default, Angular Devkit schematic collections will be resolved using the Node resolution.
 * This doesn't work if you are testing schematics that refer to other schematics in the
 * same repo.
 *
 * This function can can be used to override the resolution behaviour.
 *
 * Example:
 *
 * ```typescript
 *   overrideCollectionResolutionForTesting({
 *     '@nrwl/workspace': path.join(__dirname, '../../../../workspace/generators.json'),
 *     '@nrwl/angular': path.join(__dirname, '../../../../angular/generators.json'),
 *     '@nrwl/linter': path.join(__dirname, '../../../../linter/generators.json')
 *   });
 *
 * ```
 */
export function overrideCollectionResolutionForTesting(collections: {
  [name: string]: string;
}) {
  collectionResolutionOverrides = collections;
}

/**
 * If you have an Nx Devkit generator invoking the wrapped Angular Devkit schematic,
 * and you don't want the Angular Devkit schematic to run, you can mock it up using this function.
 *
 * Unfortunately, there are some edge cases in the Nx-Angular devkit integration that
 * can be seen in the unit tests context. This function is useful for handling that as well.
 *
 * In this case, you can mock it up.
 *
 * Example:
 *
 * ```typescript
 *   mockSchematicsForTesting({
 *     'mycollection:myschematic': (tree, params) => {
 *        tree.write("README.md");
 *     }
 *   });
 *
 * ```
 */
export function mockSchematicsForTesting(schematics: {
  [name: string]: (
    host: Tree,
    generatorOptions: { [k: string]: any }
  ) => Promise<void>;
}) {
  mockedSchematics = schematics;
}

export function wrapAngularDevkitSchematic(
  collectionName: string,
  generatorName: string
) {
  // This is idempotent, if it happens to get called
  // multiple times its no big deal. It ensures that some
  // patches are applied to @angular-devkit code which
  // are necessary. For the most part, our wrapped host hits
  // the necessary areas, but for some things it wouldn't make
  // sense for the adapter to be 100% accurate.
  //
  // e.g. Angular warns about tags, but some angular CLI schematics
  // were written with Nx in mind, and may care about tags.
  require('./compat');

  return async (host: Tree, generatorOptions: { [k: string]: any }) => {
    if (
      mockedSchematics &&
      mockedSchematics[`${collectionName}:${generatorName}`]
    ) {
      return await mockedSchematics[`${collectionName}:${generatorName}`](
        host,
        generatorOptions
      );
    }

    const emptyLogger = {
      log: (e) => {},
      info: (e) => {},
      warn: (e) => {},
      debug: () => {},
      error: (e) => {},
      fatal: (e) => {},
    } as any;
    emptyLogger.createChild = () => emptyLogger;

    const recorder = (
      event: import('@angular-devkit/schematics').DryRunEvent
    ) => {
      let eventPath = event.path.startsWith('/')
        ? event.path.slice(1)
        : event.path;

      if (event.kind === 'error') {
      } else if (event.kind === 'update') {
        if (eventPath === 'angular.json') {
          saveProjectsConfigurationsInWrappedSchematic(
            host,
            event.content.toString()
          );
        } else {
          host.write(eventPath, event.content);
        }
      } else if (event.kind === 'create') {
        host.write(eventPath, event.content);
      } else if (event.kind === 'delete') {
        host.delete(eventPath);
      } else if (event.kind === 'rename') {
        host.rename(eventPath, event.to);
      }
    };

    const fsHost = new NxScopeHostUsedForWrappedSchematics(host.root, host);

    const options = {
      generatorOptions,
      dryRun: true,
      interactive: false,
      help: false,
      debug: false,
      collectionName,
      generatorName,
      force: false,
      defaults: false,
    };
    const workflow = createWorkflow(fsHost, host.root, options);

    // used for testing
    if (collectionResolutionOverrides) {
      const r = (workflow.engineHost as any).resolve;
      (workflow.engineHost as any).resolve = (collection, b, c) => {
        if (collectionResolutionOverrides[collection]) {
          return collectionResolutionOverrides[collection];
        } else {
          return r.apply(workflow.engineHost, [collection, b, c]);
        }
      };
    }

    const collection = getCollection(workflow, collectionName);
    const schematic = collection.createSchematic(generatorName, true);
    const res = await runSchematic(
      fsHost,
      host.root,
      workflow,
      emptyLogger,
      options,
      schematic,
      false,
      recorder
    );

    if (res.status !== 0) {
      throw new Error(res.loggingQueue.join('\n'));
    }
  };
}

let logger: logging.Logger;

export const getLogger = (isVerbose = false): logging.Logger => {
  if (!logger) {
    logger = createConsoleLogger(isVerbose, process.stdout, process.stderr, {
      warn: (s) => chalk.bold(chalk.yellow(s)),
      error: (s) => {
        if (s.startsWith('NX ')) {
          return `\n${NX_ERROR} ${chalk.bold(chalk.red(s.slice(3)))}\n`;
        }

        return chalk.bold(chalk.red(s));
      },
      info: (s) => {
        if (s.startsWith('NX ')) {
          return `\n${NX_PREFIX} ${chalk.bold(s.slice(3))}\n`;
        }

        return chalk.white(s);
      },
    });
  }
  return logger;
};

function saveProjectsConfigurationsInWrappedSchematic(
  host: Tree,
  content: string
) {
  const projects = toNewFormat(parseJson(content)).projects;
  const existingProjects = getProjects(host);

  const existingAngularJson = host.exists('angular.json')
    ? readJson(host, 'angular.json')
    : null;
  const projectsInAngularJson = existingAngularJson
    ? Object.keys(existingAngularJson.projects)
    : [];

  const newAngularJson = { projects: {} };

  Object.keys(projects).forEach((projectName) => {
    if (projectsInAngularJson.includes(projectName)) {
      newAngularJson.projects[projectName] = projects[projectName];
    } else {
      if (existingProjects.has(projectName)) {
        updateProjectConfiguration(host, projectName, projects[projectName]);
      } else {
        addProjectConfiguration(host, projectName, projects[projectName]);
      }
    }
  });
  if (Object.keys(newAngularJson.projects).length > 0) {
    host.write(
      'angular.json',
      JSON.stringify(toOldFormat(newAngularJson), null, 2)
    );
  }
}
