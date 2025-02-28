import type { Tree } from '@nrwl/devkit';
import {
  generateFiles,
  joinPathFragments,
  readJson,
  readNxJson,
  updateNxJson,
} from '@nrwl/devkit';
import { backwardCompatibleVersions } from '../../../utils/backward-compatible-versions';
import { addDependenciesToPackageJsonIfDontExist } from '../../utils/version-utils';
import { GeneratorOptions } from './schema';

function addTestInputs(tree: Tree) {
  const nxJson = readNxJson(tree);

  const productionFileSet = nxJson.namedInputs?.production;
  if (productionFileSet) {
    productionFileSet.push(
      // Exclude spec files from production fileset
      '!{projectRoot}/**/*.spec.[jt]s',
      // Remove tsconfig.spec.json
      '!{projectRoot}/tsconfig.spec.json',
      // Remove karma.conf.js
      '!{projectRoot}/karma.conf.js'
    );
    // Dedupe and set
    nxJson.namedInputs.production = Array.from(new Set(productionFileSet));
  }

  // Test targets depend on all their project's sources + production sources of dependencies
  nxJson.targetDefaults ??= {};
  nxJson.targetDefaults.test ??= {};
  nxJson.targetDefaults.test.inputs ??= [
    'default',
    productionFileSet ? '^production' : '^default',
  ];
  nxJson.targetDefaults.test.inputs.push('{workspaceRoot}/karma.conf.js');

  updateNxJson(tree, nxJson);
}

export function karmaGenerator(tree: Tree, options: GeneratorOptions) {
  const packageJson = readJson(tree, 'package.json');

  if (!tree.exists('karma.conf.js')) {
    generateFiles(tree, joinPathFragments(__dirname, 'files'), '.', {
      tmpl: '',
    });

    addTestInputs(tree);
  }

  if (options.skipPackageJson || packageJson.devDependencies['karma']) {
    return () => {};
  }

  return addDependenciesToPackageJsonIfDontExist(
    tree,
    {},
    {
      karma: backwardCompatibleVersions.angularV14.karmaVersion,
      'karma-chrome-launcher':
        backwardCompatibleVersions.angularV14.karmaChromeLauncherVersion,
      'karma-coverage':
        backwardCompatibleVersions.angularV14.karmaCoverageVersion,
      'karma-jasmine':
        backwardCompatibleVersions.angularV14.karmaJasmineVersion,
      'karma-jasmine-html-reporter':
        backwardCompatibleVersions.angularV14.karmaJasmineHtmlReporterVersion,
      'jasmine-core': backwardCompatibleVersions.angularV14.jasmineCoreVersion,
      'jasmine-spec-reporter':
        backwardCompatibleVersions.angularV14.jasmineSpecReporterVersion,
      '@types/jasmine':
        backwardCompatibleVersions.angularV14.typesJasmineVersion,
      '@types/node': backwardCompatibleVersions.angularV14.typesNodeVersion,
    }
  );
}

export default karmaGenerator;
