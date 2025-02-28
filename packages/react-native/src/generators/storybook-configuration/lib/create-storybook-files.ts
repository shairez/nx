import {
  generateFiles,
  logger,
  offsetFromRoot,
  readProjectConfiguration,
  toJS,
  Tree,
} from '@nrwl/devkit';
import { join } from 'path';
import * as chalk from 'chalk';

import { StorybookConfigureSchema } from '../schema';

/**
 * This function generate ./storybook under project root.
 */
export async function createStorybookFiles(
  host: Tree,
  schema: StorybookConfigureSchema
) {
  const { root, projectType, targets, sourceRoot } = readProjectConfiguration(
    host,
    schema.name
  );

  // do not proceed if not a react native project
  if (
    targets?.start?.executor !== '@nrwl/react-native:start' &&
    targets?.start?.executor !== '@nrwl/expo:start'
  ) {
    logger.error(
      `Unable to add storybook to ${schema.name}. It is not a Nx React Native / Expo project.`
    );
    return;
  }

  const storybookUIFileName = schema.js ? 'storybook.js' : 'storybook.ts';
  const storybookUIFilePath = join(root, `./${storybookUIFileName}`);

  if (host.exists(storybookUIFilePath)) {
    logger.warn(
      `${storybookUIFileName} file already exists for ${projectType} ${schema.name}! Skipping generating this file.`
    );
    return;
  }
  if (projectType !== 'application') {
    logger.info(
      `${chalk.bold.cyan(
        'info'
      )} To see your Storybook stories on the device, you should start your mobile app for the <platform> of your choice (typically ios or android).`
    );
  }

  // copy files to app's .storybook folder
  generateFiles(
    host,
    join(__dirname, '../files/app'),
    join(root, 'src', 'storybook'),
    {
      tmpl: '',
      offsetFromRoot: offsetFromRoot(sourceRoot),
    }
  );

  // copy files to workspace root's .storybook folder
  generateFiles(
    host,
    join(__dirname, '../files/root'),
    join(root, offsetFromRoot(root), '.storybook'),
    {
      tmpl: '',
    }
  );

  if (schema.js) {
    toJS(host);
  }
}
