/*
 * Shared almostnode VirtualFS singleton.
 *
 * The npm extension installs packages into this VFS, and the node-runtime
 * extension runs scripts from (and thereby requires packages out of) the
 * same VFS. This avoids re-syncing node_modules between the workspace and
 * a fresh VFS on every run, and keeps installed packages available
 * immediately after an npm install.
 */

import { VirtualFS } from 'almostnode'

let sharedVfs: VirtualFS | undefined

export function getSharedVfs(): VirtualFS {
  if (sharedVfs == null) {
    sharedVfs = new VirtualFS()
  }

  return sharedVfs
}
