/*
 * Builtin module registry for the direct-fs runtime.
 *
 * Most Node builtins come straight from almostnode's browser shims. The
 * remainder are small local stand-ins (os/tty/crypto/async_hooks/...), plus
 * our own fs implementation backed by vscode.workspace.fs.
 */

import {
  assert as assertShim,
  chokidar as chokidarShim,
  esbuild as esbuildShim,
  events as eventsShim,
  fsevents as fseventsShim,
  http as httpShim,
  module as moduleShim,
  net as netShim,
  path as pathShim,
  perf_hooks as perfHooksShim,
  querystring as querystringShim,
  readdirp as readdirpShim,
  rollup as rollupShim,
  stream as streamShim,
  url as urlShim,
  util as utilShim,
  worker_threads as workerThreadsShim,
  ws as wsShim,
} from "almostnode";

import type { Process } from "almostnode";

import { Buffer } from "buffer";
import * as bufferShim from "buffer";

import * as zlibShim from "../../stubs/zlibShim.js";

export type RequireFunction = ((id: string) => unknown) & {
  resolve: (id: string) => string;
  cache: Record<string, unknown>;
};

type RequestOptions = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  hostname?: string;
  host?: string;
  port?: number;
};

type ResponseCallback = (response: unknown) => void;

export type BuiltinOptions = {
  process: Process;
  fs: Record<string, unknown>;
  fsPromises: Record<string, unknown>;
  createRequireAt: (filename: string) => RequireFunction;
  onConsole?: (method: string, args: unknown[]) => void;
};

export type Builtins = {
  has: (id: string) => boolean;
  get: (id: string) => unknown;
  console: Console;
};

function createConsole(onConsole?: (method: string, args: unknown[]) => void): Console {
  function emit(method: string, args: unknown[]): void {
    const target = (console as unknown as Record<string, unknown>)[method];

    if (typeof target === "function") {
      (target as (...values: unknown[]) => void).apply(console, args);
    }

    onConsole?.(method, args);
  }

  return {
    log: (...args: unknown[]) => emit("log", args),
    error: (...args: unknown[]) => emit("error", args),
    warn: (...args: unknown[]) => emit("warn", args),
    info: (...args: unknown[]) => emit("info", args),
    debug: (...args: unknown[]) => emit("debug", args),
    trace: (...args: unknown[]) => emit("trace", args),
    dir: (...args: unknown[]) => emit("dir", args),
    table: (...args: unknown[]) => emit("table", args),
    assert: (condition?: boolean, ...args: unknown[]) => {
      if (!condition) {
        emit("error", ["Assertion failed:", ...args]);
      }
    },
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    count: () => {},
    countReset: () => {},
    group: (...args: unknown[]) => emit("group", args),
    groupCollapsed: (...args: unknown[]) => emit("group", args),
    groupEnd: () => {},
    clear: () => {},
    dirxml: () => {},
    profile: () => {},
    profileEnd: () => {},
    timeStamp: () => {},
  } as unknown as Console;
}

function createOsShim(): Record<string, unknown> {
  return {
    EOL: "\n",
    hostname: () => "localhost",
    platform: () => "linux",
    arch: () => "x64",
    type: () => "Linux",
    release: () => "5.10.0",
    version: () => "#1 SMP",
    machine: () => "x86_64",
    tmpdir: () => "/tmp",
    homedir: () => "/home/user",
    cpus: () => [
      {
        model: "Virtual CPU",
        speed: 2400,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      },
    ],
    totalmem: () => 4 * 1024 * 1024 * 1024,
    freemem: () => 2 * 1024 * 1024 * 1024,
    uptime: () => Math.floor(performance.now() / 1000),
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),
    userInfo: () => ({
      username: "user",
      uid: 1000,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/user",
    }),
    constants: {},
  };
}

