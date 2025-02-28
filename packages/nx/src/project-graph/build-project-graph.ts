import { workspaceRoot } from '../utils/workspace-root';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { assertWorkspaceValidity } from '../utils/assert-workspace-validity';
import { FileData } from './file-utils';
import {
  createCache,
  extractCachedFileData,
  ProjectGraphCache,
  readCache,
  shouldRecomputeWholeGraph,
  writeCache,
} from './nx-deps-cache';
import { buildImplicitProjectDependencies } from './build-dependencies';
import { buildWorkspaceProjectNodes } from './build-nodes';
import * as os from 'os';
import { buildExplicitTypescriptAndPackageJsonDependencies } from './build-dependencies/build-explicit-typescript-and-package-json-dependencies';
import { loadNxPlugins } from '../utils/nx-plugin';
import { defaultFileHasher } from '../hasher/file-hasher';
import { createProjectFileMap } from './file-map-utils';
import { getRootTsConfigPath } from '../utils/typescript';
import {
  ProjectFileMap,
  ProjectGraph,
  ProjectGraphProcessorContext,
} from '../config/project-graph';
import { readJsonFile } from '../utils/fileutils';
import { NrwlJsPluginConfig, NxJsonConfiguration } from '../config/nx-json';
import { logger } from '../utils/logger';
import { ProjectGraphBuilder } from './project-graph-builder';
import {
  ProjectConfiguration,
  ProjectsConfigurations,
} from '../config/workspace-json-project-json';
import { readNxJson } from '../config/configuration';
import {
  lockFileExists,
  lockFileHash,
  parseLockFile,
} from '../lock-file/lock-file';
import { Workspaces } from '../config/workspaces';
import { existsSync } from 'fs';
import { PackageJson } from '../utils/package-json';

export async function buildProjectGraph() {
  const projectConfigurations = new Workspaces(
    workspaceRoot
  ).readProjectsConfigurations();
  const { projectFileMap, allWorkspaceFiles } = createProjectFileMap(
    projectConfigurations,
    defaultFileHasher.allFileData()
  );

  const cacheEnabled = process.env.NX_CACHE_PROJECT_GRAPH !== 'false';
  let cache = cacheEnabled ? readCache() : null;
  return (
    await buildProjectGraphUsingProjectFileMap(
      projectConfigurations,
      projectFileMap,
      allWorkspaceFiles,
      cache,
      cacheEnabled
    )
  ).projectGraph;
}

export async function buildProjectGraphUsingProjectFileMap(
  projectsConfigurations: ProjectsConfigurations,
  projectFileMap: ProjectFileMap,
  allWorkspaceFiles: FileData[],
  cache: ProjectGraphCache | null,
  shouldWriteCache: boolean
): Promise<{
  projectGraph: ProjectGraph;
  projectGraphCache: ProjectGraphCache;
}> {
  const nxJson = readNxJson();
  const projectGraphVersion = '5.0';
  assertWorkspaceValidity(projectsConfigurations, nxJson);
  const packageJsonDeps = readCombinedDeps();
  const rootTsConfig = readRootTsConfig();

  let filesToProcess;
  let cachedFileData;
  if (
    cache &&
    !shouldRecomputeWholeGraph(
      cache,
      packageJsonDeps,
      projectsConfigurations,
      nxJson,
      rootTsConfig
    )
  ) {
    const fromCache = extractCachedFileData(projectFileMap, cache);
    filesToProcess = fromCache.filesToProcess;
    cachedFileData = fromCache.cachedFileData;
  } else {
    filesToProcess = projectFileMap;
    cachedFileData = {};
  }
  let partialGraph: ProjectGraph;
  let lockHash = 'n/a';
  // during the create-nx-workspace lock file might not exists yet
  if (lockFileExists()) {
    lockHash = lockFileHash();
    if (cache && cache.lockFileHash === lockHash) {
      partialGraph = isolatePartialGraphFromCache(cache);
    } else {
      partialGraph = parseLockFile();
    }
  }
  const context = createContext(
    projectsConfigurations,
    nxJson,
    projectFileMap,
    filesToProcess
  );
  let projectGraph = await buildProjectGraphUsingContext(
    nxJson,
    context,
    cachedFileData,
    projectGraphVersion,
    partialGraph,
    packageJsonDeps
  );
  const projectGraphCache = createCache(
    nxJson,
    packageJsonDeps,
    projectGraph,
    rootTsConfig,
    lockHash
  );
  if (shouldWriteCache) {
    writeCache(projectGraphCache);
  }
  projectGraph.allWorkspaceFiles = allWorkspaceFiles;
  return {
    projectGraph,
    projectGraphCache,
  };
}

function readCombinedDeps() {
  const installationPackageJsonPath = join(
    workspaceRoot,
    '.nx',
    'installation',
    'package.json'
  );
  const installationPackageJson: Partial<PackageJson> = existsSync(
    installationPackageJsonPath
  )
    ? readJsonFile(installationPackageJsonPath)
    : {};
  const rootPackageJsonPath = join(workspaceRoot, 'package.json');
  const rootPackageJson: Partial<PackageJson> = existsSync(rootPackageJsonPath)
    ? readJsonFile(rootPackageJsonPath)
    : {};
  return {
    ...rootPackageJson.dependencies,
    ...rootPackageJson.devDependencies,
    ...installationPackageJson.dependencies,
    ...installationPackageJson.devDependencies,
  };
}

