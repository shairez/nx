import { updateJestConfigContent } from '../../../utils/jest-utils';
import { NormalizedSchema } from '../schema';
import { offsetFromRoot, Tree, updateJson } from '@nrwl/devkit';

export function updateSpecConfig(host: Tree, options: NormalizedSchema) {
  if (options.unitTestRunner === 'none') {
    return;
  }

  updateJson(host, `${options.appProjectRoot}/tsconfig.spec.json`, (json) => {
    const offset = offsetFromRoot(options.appProjectRoot);
    json.files = [
      `${offset}node_modules/@nrwl/react/typings/cssmodule.d.ts`,
      `${offset}node_modules/@nrwl/react/typings/image.d.ts`,
    ];
    if (options.style === 'styled-jsx') {
      json.files.unshift(
        `${offset}node_modules/@nrwl/react/typings/styled-jsx.d.ts`
      );
    }
    return json;
  });

  if (options.unitTestRunner !== 'jest') {
    return;
  }

  const configPath = `${options.appProjectRoot}/jest.config.${
    options.js ? 'js' : 'ts'
  }`;
  const originalContent = host.read(configPath, 'utf-8');
  const content = updateJestConfigContent(originalContent);
  host.write(configPath, content);
}
