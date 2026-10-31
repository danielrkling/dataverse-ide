import type * as vscodeType from "vscode";

import type {
  ExtensionContext,
  IdeExtension,
  IdeExtensionHttp,
  IdeExtensionSecretStore,
} from "./api.js";

/*
 * Manifest of every IDE extension. Each entry lazily imports its module so
 * a heavy extension (wasm runtimes, node runtime) doesn't affect initial
 * boot until we decide to enable it.
 *
 * To add a feature: create src/extensions/<feature>/extension.ts exporting
 * `default` as an IdeExtension, then add a line here.
 */
export const extensionModules: Record<string, () => Promise<{ default: IdeExtension }>> = {
  git: () => import("./git/extension.js"),
  dataverse: () => import("./dataverse/extension.js"),
  prettier: () => import("./prettier/extension.js"),
  esbuild: () => import("./esbuild/extension.js"),
  html: () => import("./html/extension.js"),
  // "node-runtime": () => import("./node-runtime/extension.js"),
  npm: () => import("./npm/extension.js"),
  gitlab: () => import("./gitlab/extension.js"),
  tailwind: () => import("./tailwind/extension.js"),
  // rolldown: () => import("./rolldown/extension.js"),
  rollup: () => import("./rollup/extension.js"),
  flatten: () => import("./flatten/extension.js"),
  template: () => import("./template/extension.js"),
  scripts: () => import("./scripts/extension.js"),
  // taggedJsx: () => import("./taggedJsx/extension.js"), //gramer not working atm, disabling for now
};

/*
 * Default enable/disable state per extension. This is the fallback used when
 * the user has not overridden the setting in configuration: the Extensions
 * panel writes to "dataverseIde.extensions.enable.<id>", which takes
 * precedence over these defaults.
 */
export const extensionEnabled: Record<string, boolean> = {
  git: true,
  dataverse: true,
  prettier: true,
  esbuild: true,
  html: true,
  "node-runtime": true,
  npm: true,
  gitlab: true,
  tailwind: true,
  rolldown: true,
  rollup: true,
  flatten: true,
  template: true,
  scripts: true,
  taggedJsx: true,
};

export type ActivateExtensionsOptions = {
  vscode: typeof vscodeType;
  workspaceRootUri: vscodeType.Uri;
  workspaceDirectoryHandle?: FileSystemDirectoryHandle;
};

/** Config section owned by the Extensions manager panel. */
const extensionsConfigSection = "dataverseIde.extensions";

/*
 * A user can toggle an extension in the built-in Extensions panel, which
 * persists "enable.<id>" under dataverseIde.extensions. Highest-wins order:
 * user setting > compile-time default.
 *
 * Currently exported for future wiring; activation still uses the static
 * extensionEnabled defaults only.
 */
export function isExtensionEnabled(options: ActivateExtensionsOptions, id: string): boolean {
  const config = options.vscode.workspace.getConfiguration(
    extensionsConfigSection,
    options.workspaceRootUri ?? null,
  );

  return config.get<boolean | undefined>(`enable.${id}`) ?? extensionEnabled[id] ?? false;
}

function createHttpProxy(): IdeExtensionHttp {
  /*
   * Placeholder for the shared auth-aware fetch service. For now this is a
   * plain pass-through; Dataverse token injection lands with the http
   * service work.
   */
  return (input, init) => fetch(input, init);
}

/*
 * The registry runs after the local extension host is initialized, where the
 * secret storage service override provides `vscode.secrets`. The main
 * extension-api typings don't declare it, so we extend the shape locally.
 */
type VscodeWithSecrets = typeof vscodeType & {
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
};

async function createSecretStore(
  vscode: typeof vscodeType,
  id: string,
): Promise<IdeExtensionSecretStore> {
  const secrets = (vscode as VscodeWithSecrets).secrets;

  return {
    get: (key) => secrets.get(`${id}.${key}`),

    set: async (key, value) => {
      await secrets.store(`${id}.${key}`, value);
    },

    remove: (key) => secrets.delete(`${id}.${key}`),
  };
}

export async function activateExtensions(
  options: ActivateExtensionsOptions,
): Promise<vscodeType.Disposable> {
  const disposables: vscodeType.Disposable[] = [];

  /*
   * NOTE: the Extensions manager panel (./manager.ts) is implemented but not
   * wired from here yet. To enable it: dynamically import registerExtensionsPanel
   * here, push its disposable, and switch the gate below to isExtensionEnabled.
   */
  for (const [id, load] of Object.entries(extensionModules)) {
    if (!extensionEnabled[id]) {
      console.info(`[Dataverse IDE] Extension "${id}" is disabled.`);
      continue;
    }

    try {
      const module = await load();
      const outputChannel = options.vscode.window.createOutputChannel(`Dataverse IDE: ${id}`);

      const context: ExtensionContext = {
        id,
        vscode: options.vscode,
        workspaceRootUri: options.workspaceRootUri,
        workspaceDirectoryHandle: options.workspaceDirectoryHandle,
        outputChannel,
        secrets: await createSecretStore(options.vscode, id),
        http: createHttpProxy(),
      };

      const disposable = await module.default.activate(context);

      if (disposable != null) {
        disposables.push(disposable);
      }

      console.info(`[Dataverse IDE] Extension "${id}" activated.`);
    } catch (error) {
      console.error(`[Dataverse IDE] Extension "${id}" failed to activate:`, error);
    }
  }

  return {
    dispose() {
      for (const disposable of disposables.reverse()) {
        try {
          disposable.dispose();
        } catch (error) {
          console.error("[Dataverse IDE] Extension dispose failed:", error);
        }
      }
    },
  };
}