// extract only external nodes and their dependencies
function isolatePartialGraphFromCache(cache: ProjectGraphCache): ProjectGraph {
  const dependencies = {};
  Object.keys(cache.dependencies).forEach((k) => {
    if (cache.externalNodes[k]) {
      dependencies[k] = cache.dependencies[k];
    }
  });

  return {
    nodes: {},
    dependencies,
    externalNodes: cache.externalNodes,
  };
}

async function buildProjectGraphUsingContext(
  nxJson: NxJsonConfiguration,
  ctx: ProjectGraphProcessorContext,
  cachedFileData: { [project: string]: { [file: string]: FileData } },
  projectGraphVersion: string,
  partialGraph: ProjectGraph,
  packageJsonDeps: Record<string, string>
) {
  performance.mark('build project graph:start');

  const builder = new ProjectGraphBuilder(partialGraph);
  builder.setVersion(projectGraphVersion);

  buildWorkspaceProjectNodes(ctx, builder, nxJson);
  const initProjectGraph = builder.getUpdatedProjectGraph();

  const r = await updateProjectGraphWithPlugins(ctx, initProjectGraph);

  const updatedBuilder = new ProjectGraphBuilder(r);
  for (const proj of Object.keys(cachedFileData)) {
    for (const f of updatedBuilder.graph.nodes[proj].data.files) {
      const cached = cachedFileData[proj][f.file];
      if (cached && cached.deps) {
        f.deps = [...cached.deps];
      }
    }
  }

  await buildExplicitDependencies(
    jsPluginConfig(nxJson, packageJsonDeps),
    ctx,
    updatedBuilder
  );

  buildImplicitProjectDependencies(ctx, updatedBuilder);

  const finalGraph = updatedBuilder.getUpdatedProjectGraph();

  performance.mark('build project graph:end');
  performance.measure(
    'build project graph',
    'build project graph:start',
    'build project graph:end'
  );

  return finalGraph;
}

function jsPluginConfig(
  nxJson: NxJsonConfiguration,
  packageJsonDeps: { [packageName: string]: string }
): NrwlJsPluginConfig {
  if (nxJson?.pluginsConfig?.['@nrwl/js']) {
    return nxJson?.pluginsConfig?.['@nrwl/js'];
  }
  if (
    packageJsonDeps['@nrwl/workspace'] ||
    packageJsonDeps['@nrwl/js'] ||
    packageJsonDeps['@nrwl/node'] ||
    packageJsonDeps['@nrwl/next'] ||
    packageJsonDeps['@nrwl/react'] ||
    packageJsonDeps['@nrwl/angular'] ||
    packageJsonDeps['@nrwl/web']
  ) {
    return { analyzePackageJson: true, analyzeSourceFiles: true };
  } else {
    return { analyzePackageJson: true, analyzeSourceFiles: false };
  }
}

function buildExplicitDependencies(
  jsPluginConfig: {
    analyzeSourceFiles?: boolean;
    analyzePackageJson?: boolean;
  },
  ctx: ProjectGraphProcessorContext,
  builder: ProjectGraphBuilder
) {
  let totalNumOfFilesToProcess = totalNumberOfFilesToProcess(ctx);
  // using workers has an overhead, so we only do it when the number of
  // files we need to process is >= 100 and there are more than 2 CPUs
  // to be able to use at least 2 workers (1 worker per CPU and
  // 1 CPU for the main thread)
  if (totalNumOfFilesToProcess < 100 || getNumberOfWorkers() <= 2) {
    return buildExplicitDependenciesWithoutWorkers(
      jsPluginConfig,
      ctx,
      builder
    );
  } else {
    return buildExplicitDependenciesUsingWorkers(
      jsPluginConfig,
      ctx,
      totalNumOfFilesToProcess,
      builder
    );
  }
}

function totalNumberOfFilesToProcess(ctx: ProjectGraphProcessorContext) {
  let totalNumOfFilesToProcess = 0;
  Object.values(ctx.filesToProcess).forEach(
    (t) => (totalNumOfFilesToProcess += t.length)
  );
  return totalNumOfFilesToProcess;
}

function splitFilesIntoBins(
  ctx: ProjectGraphProcessorContext,
  totalNumOfFilesToProcess: number,
  numberOfWorkers: number
) {
  // we want to have numberOfWorkers * 5 bins
  const filesPerBin =
    Math.round(totalNumOfFilesToProcess / numberOfWorkers / 5) + 1;
  const bins: ProjectFileMap[] = [];
  let currentProjectFileMap = {};
  let currentNumberOfFiles = 0;
  for (const source of Object.keys(ctx.filesToProcess)) {
    for (const f of Object.values(ctx.filesToProcess[source])) {
      if (!currentProjectFileMap[source]) currentProjectFileMap[source] = [];
      currentProjectFileMap[source].push(f);
      currentNumberOfFiles++;

      if (currentNumberOfFiles >= filesPerBin) {
        bins.push(currentProjectFileMap);
        currentProjectFileMap = {};
        currentNumberOfFiles = 0;
      }
    }
  }
  bins.push(currentProjectFileMap);
  return bins;
}

