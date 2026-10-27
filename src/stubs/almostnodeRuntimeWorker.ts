/*
 * Stub worker script for almostnode's WorkerRuntime.
 *
 * almostnode's dist references a hosted worker chunk at an absolute path
 * ("/assets/runtime-worker-<hash>.js") that is not shipped inside the npm
 * package - it only exists on almostnode's documentation site. We alias that
 * URL here (see vite.config.ts).
 *
 * The IDE runs almostnode in main-thread same-origin mode (IRuntime from
 * createRuntime with useWorker: false), so WorkerRuntime is never booted;
 * this stub only needs to be a valid worker script that exits quietly.
 */