function createTtyShim(): Record<string, unknown> {
  class TtyStream {
    isTTY = false;
    write() {
      return true;
    }
    end() {}
    on() {
      return this;
    }
    once() {
      return this;
    }
  }

  return {
    isatty: () => false,
    ReadStream: TtyStream,
    WriteStream: TtyStream,
  };
}

function createCryptoShim(): Record<string, unknown> {
  const webcrypto = globalThis.crypto;

  return {
    webcrypto,
    subtle: webcrypto?.subtle,
    getRandomValues: (array: ArrayBufferView) => webcrypto.getRandomValues(array as never),
    randomBytes: (size: number) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(size))),
    randomFillSync: (buffer: Uint8Array, offset = 0, size = buffer.length - offset) => {
      webcrypto.getRandomValues(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, size));
      return buffer;
    },
    randomUUID: () => webcrypto.randomUUID(),
    randomInt: (min: number, max?: number) => {
      const upper = max ?? min;
      const lower = max == null ? 0 : min;
      const value = webcrypto.getRandomValues(new Uint32Array(1))[0];

      return lower + (value % (upper - lower));
    },
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
      if (a.length !== b.length) {
        return false;
      }

      let result = 0;
      for (let index = 0; index < a.length; index += 1) {
        result |= a[index] ^ b[index];
      }

      return result === 0;
    },
    createHash: () => {
      throw new Error("crypto.createHash is not available in the direct-fs runtime yet.");
    },
  };
}

function createAsyncHooksShim(): Record<string, unknown> {
  class AsyncLocalStorage<T = unknown> {
    run<R>(_store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
      return callback(...args);
    }

    getStore(): T | undefined {
      return undefined;
    }

    enterWith(): void {}
    exit(): void {}
    disable(): void {}
  }

  class AsyncResource {
    constructor(readonly type: string) {}

    runInAsyncScope<R>(
      callback: (...args: unknown[]) => R,
      thisArg?: unknown,
      ...args: unknown[]
    ): R {
      return callback.apply(thisArg, args);
    }

    emitDestroy(): void {}
    asyncId(): number {
      return 0;
    }
    triggerAsyncId(): number {
      return 0;
    }
  }

  return {
    AsyncLocalStorage,
    AsyncResource,
    createHook: () => ({
      enable() {},
      disable() {},
    }),
    executionAsyncId: () => 0,
    triggerAsyncId: () => 0,
    executionAsyncResource: () => ({}),
  };
}

function createChildProcessShim(): Record<string, unknown> {
  function unavailable(name: string): never {
    throw new Error(`child_process.${name} is not available in the direct-fs runtime.`);
  }

  return {
    exec: () => unavailable("exec"),
    execFile: () => unavailable("execFile"),
    execSync: () => unavailable("execSync"),
    spawn: () => unavailable("spawn"),
    spawnSync: () => unavailable("spawnSync"),
    fork: () => unavailable("fork"),
  };
}

function createDnsShim(): Record<string, unknown> {
  function fail(callback?: (error: Error) => void): void {
    queueMicrotask(() => callback?.(new Error("dns is not available")));
  }

  return {
    lookup: (_hostname: string, _options: unknown, callback?: unknown) =>
      fail(callback as (error: Error) => void),
    resolve: (_hostname: string, _rrtype: unknown, callback?: unknown) =>
      fail(callback as (error: Error) => void),
    resolve4: (_hostname: string, callback?: unknown) => fail(callback as (error: Error) => void),
    resolve6: (_hostname: string, callback?: unknown) => fail(callback as (error: Error) => void),
    promises: {
      lookup: () => Promise.reject(new Error("dns is not available")),
      resolve: () => Promise.reject(new Error("dns is not available")),
    },
  };
}

function createTlsShim(): Record<string, unknown> {
  return {
    ...netShim,
    connect: () => {
      throw new Error("tls.connect is not available in the direct-fs runtime.");
    },
    createServer: () => {
      throw new Error("tls.createServer is not available in the direct-fs runtime.");
    },
  };
}