function createWorkerPool(numberOfWorkers: number) {
  const res = [];
  for (let i = 0; i < numberOfWorkers; ++i) {
    res.push(
      new (require('worker_threads').Worker)(
        join(__dirname, './project-graph-worker.js'),
        {
          env: process.env,
        }
      )
    );
  }
  return res;
}

function buildExplicitDependenciesWithoutWorkers(
  jsPluginConfig: {
    analyzeSourceFiles?: boolean;
    analyzePackageJson?: boolean;
  },
  ctx: ProjectGraphProcessorContext,
  builder: ProjectGraphBuilder
) {
  buildExplicitTypescriptAndPackageJsonDependencies(
    jsPluginConfig,
    ctx.nxJsonConfiguration,
    ctx.projectsConfigurations,
    builder.graph,
    ctx.filesToProcess
  ).forEach((r) => {
    builder.addExplicitDependency(
      r.sourceProjectName,
      r.sourceProjectFile,
      r.targetProjectName
    );
  });
}

function buildExplicitDependenciesUsingWorkers(
  jsPluginConfig: {
    analyzeSourceFiles?: boolean;
    analyzePackageJson?: boolean;
  },
  ctx: ProjectGraphProcessorContext,
  totalNumOfFilesToProcess: number,
  builder: ProjectGraphBuilder
) {
  const numberOfWorkers = Math.min(
    totalNumOfFilesToProcess,
    getNumberOfWorkers()
  );
  const bins = splitFilesIntoBins(
    ctx,
    totalNumOfFilesToProcess,
    numberOfWorkers
  );
  const workers = createWorkerPool(numberOfWorkers);
  let numberOfExpectedResponses = bins.length;

  return new Promise((res, reject) => {
    for (let w of workers) {
      w.on('message', (explicitDependencies) => {
        explicitDependencies.forEach((r) => {
          builder.addExplicitDependency(
            r.sourceProjectName,
            r.sourceProjectFile,
            r.targetProjectName
          );
        });
        if (bins.length > 0) {
          w.postMessage({ filesToProcess: bins.shift() });
        }
        // we processed all the bins
        if (--numberOfExpectedResponses === 0) {
          for (let w of workers) {
            w.terminate();
          }
          res(null);
        }
      });
      w.on('error', reject);
      w.on('exit', (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Unable to complete project graph creation. Worker stopped with exit code: ${code}`
            )
          );
        }
      });
      w.postMessage({
        nxJsonConfiguration: ctx.nxJsonConfiguration,
        projectsConfigurations: ctx.projectsConfigurations,
        projectGraph: builder.graph,
        jsPluginConfig,
      });
      w.postMessage({ filesToProcess: bins.shift() });
    }
  });
}

function getNumberOfWorkers(): number {
  return process.env.NX_PROJECT_GRAPH_MAX_WORKERS
    ? +process.env.NX_PROJECT_GRAPH_MAX_WORKERS
    : Math.min(os.cpus().length - 1, 8); // This is capped for cases in CI where `os.cpus()` returns way more CPUs than the resources that are allocated
}

function createContext(
  projectsConfigurations: ProjectsConfigurations,
  nxJson: NxJsonConfiguration,
  fileMap: ProjectFileMap,
  filesToProcess: ProjectFileMap
): ProjectGraphProcessorContext {
  const projects = Object.keys(projectsConfigurations.projects).reduce(
    (map, projectName) => {
      map[projectName] = {
        ...projectsConfigurations.projects[projectName],
      };
      return map;
    },
    {} as Record<string, ProjectConfiguration>
  );
  return {
    nxJsonConfiguration: nxJson,
    projectsConfigurations,
    workspace: {
      ...projectsConfigurations,
      ...nxJson,
      projects,
    },
    fileMap,
    filesToProcess,
  };
}

async function updateProjectGraphWithPlugins(
  context: ProjectGraphProcessorContext,
  initProjectGraph: ProjectGraph
) {
  const plugins = loadNxPlugins(context.workspace.plugins).filter(
    (x) => !!x.processProjectGraph
  );
  let graph = initProjectGraph;
  for (const plugin of plugins) {
    try {
      graph = await plugin.processProjectGraph(graph, context);
    } catch (e) {
      const message = `Failed to process the project graph with "${plugin.name}". This will error in the future!`;
      if (process.env.NX_VERBOSE_LOGGING === 'true') {
        console.error(e);
        logger.error(message);
        return graph;
      } else {
        logger.warn(message);
        logger.warn(`Run with NX_VERBOSE_LOGGING=true to see the error.`);
      }
    }
  }
  return graph;
}

function readRootTsConfig() {
  try {
    const tsConfigPath = getRootTsConfigPath();
    if (tsConfigPath) {
      return readJsonFile(tsConfigPath, { expectComments: true });
    }
  } catch (e) {
    return {};
  }
}
