/**
 * @Copyright (c) Microsoft Corporation.  All rights reserved.
 */

import * as child_process from 'child_process';
import * as colors from 'colors';
import * as glob from 'glob';
import globEscape = require('glob-escape');
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import CommandLineAction from '../commandLine/CommandLineAction';
import JsonFile from '../utilities/JsonFile';
import RushCommandLineParser from './RushCommandLineParser';
import RushConfig from '../data/RushConfig';
import Utilities from '../utilities/Utilities';
import { CommandLineFlagParameter } from '../commandLine/CommandLineParameter';

export default class GenerateAction extends CommandLineAction {
  private _parser: RushCommandLineParser;
  private _rushConfig: RushConfig;
  private _lazyParameter: CommandLineFlagParameter;

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'generate',
      summary: 'Run this command after changing any project\'s package.json.',
      documentation: 'Run "rush regenerate" after changing any project\'s package.json.'
      + ' It scans the dependencies for all projects referenced in "rush.json", and then'
      + ' constructs a superset package.json in the Rush common folder.'
      + ' After running this command, you will need to commit your changes to git.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._lazyParameter = this.defineFlagParameter({
      parameterLongName: '--lazy',
      parameterShortName: '-l',
      description: 'Do not clean the "node_modules" folder before running "npm install".'
        + ' This is faster, but less correct, so only use it for debugging.'
    });
  }

  protected onExecute(): void {
    this._rushConfig = this._rushConfig = RushConfig.loadFromDefaultLocation();

    const startTime: number = Utilities.getTimeInMs();
    console.log('Starting "rush prepare"' + os.EOL);

    // 1. Delete "common\node_modules"
    const nodeModulesPath: string = path.join(this._rushConfig.commonFolder, 'node_modules');

    if (this._lazyParameter.value) {
      // In the lazy case, we keep the existing common/node_modules.  However, we need to delete
      // the temp projects (that were copied from common/temp_modules into common/node_modules).
      // We can recognize them because their names start with "rush-"
      console.log('Deleting common/node_modules/rush-*');
      for (const tempModulePath of glob.sync(globEscape(nodeModulesPath.replace('\\', '/')) + '/rush-*')) {
        Utilities.dangerouslyDeletePath(tempModulePath);
      }
    } else {
      if (fs.existsSync(nodeModulesPath)) {
        console.log('Deleting common/node_modules folder...');
        Utilities.dangerouslyDeletePath(nodeModulesPath);
      }
    }

    // 2. Delete "common\temp_modules"
    const tempModulesPath: string = path.join(this._rushConfig.commonFolder, 'temp_modules');

    if (fs.existsSync(tempModulesPath)) {
      console.log('Deleting common/temp_modules folder');
      Utilities.dangerouslyDeletePath(tempModulesPath);
    }

    // 3. Delete the previous npm-shrinkwrap.json
    const shrinkwrapFilename: string = path.join(this._rushConfig.commonFolder, 'npm-shrinkwrap.json');

    if (fs.existsSync(shrinkwrapFilename)) {
      console.log('Deleting common/npm-shrinkwrap.json');
      Utilities.dangerouslyDeletePath(shrinkwrapFilename);
    }

    // 4. Construct common\package.json and common\temp_modules
    console.log('Creating a clean common/temp_modules folder');
    Utilities.createFolderWithRetry(tempModulesPath);

    let commonPackageJson: PackageJson = {
      dependencies: {},
      description: 'Temporary file generated by the Rush tool',
      name: 'rush-common',
      private: true,
      version: '0.0.0'
    };

    console.log('Creating temp projects...');
    for (let rushProject of this._rushConfig.projects) {
      const packageJson: PackageJson = rushProject.packageJson;

      const tempProjectName: string = rushProject.tempProjectName;

      const tempProjectFolder: string = path.join(tempModulesPath, tempProjectName);
      fs.mkdirSync(tempProjectFolder);

      commonPackageJson.dependencies[tempProjectName] = 'file:./temp_modules/' + tempProjectName;

      const tempPackageJsonFilename: string = path.join(tempProjectFolder, 'package.json');

      const tempPackageJson: PackageJson = {
        name: tempProjectName,
        version: '0.0.0',
        private: true,
        dependencies: {}
      };

      // If there are any optional dependencies, copy them over directly
      if (packageJson.optionalDependencies) {
        tempPackageJson.optionalDependencies = packageJson.optionalDependencies;
      }

      // Collect pairs of (packageName, packageVersion) to be added as temp package dependencies
      const pairs: { packageName: string, packageVersion: string }[] = [];

      // If there are devDependencies, we need to merge them with the regular
      // dependencies.  If the same library appears in both places, then the
      // regular dependency takes precedence over the devDependency.
      // It also takes precedence over a duplicate in optionalDependencies,
      // but NPM will take care of that for us.  (Frankly any kind of duplicate
      // should be an error, but NPM is pretty lax about this.)
      if (packageJson.devDependencies) {
        for (let packageName of Object.keys(packageJson.devDependencies)) {
          pairs.push({ packageName: packageName, packageVersion: packageJson.devDependencies[packageName] });
        }
      }

      if (packageJson.dependencies) {
        for (let packageName of Object.keys(packageJson.dependencies)) {
          pairs.push({ packageName: packageName, packageVersion: packageJson.dependencies[packageName] });
        }
      }

      for (const pair of pairs) {
        if (this._rushConfig.getProjectByName(pair.packageName)) {
          // If this is a locally buildable dependency, then it's possible that it hasn't
          // actually been published yet, in which case we could build it using "rush link",
          // so we treat it as an optional dependency.
          if (!tempPackageJson.optionalDependencies) {
            tempPackageJson.optionalDependencies = {};
          }
          tempPackageJson.optionalDependencies[pair.packageName] = pair.packageVersion;
        } else {
          // Otherwise, add it as a regular dependency.
          tempPackageJson.dependencies[pair.packageName] = pair.packageVersion;
        }
      }

      JsonFile.saveJsonFile(tempPackageJson, tempPackageJsonFilename);
    }

    console.log('Writing common/package.json');
    const commonPackageJsonFilename: string = path.join(this._rushConfig.commonFolder, 'package.json');
    JsonFile.saveJsonFile(commonPackageJson, commonPackageJsonFilename);

    // 5. Run "npm install" and "npm shrinkwrap"
    const options = {
      cwd: this._rushConfig.commonFolder,
      stdio: [0, 1, 2] // (omit this to suppress gulp console output)
    };

    console.log(os.EOL + colors.bold('Running "npm install"...'));
    child_process.execSync(this._rushConfig.npmToolFilename + ' install', options);
    console.log('"npm install" completed' + os.EOL);

    if (this._lazyParameter.value) {
      // If we're not doing it for real, then don't bother with "npm shrinkwrap"
      console.log(os.EOL + colors.bold('(Skipping "npm shrinkwrap")') + os.EOL);
    } else {
      console.log(os.EOL + colors.bold('Running "npm shrinkwrap"...'));
      child_process.execSync(this._rushConfig.npmToolFilename + ' shrinkwrap', options);
      console.log('"npm shrinkwrap" completed' + os.EOL);
    }

    const endTime: number = Utilities.getTimeInMs();
    const totalSeconds: string = ((endTime - startTime) / 1000.0).toFixed(2);

    console.log(os.EOL + colors.green(`Rush prepare finished successfully. (${totalSeconds} seconds)`));
    console.log(os.EOL + 'Next you should probably run: "rush link"');
  }
}