function createHttp2Shim(): Record<string, unknown> {
  return {
    connect: () => {
      throw new Error("http2.connect is not available in the direct-fs runtime.");
    },
    createServer: () => {
      throw new Error("http2.createServer is not available in the direct-fs runtime.");
    },
    constants: {},
  };
}

function createClusterShim(): Record<string, unknown> {
  return {
    isPrimary: true,
    isMaster: true,
    isWorker: false,
    workers: {},
    fork: () => {
      throw new Error("cluster.fork is not available in the direct-fs runtime.");
    },
    on() {},
    once() {},
    disconnect() {},
    setupPrimary() {},
    setupMaster() {},
  };
}

function createDgramShim(): Record<string, unknown> {
  return {
    createSocket: () => {
      throw new Error("dgram.createSocket is not available in the direct-fs runtime.");
    },
  };
}

function createVmShim(): Record<string, unknown> {
  return {
    createContext: (context?: Record<string, unknown>) => context ?? {},
    isContext: () => true,
    runInContext: (code: string, context?: Record<string, unknown>) => {
      const names = Object.keys(context ?? {});
      const values = Object.values(context ?? {});

      return new Function(...names, code)(...values);
    },
    runInNewContext: (code: string, context?: Record<string, unknown>) => {
      const names = Object.keys(context ?? {});
      const values = Object.values(context ?? {});

      return new Function(...names, code)(...values);
    },
    runInThisContext: (code: string) => new Function(code)(),
    compileFunction: (code: string, params?: string[]) => new Function(...(params ?? []), code),
    Script: class Script {
      constructor(private readonly code: string) {}

      runInThisContext() {
        return new Function(this.code)();
      }
    },
  };
}

function createDomainShim(): Record<string, unknown> {
  class Domain {
    on() {
      return this;
    }
    once() {
      return this;
    }
    removeListener() {
      return this;
    }
    removeAllListeners() {
      return this;
    }
    add() {
      return this;
    }
    remove() {
      return this;
    }
    run(callback: (...args: unknown[]) => unknown, ...args: unknown[]) {
      return callback(...args);
    }
    enter() {}
    exit() {}
    dispose() {}
  }

  return {
    create: () => new Domain(),
    Domain,
  };
}

function createDiagnosticsChannelShim(): Record<string, unknown> {
  const channel = {
    hasSubscribers: false,
    publish() {},
    subscribe() {},
    unsubscribe() {},
    bindStore() {},
    unbindStore() {},
  };

  return {
    channel: () => channel,
    hasSubscribers: () => false,
    subscribe: () => {},
    unsubscribe: () => {},
  };
}

function createTimersShim(): Record<string, unknown> {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      setTimeout(callback, 0, ...args),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    clearImmediate: globalThis.clearTimeout.bind(globalThis),
  };
}

function createStringDecoderShim(): Record<string, unknown> {
  class StringDecoder {
    constructor(private readonly encoding = "utf8") {}

    write(buffer: Uint8Array): string {
      return new TextDecoder(this.encoding).decode(buffer);
    }

    end(buffer?: Uint8Array): string {
      return buffer == null ? "" : this.write(buffer);
    }
  }

  return { StringDecoder };
}

function createHttpsShim(): Record<string, unknown> {
  return {
    ...httpShim,
    request(
      urlOrOptions: string | URL | RequestOptions,
      optionsOrCallback?: RequestOptions | ResponseCallback,
      callback?: ResponseCallback,
    ) {
      return httpShim._createClientRequest(
        urlOrOptions,
        optionsOrCallback as RequestOptions | ((response: unknown) => void) | undefined,
        callback as ((response: unknown) => void) | undefined,
        "https",
      );
    },
    get(
      urlOrOptions: string | URL | RequestOptions,
      optionsOrCallback?: RequestOptions | ResponseCallback,
      callback?: ResponseCallback,
    ) {
      const request = httpShim._createClientRequest(
        urlOrOptions,
        optionsOrCallback as RequestOptions | ((response: unknown) => void) | undefined,
        callback as ((response: unknown) => void) | undefined,
        "https",
      );

      request.end();
      return request;
    },
  };
}

