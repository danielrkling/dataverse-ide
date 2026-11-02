/*
 * Stub worker script for almostnode's WorkerRuntime.
 *
 * almostnode's dist references a hosted worker chunk at an absolute path
 * ("/assets/runtime-worker-<hash>.js") that is not shipped inside the npm
 * package - it only exists on almostnode's documentation site. We alias that
 * URL here (see vite.config.ts).
 *
 * The IDE only imports almostnode's builtin shims, but the package entry
 * still references WorkerRuntime, so this stub only needs to be a valid
 * worker script that exits quietly.
 */
