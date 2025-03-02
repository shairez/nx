// This file should be committed to your repository! It wraps Nx and ensures
// that your local installation matches nx.json.
// See: https://nx.dev/more-concepts/encapsulated-nx-and-the-wrapper for more info.
//
//# The contents of this file are executed before packages are installed.
//# As such, we should not import anything from nx, other @nrwl packages,
//# or any other npm packages. Only import node builtins.

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const cp: typeof import('child_process') = require('child_process');

import type { NxJsonConfiguration } from '../../config/nx-json';
import type { PackageJson } from '../../utils/package-json';

const installationPath = path.join(__dirname, 'installation', 'package.json');

function matchesCurrentNxInstall(
  nxJsonInstallation: NxJsonConfiguration['installation']
) {
  try {
    const currentInstallation: PackageJson = require(installationPath);
    if (
      currentInstallation.devDependencies['nx'] !==
        nxJsonInstallation.version ||
      require(path.join(
        path.dirname(installationPath),
        'node_modules',
        'nx',
        'package.json'
      )).version !== nxJsonInstallation.version
    ) {
      return false;
    }
    for (const [plugin, desiredVersion] of Object.entries(
      nxJsonInstallation.plugins || {}
    )) {
      if (currentInstallation.devDependencies[plugin] !== desiredVersion) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function ensureUpToDateInstallation() {
  const nxJsonPath = path.join(__dirname, '..', 'nx.json');

  let nxJson: NxJsonConfiguration;

  try {
    nxJson = require(nxJsonPath);
  } catch {
    console.error(
      '[NX]: nx.json is required when running in encapsulated mode. Run `npx nx init --encapsulated` to restore it.'
    );
    process.exit(1);
  }

  try {
    ensureDir(path.join(__dirname, 'installation'));
    if (!matchesCurrentNxInstall(nxJson.installation)) {
      fs.writeFileSync(
        installationPath,
        JSON.stringify({
          name: 'nx-installation',
          devDependencies: {
            nx: nxJson.installation.version,
            ...nxJson.installation.plugins,
          },
        })
      );
      cp.execSync('npm i --legacy-peer-deps', {
        cwd: path.dirname(installationPath),
        stdio: 'inherit',
      });
    }
  } catch (e) {
    console.error('[NX]: Nx wrapper failed to synchronize installation.');
    console.error(e.stack());
    process.exit(1);
  }
}

if (require.main === module) {
  ensureUpToDateInstallation();
  require('./installation/node_modules/nx/bin/nx');
}
