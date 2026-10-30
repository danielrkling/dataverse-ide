const workerBlobUrls = new Map<string, string>();

export function getModuleWorkerBlobUrl(workerUrl: string): string {
  const absoluteWorkerUrl = new URL(workerUrl, document.baseURI).href;

  const existing = workerBlobUrls.get(absoluteWorkerUrl);

  if (existing != null) {
    return existing;
  }

  /*
   * Bootstrap from a known-good text/javascript blob, then import the real
   * Vite-generated worker bundle. The imported module retains its deployed
   * /assets/ URL as its base for relative imports and dynamic chunks.
   */
  const bootstrapSource = `import ${JSON.stringify(absoluteWorkerUrl)};\n`;

  const blobUrl = URL.createObjectURL(
    new Blob([bootstrapSource], {
      type: "text/javascript",
    }),
  );

  workerBlobUrls.set(absoluteWorkerUrl, blobUrl);

  return blobUrl;
}

export function createModuleWorker(
  workerUrl: string,
  options: Omit<WorkerOptions, "type"> = {},
): Worker {
  return new Worker(getModuleWorkerBlobUrl(workerUrl), {
    ...options,
    type: "module",
  });
}

export function disposeModuleWorkerBlobs(): void {
  for (const blobUrl of workerBlobUrls.values()) {
    URL.revokeObjectURL(blobUrl);
  }

  workerBlobUrls.clear();
}