/*
 * Minimal `process` shim for browser/worker contexts.
 *
 * The rolldown wasm glue (and some pthread init paths) reference `process`.
 * Browsers and dedicated workers have no such global; guarded checks in
 * library code only read env/cwd/versions. This module installs a minimal
 * shim. Imported FIRST by the rolldown worker so the shim is active before
 * any dynamically imported glue chunk evaluates.
 */

interface MinimalProcess {
  env: Record<string, string>;
  argv: string[];
  version: string;
  versions: Record<string, string>;
  platform: string;
  browser: boolean;
  title: string;
  cwd: () => string;
  umask: () => number;
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
  emit: () => boolean;
  on: () => number;
  once: () => number;
  off: () => number;
  removeListener: () => number;
  removeAllListeners: () => number;
  listeners: () => unknown[];
  binding: (name: string) => never;
  chdir: () => never;
  exit: (code: number) => never;
}

declare global {
  var process: MinimalProcess | undefined;
}

function installProcessShim(): void {
  const target = globalThis as typeof globalThis & { process?: MinimalProcess };

  if (target.process != null) {
    return;
  }

  target.process = {
    env: {},
    argv: [],
    version: "",
    versions: {},
    platform: "browser",
    browser: true,
    title: "browser",
    cwd: () => "/",
    umask: () => 0,
    nextTick: (callback, ...args) => {
      void Promise.resolve().then(() => callback(...args));
    },
    emit: () => false,
    on: () => 0,
    once: () => 0,
    off: () => 0,
    removeListener: () => 0,
    removeAllListeners: () => 0,
    listeners: () => [],
    binding: (name) => {
      throw new Error(`process.binding is not supported: ${name}`);
    },
    chdir: () => {
      throw new Error("process.chdir is not supported");
    },
    exit: (code) => {
      throw new Error(`process.exit('${code}') is not supported`);
    },
  };
}

installProcessShim();

export {};
