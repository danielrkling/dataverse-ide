import * as v from "valibot";

/*
 * Shared building blocks for the *.config.json Valibot schemas.
 *
 * Every feature config follows the same contract:
 *   - unknown user keys are ignored by validation (and preserved on write)
 *   - a missing key gets the feature default
 *   - an invalid key falls back to the feature default instead of failing the
 *     whole file, matching the previous hand-written readers
 *   - workspace paths are stored with forward slashes
 */

/** esbuild's output formats (https://esbuild.github.io/api/#format). */
export const BUILD_FORMATS = ["esm", "iife", "cjs"] as const;

/** Rolldown additionally supports UMD output. */
export const ROLLDOWN_FORMATS = [...BUILD_FORMATS, "umd"] as const;

/** esbuild's source map modes (https://esbuild.github.io/api/#sourcemap). */
export const SOURCEMAP_MODES = ["linked", "inline", "external", "both"] as const;

export type SourcemapOption = boolean | (typeof SOURCEMAP_MODES)[number];

export type WorkspacePathOptions = {
  /** Strip leading "./" and "../" segments (default: true). */
  stripRelativePrefixes?: boolean;
  /** Strip trailing slashes (default: true). */
  stripTrailingSlash?: boolean;
};

export function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Canonical workspace-relative path representation used by every config file. */
export function normalizeWorkspacePath(value: string, options?: WorkspacePathOptions): string {
  let normalized = normalizeSlashes(value.trim());

  if (options?.stripRelativePrefixes !== false) {
    normalized = normalized.replace(/^(?:\.{1,2}\/)+/, "");
  }

  normalized = normalized.replace(/^\/+/, "");

  if (options?.stripTrailingSlash !== false) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized;
}

/** Trimmed string; empty (or missing) becomes undefined. */
export const optionalStringSchema = v.optional(
  v.fallback(
    v.pipe(
      v.string(),
      v.transform((value) => {
        const trimmed = value.trim();

        return trimmed.length > 0 ? trimmed : undefined;
      }),
    ),
    undefined,
  ),
);

/** Non-empty, slash-normalized workspace path. */
export const workspacePathSchema = v.pipe(
  v.string(),
  v.transform((value) => normalizeWorkspacePath(value)),
  v.minLength(1, "Expected a non-empty workspace path."),
);

/** Slash-normalized workspace path that is allowed to be empty. */
export const workspacePathAllowEmptySchema = v.pipe(
  v.string(),
  v.transform((value) => normalizeWorkspacePath(value)),
);

/*
 * Dataverse upload roots keep "../" segments so the extension can reject
 * path traversal instead of silently normalizing it away.
 */
export const workspaceRootSchema = v.pipe(
  v.string(),
  v.transform((value) =>
    normalizeSlashes(value.trim())
      .replace(/^(?:\.\/)+/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, ""),
  ),
);

/** Trimmed string map with empty keys/values dropped. */
export const stringRecordSchema = v.pipe(
  v.record(v.string(), v.fallback(v.string(), "")),
  v.transform((record) => {
    const entries = Object.entries(record)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0);

    return Object.fromEntries(entries);
  }),
);

/** Trimmed list of non-empty strings. Invalid items are dropped, not fatal. */
export const stringListSchema = v.pipe(
  v.array(v.fallback(v.string(), "")),
  v.transform((items) => items.map((item) => item.trim()).filter((item) => item.length > 0)),
);

/** One or more workspace paths; accepts the legacy single-string form too. */
export const workspacePathListSchema = v.pipe(
  v.union([v.string(), v.array(v.fallback(v.string(), ""))]),
  v.transform((value) => (Array.isArray(value) ? value : [value])),
  v.transform((items) =>
    items.map((item) => normalizeWorkspacePath(item)).filter((item) => item.length > 0),
  ),
  v.check((items) => items.length > 0, "Expected at least one workspace path."),
);

/**
 * esbuild targets are `string | string[]`
 * (https://esbuild.github.io/api/#target).
 */
export const buildTargetSchema = v.pipe(
  v.union([v.string(), v.array(v.fallback(v.string(), ""))]),
  v.transform((value) => {
    if (typeof value === "string") {
      return value.trim();
    }

    return value.map((item) => item.trim()).filter((item) => item.length > 0);
  }),
  v.check(
    (value) => (typeof value === "string" ? value.length > 0 : value.length > 0),
    "Expected a non-empty esbuild target.",
  ),
);

/**
 * esbuild defines are `Record<string, string>`
 * (https://esbuild.github.io/api/#define). Primitive values are serialized to
 * their JavaScript literal form for convenience.
 */
export const defineRecordSchema = v.record(v.string(), v.unknown());

export const defineSchema = v.pipe(
  defineRecordSchema,
  v.transform((record) => {
    const define: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") {
        define[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        define[key] = JSON.stringify(value);
      }
    }

    return define;
  }),
);

/**
 * Make a field optional and fall back to its default when it is missing or
 * invalid. `v.optional()` alone only handles missing/undefined values, while
 * `v.fallback()` applies to schema failures; together they match the readers'
 * previous "unknown values fall back to the matching default" behavior.
 */
export function withDefault<
  const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, defaultValue: v.InferOutput<TSchema>) {
  return v.optional(v.fallback(schema, defaultValue), defaultValue);
}

function cloneDefaults<T>(defaults: T): T {
  if (Array.isArray(defaults)) {
    return [...defaults] as T;
  }

  if (defaults != null && typeof defaults === "object") {
    return { ...defaults };
  }

  return defaults;
}

/** Parse config text into a fully-defaulted config object. */
export function parseConfig<const TSchema extends v.GenericSchema>(
  text: string | null,
  schema: TSchema,
  defaults: v.InferOutput<TSchema>,
  normalizeInput?: (value: unknown) => unknown,
): v.InferOutput<TSchema> {
  if (text == null) {
    return cloneDefaults(defaults);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return cloneDefaults(defaults);
  }

  const result = v.safeParse(schema, normalizeInput == null ? parsed : normalizeInput(parsed));

  return result.success ? result.output : cloneDefaults(defaults);
}
