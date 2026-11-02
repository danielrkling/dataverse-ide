/*
 * Tracks the minimal extension manifests registered before the workbench
 * initializes.
 *
 * They exist so the built-in Extensions view can list (and enable/disable)
 * the in-house extensions. When an extension actually activates, its full
 * manifest replaces the placeholder; `consumePlaceholder` makes that a
 * one-time operation so a second manifest registration is not treated as a
 * replacement.
 */

const pendingPlaceholderIds = new Set<string>();

export function markPlaceholder(id: string): void {
  pendingPlaceholderIds.add(id.toLowerCase());
}

export function consumePlaceholder(id: string): boolean {
  return pendingPlaceholderIds.delete(id.toLowerCase());
}
