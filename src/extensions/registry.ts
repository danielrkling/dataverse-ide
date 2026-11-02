import type * as vscodeType from "vscode";

import { getService } from "@codingame/monaco-vscode-api";
import {
  ExtensionHostKind,
  getBuiltinExtensions,
  registerExtension,
  type IExtensionManifest,
} from "@codingame/monaco-vscode-api/extensions";
import { servicesInitialized } from "@codingame/monaco-vscode-api/lifecycle";
import { IExtensionService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensions.service";
import { IWorkbenchExtensionEnablementService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensionManagement/common/extensionManagement.service";
import { IWorkbenchExtensionManagementService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensionManagement/common/extensionManagement.service";
import type { ILocalExtension } from "@codingame/monaco-vscode-api/vscode/vs/platform/extensionManagement/common/extensionManagement";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  ExtensionType,
  TargetPlatform,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/extensions/common/extensions";
import type { IExtension } from "@codingame/monaco-vscode-api/vscode/vs/platform/extensions/common/extensions";

import type {
  ExtensionContext,
  IdeExtension,
  IdeExtensionHttp,
  IdeExtensionSecretStore,
} from "./api.js";
import { markPlaceholder } from "./placeholders.js";

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
  "node-runtime": () => import("./node-runtime/extension.js"),
  npm: () => import("./npm/extension.js"),
  gitlab: () => import("./gitlab/extension.js"),
  tailwind: () => import("./tailwind/extension.js"),
  flatten: () => import("./flatten/extension.js"),
  scripts: () => import("./scripts/extension.js"),
  welcome: () => import("./welcome/extension.js"),
  // taggedJsx: () => import("./taggedJsx/extension.js"), //gramer not working atm, disabling for now
};

/*
 * Identity of the extension manifest each module contributes. The built-in
 * Extensions view uses these ids, so they must match the publisher/name used
 * by the extension's own `registerExtension`/`contributeExtensionManifest`
 * call.
 */
export type ExtensionManifestIdentity = {
  publisher: string;
  name: string;
  displayName: string;
  description: string;
};

export const extensionManifests: Record<string, ExtensionManifestIdentity> = {
  git: {
    publisher: "dataverse",
    name: "dataverse-git",
    displayName: "Dataverse IDE Git",
    description: "Browser-based Git status integration for Dataverse IDE.",
  },
  dataverse: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-dataverse",
    displayName: "Dataverse IDE Dataverse",
    description: "Web resource upload and settings management.",
  },
  prettier: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-prettier",
    displayName: "Dataverse IDE Prettier",
    description: "Format documents with Prettier.",
  },
  esbuild: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-esbuild",
    displayName: "Dataverse IDE esbuild",
    description: "esbuild-wasm bundling for workspace files.",
  },
  html: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-html",
    displayName: "Dataverse IDE HTML",
    description: "Inline local scripts, stylesheets, SVGs and assets into self-contained HTML.",
  },
  "node-runtime": {
    publisher: "dataverse-ide",
    name: "dataverse-ide-node-runtime",
    displayName: "Dataverse IDE Node Runtime",
    description: "Run JavaScript/TypeScript files against the workspace filesystem directly.",
  },
  npm: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-npm",
    displayName: "Dataverse IDE npm",
    description: "Install and manage npm packages in the workspace.",
  },
  gitlab: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-gitlab",
    displayName: "Dataverse IDE GitLab",
    description: "Merge requests, issues and pipelines for GitLab projects.",
  },
  tailwind: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-tailwind",
    displayName: "Dataverse IDE Tailwind",
    description: "Compile Tailwind CSS for the workspace.",
  },
  flatten: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-flatten",
    displayName: "Dataverse IDE Flatten",
    description: "Combine selected files into a single markdown document.",
  },
  scripts: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-scripts",
    displayName: "Dataverse IDE Scripts",
    description: "Run user-defined series/parallel command scripts.",
  },
  welcome: {
    publisher: "dataverse-ide",
    name: "dataverse-ide-welcome",
    displayName: "Dataverse IDE Welcome",
    description: "Landing page describing the IDE's features and extensions.",
  },
};

export function extensionId(identity: ExtensionManifestIdentity): string {
  return `${identity.publisher}.${identity.name}`.toLowerCase();
}

/*
 * Minimal local-extension shape for enablement checks. We deliberately do not
 * wait for the management service to scan installed extensions: that scan can
 * be slow (or never complete in some sandboxed environments), and enablement
 * only needs the identifier, manifest, location and type.
 */
function placeholderExtension(identity: ExtensionManifestIdentity): ILocalExtension {
  const id = extensionId(identity);

  return {
    identifier: { id },
    manifest: {
      name: identity.name,
      publisher: identity.publisher,
      version: "0.1.0",
      engines: {
        vscode: "*",
      },
      displayName: identity.displayName,
      description: identity.description,
    },
    location: URI.from({ scheme: "extension-file", authority: id, path: "/extension" }),
    type: ExtensionType.User,
    isBuiltin: true,
    isValid: true,
    validations: [],
  } as unknown as ILocalExtension;
}

