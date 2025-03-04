import { existsSync } from 'fs';
import { ensureDirSync, renameSync } from 'fs-extra';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { NxJsonConfiguration } from '../config/nx-json';
import {
  FileData,
  ProjectFileMap,
  ProjectGraph,
  ProjectGraphDependency,
  ProjectGraphExternalNode,
  ProjectGraphProjectNode,
} from '../config/project-graph';
import { ProjectsConfigurations } from '../config/workspace-json-project-json';
import { projectGraphCacheDirectory } from '../utils/cache-directory';
import {
  directoryExists,
  fileExists,
  readJsonFile,
  writeJsonFile,
} from '../utils/fileutils';

export interface ProjectGraphCache {
  version: string;
  deps: Record<string, string>;
  lockFileHash: string;
  pathMappings: Record<string, any>;
  nxJsonPlugins: { name: string; version: string }[];
  pluginsConfig?: any;
  nodes: Record<string, ProjectGraphProjectNode>;
  externalNodes?: Record<string, ProjectGraphExternalNode>;

  // this is only used by scripts that read dependency from the file
  // in the sync fashion.
  dependencies: Record<string, ProjectGraphDependency[]>;
}

export const nxDepsPath = join(projectGraphCacheDirectory, 'nxdeps.json');

export function ensureCacheDirectory(): void {
  try {
    if (!existsSync(projectGraphCacheDirectory)) {
      ensureDirSync(projectGraphCacheDirectory);
    }
  } catch (e) {
    /*
     * @jeffbcross: Node JS docs recommend against checking for existence of directory immediately before creating it.
     * Instead, just try to create the directory and handle the error.
     *
     * We ran into race conditions when running scripts concurrently, where multiple scripts were
     * arriving here simultaneously, checking for directory existence, then trying to create the directory simultaneously.
     *
     * In this case, we're creating the directory. If the operation failed, we ensure that the directory
     * exists before continuing (or raise an exception).
     */
    if (!directoryExists(projectGraphCacheDirectory)) {
      throw new Error(
        `Failed to create directory: ${projectGraphCacheDirectory}`
      );
    }
  }
}

export function readCache(): null | ProjectGraphCache {
  performance.mark('read cache:start');
  ensureCacheDirectory();

  let data = null;
  try {
    if (fileExists(nxDepsPath)) {
      data = readJsonFile(nxDepsPath);
    }
  } catch (error) {
    console.log(
      `Error reading '${nxDepsPath}'. Continue the process without the cache.`
    );
    console.log(error);
  }

  performance.mark('read cache:end');
  performance.measure('read cache', 'read cache:start', 'read cache:end');
  return data ?? null;
}

export function createCache(
  nxJson: NxJsonConfiguration<'*' | string[]>,
  packageJsonDeps: Record<string, string>,
  projectGraph: ProjectGraph,
  tsConfig: { compilerOptions?: { paths?: { [p: string]: any } } },
  lockFileHash: string
) {
  const nxJsonPlugins = (nxJson.plugins || []).map((p) => ({
    name: p,
    version: packageJsonDeps[p],
  }));
  const newValue: ProjectGraphCache = {
    version: projectGraph.version || '5.0',
    deps: packageJsonDeps,
    lockFileHash,
    // compilerOptions may not exist, especially for repos converted through add-nx-to-monorepo
    pathMappings: tsConfig?.compilerOptions?.paths || {},
    nxJsonPlugins,
    pluginsConfig: nxJson.pluginsConfig,
    nodes: projectGraph.nodes,
    externalNodes: projectGraph.externalNodes,
    dependencies: projectGraph.dependencies,
  };
  return newValue;
}

export function writeCache(cache: ProjectGraphCache): void {
  performance.mark('write cache:start');
  let retry = 1;
  let done = false;
  do {
    // write first to a unique temporary filename and then do a
    // rename of the file to the correct filename
    // this is to avoid any problems with half-written files
    // in case of crash and/or partially written files due
    // to multiple parallel processes reading and writing this file
    const unique = (Math.random().toString(16) + '0000000').slice(2, 10);
    const tmpDepsPath = `${nxDepsPath}~${unique}`;

    try {
      writeJsonFile(tmpDepsPath, cache);
      renameSync(tmpDepsPath, nxDepsPath);
      done = true;
    } catch (err: any) {
      if (err instanceof Error) {
        console.log(
          `ERROR (${retry}) when writing \n${err.message}\n${err.stack}`
        );
      } else {
        console.log(
          `ERROR  (${retry}) unknonw error when writing ${nxDepsPath}`
        );
      }
      ++retry;
    }
  } while (!done && retry < 5);
  performance.mark('write cache:end');
  performance.measure('write cache', 'write cache:start', 'write cache:end');
}

