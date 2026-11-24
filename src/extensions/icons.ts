/*
 * Icons for the in-house extensions in the built-in Extensions view.
 *
 * Extension manifests can only point at a path relative to the extension
 * location (`extension-file://…/extension/`). The real SVG files live under
 * `public/extensions/`, so each extension registers its relative icon path
 * with `registerFileUrl()`, which maps it to the served URL.
 */

const EXTENSION_ICON_FILES: Record<string, string> = {
  git: "git.svg",
  dataverse: "dataverse.svg",
  esbuild: "esbuild.svg",
  html: "html.svg",
  "node-runtime": "node-runtime.svg",
  terminal: "terminal.svg",
  npm: "npm.svg",
  gitlab: "gitlab.svg",
  tailwind: "tailwind.svg",
  flatten: "flatten.svg",
  welcome: "welcome.svg",
  markdown: "markdown.svg",
  "ai-chat": "ai-chat.svg",
  vsix: "vsix.svg",
};

const EXTENSION_ICON_PATH = "extension-icon.svg";

export type RegisterIconFile = (path: string, url: string) => { dispose(): void };

/** Manifest-relative path for an extension's icon, or undefined when it has none. */
export function extensionIconPath(id: string): string | undefined {
  return EXTENSION_ICON_FILES[id] == null ? undefined : EXTENSION_ICON_PATH;
}

/** Absolute URL of the served icon asset, or undefined when the id has none. */
export function extensionIconUrl(id: string): string | undefined {
  const file = EXTENSION_ICON_FILES[id];

  return file == null ? undefined : new URL(`extensions/${file}`, document.baseURI).href;
}

/** Add the icon entry to a manifest before it is registered. */
export function withExtensionIcon<T extends object>(manifest: T, id: string): T {
  const path = extensionIconPath(id);

  if (path != null) {
    (manifest as { icon?: string }).icon = path;
  }

  return manifest;
}

/** Point the manifest icon path at the served SVG asset. */
export function registerExtensionIcon(id: string, registerFileUrl: RegisterIconFile): void {
  const path = extensionIconPath(id);
  const url = extensionIconUrl(id);

  if (path != null && url != null) {
    registerFileUrl(path, url);
  }
}
