/*
 * npm registry client for the direct installer.
 *
 * Local implementation (derived from almostnode's MIT-licensed registry
 * client) so the npm extension no longer depends on almostnode's package
 * manager/runtime exports. The rest of the IDE only uses almostnode for its
 * Node builtin shims.
 */

export interface PackageVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  dist: {
    tarball: string;
    shasum?: string;
    integrity?: string;
  };
  main?: string;
  module?: string;
  exports?: Record<string, unknown>;
  bin?: Record<string, string> | string;
}

export interface PackageManifest {
  name: string;
  "dist-tags": {
    latest: string;
    [tag: string]: string;
  };
  versions: Record<string, PackageVersion>;
  time?: Record<string, string>;
}

export interface RegistryOptions {
  registry?: string;
  cache?: Map<string, PackageManifest>;
}

export interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  dependencies: Record<string, string>;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

function encodePackageName(name: string): string {
  return name.replace("/", "%2f");
}

export class Registry {
  private readonly registryUrl: string;
  private readonly cache: Map<string, PackageManifest>;

  constructor(options: RegistryOptions = {}) {
    this.registryUrl = options.registry ?? DEFAULT_REGISTRY;
    this.cache = options.cache ?? new Map();
  }

  async getPackageManifest(packageName: string): Promise<PackageManifest> {
    const cached = this.cache.get(packageName);

    if (cached != null) {
      return cached;
    }

    const response = await fetch(`${this.registryUrl}/${encodePackageName(packageName)}`, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Package not found: ${packageName}`);
      }

      throw new Error(`Failed to fetch package ${packageName}: ${response.status}`);
    }

    const manifest = (await response.json()) as PackageManifest;

    this.cache.set(packageName, manifest);

    return manifest;
  }

  async getPackageVersion(packageName: string, version: string): Promise<PackageVersion> {
    const manifest = await this.getPackageManifest(packageName);
    const resolvedVersion = manifest["dist-tags"][version] ?? version;
    const versionData = manifest.versions[resolvedVersion];

    if (versionData == null) {
      throw new Error(`Version ${resolvedVersion} not found for package ${packageName}`);
    }

    return versionData;
  }

  async getLatestVersion(packageName: string): Promise<string> {
    const manifest = await this.getPackageManifest(packageName);

    return manifest["dist-tags"].latest;
  }

  async getVersions(packageName: string): Promise<string[]> {
    const manifest = await this.getPackageManifest(packageName);

    return Object.keys(manifest.versions);
  }

  async downloadTarball(tarballUrl: string): Promise<ArrayBuffer> {
    const response = await fetch(tarballUrl);

    if (!response.ok) {
      throw new Error(`Failed to download tarball: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/** Split "name@range" while keeping scoped package names intact. */
export function parsePackageSpec(spec: string): { name: string; version?: string } {
  if (spec.startsWith("@")) {
    const slashIndex = spec.indexOf("/");

    if (slashIndex === -1) {
      throw new Error(`Invalid package spec: ${spec}`);
    }

    const afterSlash = spec.slice(slashIndex + 1);
    const atIndex = afterSlash.indexOf("@");

    if (atIndex === -1) {
      return { name: spec };
    }

    return {
      name: spec.slice(0, slashIndex + 1 + atIndex),
      version: afterSlash.slice(atIndex + 1),
    };
  }

  const atIndex = spec.indexOf("@");

  if (atIndex === -1) {
    return { name: spec };
  }

  return {
    name: spec.slice(0, atIndex),
    version: spec.slice(atIndex + 1),
  };
}
