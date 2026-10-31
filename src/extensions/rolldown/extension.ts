import { createWorkerBundlerExtension } from "../shared/workerBundlerExtension.js";

import {
  ROLLDOWN_DEFAULT_CONFIG,
  configFilePath,
  configRelativePathFor,
  readRolldownConfig,
  updateRolldownConfig,
} from "./config.js";

import rolldownWorkerUrl from "./worker.ts?worker&url";

/*
 * rolldown extension: oxc-powered WASM compilation + full bundling in a
 * dedicated worker (via @rolldown/browser).
 *
 * The command surface, config contract, lazy-resolution loop, watch engine
 * and output writer are shared with the rollup extension through
 * ../shared/workerBundlerExtension.ts. This module only binds the rolldown
 * config file and worker entry.
 */
export default createWorkerBundlerExtension({
  id: "rolldown",
  label: "rolldown",
  displayName: "Dataverse IDE Rolldown (oxc wasm)",
  description: "oxc-powered transform/minify and full bundling via @rolldown/browser.",
  configFileName: "rolldown.config.json",
  workerUrl: rolldownWorkerUrl,
  config: {
    defaults: ROLLDOWN_DEFAULT_CONFIG,
    read: readRolldownConfig,
    update: updateRolldownConfig,
    filePath: configFilePath,
    relativePath: configRelativePathFor,
  },
});