/*
 * Minimal built-in extension entry. Normally `registerExtension` adds this
 * itself, but only while services are still uninitialized. If something has
 * already initialized them (different module-order in dev/build), the entry
 * would otherwise miss the built-in scanner and the Extensions view would be
 * empty, so add it to the scanner input manually.
 */
function builtinExtensionFor(identity: ExtensionManifestIdentity): IExtension {
  const id = extensionId(identity);

  return {
    manifest: {
      name: identity.name,
      publisher: identity.publisher,
      version: "0.1.0",
      engines: {
        vscode: "*",
      },
      displayName: identity.displayName,
      description: identity.description,
    },
    type: ExtensionType.User,
    isBuiltin: true,
    identifier: { id },
    location: URI.from({ scheme: "extension-file", authority: id, path: "/extension" }),
    targetPlatform: TargetPlatform.WEB,
    isValid: true,
    validations: [],
    preRelease: false,
  } as unknown as IExtension;
}

/*
 * Register a minimal manifest for every extension before the workbench
 * initializes. `registerExtension` only adds to the built-in extension list
 * in that phase, which is what the Extensions view scans. The real manifest
 * replaces the placeholder when the extension activates.
 */
export function registerExtensionPlaceholders(): void {
  const builtinsBefore = getBuiltinExtensions().length;

  console.info(
    "[Dataverse IDE] Built-in extensions before placeholders:",
    builtinsBefore,
    "servicesInitialized:",
    servicesInitialized,
  );

  for (const identity of Object.values(extensionManifests)) {
    const manifest: IExtensionManifest = {
      name: identity.name,
      publisher: identity.publisher,
      version: "0.1.0",
      engines: {
        vscode: "*",
      },
      displayName: identity.displayName,
      description: identity.description,
    };

    const id = extensionId(identity);

    markPlaceholder(id);
    registerExtension(manifest, ExtensionHostKind.LocalProcess);

    const builtins = getBuiltinExtensions();

    if (!builtins.some((extension) => extension.identifier.id.toLowerCase() === id)) {
      builtins.push(builtinExtensionFor(identity));
    }
  }

  console.info(
    "[Dataverse IDE] Built-in extensions after placeholders:",
    getBuiltinExtensions().length,
  );
}

export type ActivateExtensionsOptions = {
  vscode: typeof vscodeType;
  workspaceRootUri: vscodeType.Uri;
  workspaceDirectoryHandle?: FileSystemDirectoryHandle;
};

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

  console.info("[Dataverse IDE] Resolving extension enablement.");

  let enablementService: IWorkbenchExtensionEnablementService | undefined;

  try {
    enablementService = await getService(IWorkbenchExtensionEnablementService);
  } catch (error) {
    /*
     * Extension enablement is optional: if it is unavailable, keep the old
     * behavior and activate everything.
     */
    console.warn(
      "[Dataverse IDE] Extension enablement is unavailable; activating all extensions.",
      error,
    );
  }

  const inHouseExtensionIds = new Set(
    Object.values(extensionManifests).map((identity) => extensionId(identity)),
  );

  /*
   * Diagnostic only: the built-in Extensions view can render empty when the
   * management service scan never settles. Do not block activation on it.
   */
  void (async () => {
    try {
      const extensionService = await getService(IExtensionService);
      await Promise.race([
        extensionService.whenInstalledExtensionsRegistered(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("registry timed out")), 5000);
        }),
      ]);
      console.info("[Dataverse IDE] Extension registry ready:", extensionService.extensions.length);
    } catch (error) {
      console.warn("[Dataverse IDE] Extension registry did not become ready:", error);
    }
  })();

  void (async () => {
    try {
      const management = await getService(IWorkbenchExtensionManagementService);
      const installed = await Promise.race([
        management.getInstalled(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("scan timed out")), 5000);
        }),
      ]);

      console.info(
        "[Dataverse IDE] Installed extensions:",
        installed.map(
          (extension) => `${extension.identifier.id}${extension.isBuiltin ? " (built-in)" : ""}`,
        ),
      );
    } catch (error) {
      console.warn("[Dataverse IDE] Extension scan failed:", error);
    }
  })();

  console.info("[Dataverse IDE] Activating extensions.");

  for (const [id, load] of Object.entries(extensionModules)) {
    const identity = extensionManifests[id];

    if (identity != null && enablementService != null) {
      try {
        if (!enablementService.isEnabled(placeholderExtension(identity))) {
          console.info(`[Dataverse IDE] Extension "${id}" is disabled.`);
          continue;
        }
      } catch (error) {
        console.warn(
          `[Dataverse IDE] Could not read enablement for extension "${id}"; activating it.`,
          error,
        );
      }
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

  if (enablementService != null) {
    /*
     * The built-in manager updates VS Code's enablement state, not our manual
     * activation loop. Prompt a reload so the new state takes effect.
     */
    disposables.push(
      enablementService.onEnablementChanged((extensions) => {
        const changed = extensions.some((extension) =>
          inHouseExtensionIds.has(extension.identifier.id.toLowerCase()),
        );

        if (!changed) {
          return;
        }

        void options.vscode.window
          .showInformationMessage("Reload to apply extension changes.", "Reload")
          .then((choice) => {
            if (choice === "Reload") {
              location.reload();
            }
          });
      }),
    );
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