export function shouldRecomputeWholeGraph(
  cache: ProjectGraphCache,
  packageJsonDeps: Record<string, string>,
  projects: ProjectsConfigurations,
  nxJson: NxJsonConfiguration,
  tsConfig: { compilerOptions: { paths: { [k: string]: any } } }
): boolean {
  if (cache.version !== '5.0') {
    return true;
  }
  if (cache.deps['@nrwl/workspace'] !== packageJsonDeps['@nrwl/workspace']) {
    return true;
  }
  if (cache.deps['nx'] !== packageJsonDeps['nx']) {
    return true;
  }

  // we have a cached project that is no longer present
  if (
    Object.keys(cache.nodes).some(
      (p) =>
        (cache.nodes[p].type === 'app' ||
          cache.nodes[p].type === 'lib' ||
          cache.nodes[p].type === 'e2e') &&
        !projects.projects[p]
    )
  ) {
    return true;
  }

  // a path mapping for an existing project has changed
  if (
    Object.keys(cache.pathMappings).some((t) => {
      const cached =
        cache.pathMappings && cache.pathMappings[t]
          ? JSON.stringify(cache.pathMappings[t])
          : undefined;
      const notCached =
        tsConfig?.compilerOptions?.paths && tsConfig?.compilerOptions?.paths[t]
          ? JSON.stringify(tsConfig.compilerOptions.paths[t])
          : undefined;
      return cached !== notCached;
    })
  ) {
    return true;
  }

  // a new plugin has been added
  if ((nxJson.plugins || []).length !== cache.nxJsonPlugins.length) return true;

  // a plugin has changed
  if (
    (nxJson.plugins || []).some((t) => {
      const matchingPlugin = cache.nxJsonPlugins.find((p) => p.name === t);
      if (!matchingPlugin) return true;
      return matchingPlugin.version !== packageJsonDeps[t];
    })
  ) {
    return true;
  }

  if (
    JSON.stringify(nxJson.pluginsConfig) !== JSON.stringify(cache.pluginsConfig)
  ) {
    return true;
  }

  return false;
}

/*
This can only be invoked when the list of projects is either the same
or new projects have been added, so every project in the cache has a corresponding
project in fileMap
*/
export function extractCachedFileData(
  fileMap: ProjectFileMap,
  c: ProjectGraphCache
): {
  filesToProcess: ProjectFileMap;
  cachedFileData: { [project: string]: { [file: string]: FileData } };
} {
  const filesToProcess: ProjectFileMap = {};
  const cachedFileData: Record<string, Record<string, FileData>> = {};
  const currentProjects = Object.keys(fileMap).filter(
    (name) => fileMap[name].length > 0
  );
  currentProjects.forEach((p) => {
    processProjectNode(p, c.nodes[p], cachedFileData, filesToProcess, fileMap);
  });

  return {
    filesToProcess,
    cachedFileData,
  };
}

function processProjectNode(
  name: string,
  cachedNode: ProjectGraphProjectNode,
  cachedFileData: { [project: string]: { [file: string]: FileData } },
  filesToProcess: ProjectFileMap,
  fileMap: ProjectFileMap
) {
  if (!cachedNode) {
    filesToProcess[name] = fileMap[name];
    return;
  }

  const fileDataFromCache = {} as any;
  for (let f of (cachedNode.data as any).files) {
    fileDataFromCache[f.file] = f;
  }

  if (!cachedFileData[name]) {
    cachedFileData[name] = {};
  }

  for (let f of fileMap[name]) {
    const fromCache = fileDataFromCache[f.file];
    if (fromCache && fromCache.hash == f.hash) {
      cachedFileData[name][f.file] = fromCache;
    } else {
      if (!filesToProcess[cachedNode.name]) {
        filesToProcess[cachedNode.name] = [];
      }
      filesToProcess[cachedNode.name].push(f);
    }
  }
}
