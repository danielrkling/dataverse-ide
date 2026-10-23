// Stub for `@xterm/addon-ligatures` (optional terminal addon pulled in via a
// dynamic import by monaco-vscode-xterm-addons-common). The real addon imports
// node builtins (`node:diagnostics_channel`) that break browser bundling, and
// it is irrelevant for this browser-hosted IDE - so alias it to this stub in
// vite.config.ts.
export default {}