function createConsoleModule(runtimeConsole: Console): Record<string, unknown> {
  class Console {
    constructor(_options?: unknown) {}

    log(...args: unknown[]) {
      runtimeConsole.log(...args);
    }
    error(...args: unknown[]) {
      runtimeConsole.error(...args);
    }
    warn(...args: unknown[]) {
      runtimeConsole.warn(...args);
    }
    info(...args: unknown[]) {
      runtimeConsole.info(...args);
    }
    debug(...args: unknown[]) {
      runtimeConsole.debug(...args);
    }
    trace(...args: unknown[]) {
      runtimeConsole.trace(...args);
    }
    dir(...args: unknown[]) {
      runtimeConsole.dir(...args);
    }
  }

  return {
    ...runtimeConsole,
    Console,
  };
}

export function createBuiltins(options: BuiltinOptions): Builtins {
  const runtimeConsole = createConsole(options.onConsole);

  const moduleBuiltin = {
    ...moduleShim,
    createRequire: (filenameOrUrl: string) => {
      let filename = filenameOrUrl;

      if (filename.startsWith("file://")) {
        filename = decodeURIComponent(filename.slice("file://".length));

        if (filename.startsWith("/") && filename[2] === ":") {
          filename = filename.slice(1);
        }
      }

      return options.createRequireAt(filename);
    },
  };

  const timers = createTimersShim();

  const modules: Record<string, unknown> = {
    fs: options.fs,
    "fs/promises": options.fsPromises,
    path: pathShim,
    "path/posix": pathShim,
    "path/win32": pathShim.win32,
    process: options.process,
    events: eventsShim,
    stream: streamShim,
    "stream/promises": streamShim.promises,
    buffer: { ...bufferShim, default: bufferShim },
    url: urlShim,
    querystring: querystringShim,
    util: utilShim,
    "util/types": utilShim.types,
    http: httpShim,
    https: createHttpsShim(),
    net: netShim,
    tls: createTlsShim(),
    dns: createDnsShim(),
    os: createOsShim(),
    crypto: createCryptoShim(),
    zlib: zlibShim,
    tty: createTtyShim(),
    child_process: createChildProcessShim(),
    assert: assertShim,
    "assert/strict": assertShim,
    module: moduleBuiltin,
    perf_hooks: perfHooksShim,
    worker_threads: workerThreadsShim,
    timers,
    "timers/promises": {
      setTimeout: (milliseconds: number) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
      setInterval: globalThis.setInterval.bind(globalThis),
      setImmediate: (value?: unknown) =>
        new Promise((resolve) => setTimeout(() => resolve(value), 0)),
      scheduler: {
        wait: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        yield: () => Promise.resolve(),
      },
    },
    string_decoder: createStringDecoderShim(),
    console: createConsoleModule(runtimeConsole),
    async_hooks: createAsyncHooksShim(),
    domain: createDomainShim(),
    diagnostics_channel: createDiagnosticsChannelShim(),
    cluster: createClusterShim(),
    dgram: createDgramShim(),
    http2: createHttp2Shim(),
    vm: createVmShim(),
    chokidar: chokidarShim,
    ws: wsShim,
    fsevents: fseventsShim,
    readdirp: readdirpShim,
    esbuild: esbuildShim,
    rollup: rollupShim,
    constants: {},
    sys: utilShim,
  };

  function normalize(id: string): string {
    return id.startsWith("node:") ? id.slice("node:".length) : id;
  }

  return {
    has: (id: string) => Object.hasOwn(modules, normalize(id)),
    get: (id: string) => modules[normalize(id)],
    console: runtimeConsole,
  };
}
