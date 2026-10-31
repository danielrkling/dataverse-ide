/*
 * Ambient typings for the Solid Babel compilers.
 *
 * Neither @solidjs/babel-plugin (2.x) nor babel-preset-solid (1.x) ships
 * declaration files. We only use the callable default export; Babel itself
 * validates the returned plugin/preset shape.
 */

declare module "@solidjs/babel-plugin" {
  import type { PluginObj } from "@babel/core";

  const plugin: (api: unknown, options?: Record<string, unknown>) => PluginObj;

  export default plugin;
}

declare module "babel-preset-solid" {
  const preset: (api: unknown, options?: Record<string, unknown>) => { plugins?: unknown[] };

  export default preset;
}

declare module "@babel/preset-typescript" {
  const preset: (api: unknown, options?: Record<string, unknown>) => unknown;

  export default preset;
}
