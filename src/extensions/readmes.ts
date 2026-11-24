import aiChat from "./ai-chat/README.md?raw";
import dataverse from "./dataverse/README.md?raw";
import esbuild from "./esbuild/README.md?raw";
import flatten from "./flatten/README.md?raw";
import git from "./git/README.md?raw";
import gitlab from "./gitlab/README.md?raw";
import html from "./html/README.md?raw";
import nodeRuntime from "./node-runtime/README.md?raw";
import npm from "./npm/README.md?raw";
import tailwind from "./tailwind/README.md?raw";
import terminal from "./terminal/README.md?raw";
import vsix from "./vsix/README.md?raw";
import welcome from "./welcome/README.md?raw";

/*
 * Bundled README content, keyed by registry key.
 *
 * The registry serves these at boot (before the workbench scans built-in
 * extensions), so the Extensions view can show an extension's README even
 * before it activates, while it is disabled, or when activation stops early
 * (for example an OPFS workspace without a directory handle).
 */
export const extensionReadmes: Record<string, string> = {
  git,
  dataverse,
  esbuild,
  html,
  "node-runtime": nodeRuntime,
  terminal,
  npm,
  gitlab,
  tailwind,
  flatten,
  welcome,
  "ai-chat": aiChat,
  vsix,
};
