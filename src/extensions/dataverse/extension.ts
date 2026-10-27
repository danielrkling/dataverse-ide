import {
    ExtensionHostKind,
    registerExtension,
} from '@codingame/monaco-vscode-api/extensions'

import type * as vscodeType from 'vscode'

import {
    DataverseWebResourceClient,
    type DataverseWebResource,
} from './webResourceClient.js'

export type DataverseUploadController = {
    dispose: () => void
}

type UploadSettings = {
    prefix: string
    solution?: string
    uploadRoot: string
    files: string[]
    exclude: string[]
    publishAfterUpload: boolean
    apiBaseUrl?: string
    watchDebounceMs: number
}

function normalizeDirectoryPath(value: string): string {
    const normalized = value
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')

    if (
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.includes('/../')
    ) {
        throw new Error(
            'Directory settings cannot contain path traversal values.',
        )
    }

    return normalized
}

async function getConfiguredUploadFiles(
    vscode: typeof vscodeType,
    workspaceRootUri: vscodeType.Uri,
    settings: UploadSettings,
): Promise<vscodeType.Uri[]> {
    const uploadRootUri =
        settings.uploadRoot.length === 0
            ? workspaceRootUri
            : vscode.Uri.joinPath(
                workspaceRootUri,
                ...settings.uploadRoot.split('/'),
            )

    const includePattern = combineGlobPatterns(
        settings.files,
        '**/*',
    )

    const excludePattern = combineGlobPatterns(
        settings.exclude,
        '',
    )

    return vscode.workspace.findFiles(
        new vscode.RelativePattern(
            uploadRootUri,
            includePattern,
        ),

        excludePattern.length > 0
            ? new vscode.RelativePattern(
                uploadRootUri,
                excludePattern,
            )
            : undefined,
    )
}

function getSettings(
    vscode: typeof vscodeType,
    workspaceRootUri: vscodeType.Uri,
): UploadSettings {
    const config = vscode.workspace.getConfiguration(
        'dataverseWebResources',
        workspaceRootUri,
    )

    const prefix = config.get<string>('prefix', '').trim()
    const uploadRoot = config
        .get<string>('uploadRoot', '')
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')

    if (prefix.length === 0) {
        throw new Error(
            'Set dataverseWebResources.prefix before uploading.',
        )
    }

    if (
        !/^[A-Za-z][^/]*_(?:\/.*)?$/.test(prefix) ||
        prefix.endsWith('/')
    ) {
        throw new Error(
            'dataverseWebResources.prefix must begin with a publisher prefix ending in an underscore. Example: dv_/ide.',
        )
    }

    if (
        uploadRoot === '..' ||
        uploadRoot.startsWith('../') ||
        uploadRoot.includes('/../')
    ) {
        throw new Error(
            'dataverseWebResources.uploadRoot cannot contain path traversal values.',
        )
    }

    return {
        prefix: prefix.replace(/\/+$/, ''),

        solution:
            config.get<string>('solution', '').trim() || undefined,

        uploadRoot,

        files: config.get<string[]>('files', ['**/*']),

        exclude: config.get<string[]>('exclude', []),

        publishAfterUpload: config.get<boolean>(
            'publishAfterUpload',
            true,
        ),

        apiBaseUrl:
            config.get<string>('apiBaseUrl', '').trim() || undefined,

        watchDebounceMs: config.get<number>(
            'watchDebounceMs',
            300,
        ),
    }
}

function combineGlobPatterns(
    patterns: string[],
    fallback: string,
): string {
    const normalized = patterns
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)

    if (normalized.length === 0) {
        return fallback
    }

    if (normalized.length === 1) {
        return normalized[0]
    }

    return `{${normalized.join(',')}}`
}

function buildWebResourceName(
    settings: UploadSettings,
    relativePath: string,
): string {
    const normalizedPath = relativePath
        .replaceAll('\\', '/')
        .replace(/^\/+/, '')

    return `${settings.prefix}/${normalizedPath}`
}

function getRelativePath(
    rootUri: vscodeType.Uri,
    resourceUri: vscodeType.Uri,
): string {
    const rootPath = rootUri.path.replace(/\/+$/, '')
    const resourcePath = resourceUri.path

    if (!resourcePath.startsWith(`${rootPath}/`)) {
        throw new Error(
            `"${resourceUri.path}" is outside configured upload root "${rootUri.path}".`,
        )
    }

    return resourcePath.slice(rootPath.length + 1)
}

async function collectFiles(
    vscode: typeof vscodeType,
    uri: vscodeType.Uri,
): Promise<vscodeType.Uri[]> {
    const stat = await vscode.workspace.fs.stat(uri)

    if ((stat.type & vscode.FileType.File) !== 0) {
        return [uri]
    }

    if ((stat.type & vscode.FileType.Directory) === 0) {
        return []
    }

    const files: vscodeType.Uri[] = []
    const entries = await vscode.workspace.fs.readDirectory(uri)

    for (const [name, type] of entries) {
        const childUri = vscode.Uri.joinPath(uri, name)

        if ((type & vscode.FileType.File) !== 0) {
            files.push(childUri)
            continue
        }

        if ((type & vscode.FileType.Directory) !== 0) {
            files.push(
                ...(await collectFiles(vscode, childUri)),
            )
        }
    }

    return files
}

function toUris(
    value: unknown,
): vscodeType.Uri[] {
    if (Array.isArray(value)) {
        return value.filter(
            (candidate): candidate is vscodeType.Uri =>
                typeof candidate === 'object' &&
                candidate != null &&
                'scheme' in candidate &&
                'path' in candidate,
        )
    }

    if (
        typeof value === 'object' &&
        value != null &&
        'scheme' in value &&
        'path' in value
    ) {
        return [value as vscodeType.Uri]
    }

    return []
}

export async function installDataverseUploadExtension(
    workspaceRootUri: vscodeType.Uri,
): Promise<DataverseUploadController> {
    const { getApi } = registerExtension(
        {
            name: 'dataverse-web-resource-upload',
            publisher: 'dataverse',
            version: '0.1.0',
            engines: {
                vscode: '*',
            },
            displayName: 'Dataverse Web Resource Upload',
            description:
                'Uploads local workspace files to Dataverse web resources.',

            contributes: {
                configuration: {
                    title: 'Dataverse Web Resources',

                    properties: {
                        'dataverseWebResources.prefix': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Dataverse web-resource root, including publisher prefix. Example: dv_/ide.',
                        },

                        'dataverseWebResources.solution': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Optional Dataverse solution unique name used for web-resource create and update operations.',
                        },

                        'dataverseWebResources.uploadRoot': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Workspace-relative directory whose contents upload beneath the configured Dataverse web-resource prefix.',
                        },

                        'dataverseWebResources.files': {
                            type: 'array',
                            default: ['**/*'],
                            scope: 'window',
                            items: {
                                type: 'string',
                            },
                            description:
                                'Glob patterns relative to uploadRoot used by Dataverse: Upload Configured Files.',
                        },

                        'dataverseWebResources.exclude': {
                            type: 'array',
                            default: [],
                            scope: 'window',
                            items: {
                                type: 'string',
                            },
                            description:
                                'Glob patterns relative to uploadRoot excluded from configured uploads and watch uploads.',
                        },

                        'dataverseWebResources.publishAfterUpload': {
                            type: 'boolean',
                            default: true,
                            scope: 'window',
                            description:
                                'Publish successfully uploaded Dataverse web resources after a complete upload batch.',
                        },

                        'dataverseWebResources.apiBaseUrl': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Optional Dataverse organization URL. Leave blank when the IDE runs inside Dataverse.',
                        },

                        'dataverseWebResources.watchDebounceMs': {
                            type: 'number',
                            default: 300,
                            minimum: 100,
                            scope: 'window',
                            description:
                                'Milliseconds to wait before batching file changes for Dataverse watch upload.',
                        },
                    },
                },

                commands: [
                    {
                        command:
                            'dataverseWebResources.uploadConfiguredFolder',
                        title:
                            'Dataverse: Upload Configured Web Resource Folder',
                    },
                    {
                        command:
                            'dataverseWebResources.uploadSelection',
                        title:
                            'Dataverse: Upload Selected Files or Folders',
                    },
                    {
                        command:
                            'dataverseWebResources.uploadActiveFile',
                        title:
                            'Dataverse: Upload Active File',
                    },
                    {
                        command: 'dataverseWebResources.previewSelection',
                        title: 'Dataverse: Preview Selected HTML Web Resource',
                    },
                    {
                        command: 'dataverseWebResources.startWatch',
                        title: 'Dataverse: Start Watch Upload',
                    },
                    {
                        command: 'dataverseWebResources.stopWatch',
                        title: 'Dataverse: Stop Watch Upload',
                    },
                ],

                menus: {
                    commandPalette: [
                        {
                            command:
                                'dataverseWebResources.uploadConfiguredFiles',
                        },
                        {
                            command:
                                'dataverseWebResources.uploadSelection',
                        },
                        {
                            command:
                                'dataverseWebResources.uploadActiveFile',
                        },
                        {
                            command:
                                'dataverseWebResources.previewSelection',
                        },
                        {
                            command:
                                'dataverseWebResources.startWatch',
                        },
                        {
                            command:
                                'dataverseWebResources.stopWatch',
                        },
                    ],

                    'explorer/context': [
                        {
                            command:
                                'dataverseWebResources.uploadSelection',
                            group: 'navigation@50',
                        },
                        {
                            command:
                                'dataverseWebResources.previewSelection',
                            when: 'resourceExtname == .html || resourceExtname == .htm',
                            group: 'navigation@51',
                        },
                    ],

                    'editor/title': [
                        {
                            command:
                                'dataverseWebResources.previewSelection',
                            when: 'resourceExtname == .html || resourceExtname == .htm',
                            group: 'navigation@50',
                        },
                    ],
                },
            },
        },
        ExtensionHostKind.LocalProcess,
    )

    const vscode = await getApi()

    const output = vscode.window.createOutputChannel(
        'Dataverse Web Resource Upload',
    )

    let fileWatcher: vscodeType.FileSystemWatcher | undefined
    let watchTimer: number | undefined
    let watchUploadInProgress = false
    let watchRefreshQueued = false

    /*
     * A Map preserves the URI associated with each changed file while preventing
     * duplicate upload requests during a rapid Vite build.
     */
    const pendingWatchFiles = new Map<
        string,
        vscodeType.Uri
    >()

    async function uploadFiles(
        selectedUris: vscodeType.Uri[],
    ): Promise<void> {
        const settings = getSettings(vscode, workspaceRootUri)

        const uploadRootUri =
            settings.uploadRoot.length === 0
                ? workspaceRootUri
                : vscode.Uri.joinPath(
                    workspaceRootUri,
                    ...settings.uploadRoot.split('/'),
                )

        const files = [
            ...new Map(
                (
                    await Promise.all(
                        selectedUris.map((uri) =>
                            collectFiles(vscode, uri),
                        ),
                    )
                )
                    .flat()
                    .map((uri) => [uri.toString(), uri]),
            ).values(),
        ]

        if (files.length === 0) {
            await vscode.window.showWarningMessage(
                'No files were selected for Dataverse upload.',
            )

            return
        }

        const client = new DataverseWebResourceClient({
            apiBaseUrl: settings.apiBaseUrl,
            solutionUniqueName: settings.solution,
        })

        const uploaded: DataverseWebResource[] = []
        const failures: string[] = []

        output.clear()
        output.show(true)

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Uploading Dataverse web resources',
                cancellable: false,
            },
            async (progress) => {
                for (let index = 0; index < files.length; index += 1) {
                    const fileUri = files[index]

                    try {
                        const relativePath = getRelativePath(
                            uploadRootUri,
                            fileUri,
                        )

                        const resourceName = buildWebResourceName(
                            settings,
                            relativePath,
                        )

                        progress.report({
                            increment: 100 / files.length,
                            message: `${index + 1}/${files.length}: ${relativePath}`,
                        })

                        output.appendLine(
                            `Uploading ${relativePath} -> ${resourceName}`,
                        )

                        const content = await vscode.workspace.fs.readFile(
                            fileUri,
                        )

                        const resource = await client.uploadWebResource(
                            resourceName,
                            content,
                        )

                        uploaded.push(resource)

                        output.appendLine(
                            `  Success: ${resource.webresourceid}`,
                        )
                    } catch (error) {
                        const message =
                            error instanceof Error
                                ? error.message
                                : String(error)

                        failures.push(`${fileUri.path}: ${message}`)

                        output.appendLine(
                            `  Failed: ${fileUri.path}`,
                        )
                        output.appendLine(`  ${message}`)
                    }
                }
            },
        )

        /*
         * Do not publish a partial deployment. The user can correct failed files
         * and retry the same operation.
         */
        if (
            failures.length === 0 &&
            uploaded.length > 0 &&
            settings.publishAfterUpload
        ) {
            output.appendLine(
                `Publishing ${uploaded.length} web resource(s)...`,
            )

            await client.publishWebResources(uploaded)

            output.appendLine('Publish completed.')
        }

        if (failures.length > 0) {
            await vscode.window.showErrorMessage(
                `${failures.length} of ${files.length} Dataverse web resource upload(s) failed. See Output for details.`,
            )

            return
        }

        const publishMessage = settings.publishAfterUpload
            ? ' Uploaded and published.'
            : ' Uploaded but not published.'

        await vscode.window.showInformationMessage(
            `${uploaded.length} Dataverse web resource(s) uploaded.${publishMessage}`,
        )
    }

    function getUploadRootUri(
        settings: UploadSettings,
    ): vscodeType.Uri {
        if (settings.uploadRoot.length === 0) {
            return workspaceRootUri
        }

        return vscode.Uri.joinPath(
            workspaceRootUri,
            ...settings.uploadRoot.split('/'),
        )
    }

    function scheduleWatchUpload(
        uri: vscodeType.Uri,
    ): void {
        pendingWatchFiles.set(uri.toString(), uri)

        if (watchTimer != null) {
            window.clearTimeout(watchTimer)
        }

        const settings = getSettings(
            vscode,
            workspaceRootUri,
        )

        watchTimer = window.setTimeout(() => {
            watchTimer = undefined

            void flushWatchUpload()
        }, settings.watchDebounceMs)
    }

    async function flushWatchUpload(): Promise<void> {
        if (watchUploadInProgress) {
            watchRefreshQueued = true
            return
        }

        if (pendingWatchFiles.size === 0) {
            return
        }

        watchUploadInProgress = true

        /*
         * Snapshot and clear first. File changes that occur during upload populate
         * a new batch and are processed afterward.
         */
        const changedFiles = new Map(pendingWatchFiles)
        pendingWatchFiles.clear()

        try {
            const settings = getSettings(
                vscode,
                workspaceRootUri,
            )

            /*
             * Use the built-in VS Code glob query to apply:
             *
             * dataverseWebResources.files
             * dataverseWebResources.exclude
             *
             * Deleted files will not be returned by findFiles(), which intentionally
             * matches the current "do not delete remote resources" requirement.
             */
            const configuredFiles = await getConfiguredUploadFiles(
                vscode,
                workspaceRootUri,
                settings,
            )

            const configuredFileUris = new Set(
                configuredFiles.map((uri) => uri.toString()),
            )

            const filesToUpload = [
                ...changedFiles.values(),
            ].filter((uri) =>
                configuredFileUris.has(uri.toString()),
            )

            if (filesToUpload.length === 0) {
                output.appendLine(
                    '[watch] No changed files matched configured upload patterns.',
                )

                return
            }

            output.appendLine(
                `[watch] Uploading ${filesToUpload.length} changed file(s).`,
            )

            await uploadFiles(filesToUpload)

            output.appendLine(
                `[watch] Completed upload of ${filesToUpload.length} file(s).`,
            )
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error)

            console.error(
                '[Dataverse IDE] Watch upload failed.',
                error,
            )

            output.appendLine(`[watch] Failed: ${message}`)

            await vscode.window.showErrorMessage(
                `Dataverse watch upload failed: ${message}`,
            )
        } finally {
            watchUploadInProgress = false

            /*
             * Process files changed while the previous batch was uploading.
             */
            if (
                watchRefreshQueued ||
                pendingWatchFiles.size > 0
            ) {
                watchRefreshQueued = false

                void flushWatchUpload()
            }
        }
    }

    function stopWatchUpload(): void {
        if (watchTimer != null) {
            window.clearTimeout(watchTimer)
            watchTimer = undefined
        }

        pendingWatchFiles.clear()

        fileWatcher?.dispose()
        fileWatcher = undefined
    }

    function startWatchUpload(): void {
        if (fileWatcher != null) {
            void vscode.window.showInformationMessage(
                'Dataverse watch upload is already running.',
            )

            return
        }

        const settings = getSettings(
            vscode,
            workspaceRootUri,
        )

        const uploadRootUri = getUploadRootUri(settings)

        /*
         * Watch the configured upload root broadly. The flush operation applies the
         * configured include/exclude globs through getConfiguredUploadFiles().
         */
        fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                uploadRootUri,
                '**/*',
            ),
        )

        fileWatcher.onDidCreate((uri) => {
            output.appendLine(`[watch] Created: ${uri.path}`)
            scheduleWatchUpload(uri)
        })

        fileWatcher.onDidChange((uri) => {
            output.appendLine(`[watch] Changed: ${uri.path}`)
            scheduleWatchUpload(uri)
        })

        /*
         * Do not delete remote web resources. Remove any queued request for a file
         * that was deleted before its debounce period elapsed.
         */
        fileWatcher.onDidDelete((uri) => {
            output.appendLine(`[watch] Deleted locally; remote retained: ${uri.path}`)

            pendingWatchFiles.delete(uri.toString())
        })

        output.appendLine(
            `[watch] Started for ${uploadRootUri.path}`,
        )

        void vscode.window.showInformationMessage(
            `Dataverse watch upload started for "${settings.uploadRoot || '.'}".`,
        )
    }

    const startWatchCommand = vscode.commands.registerCommand(
        'dataverseWebResources.startWatch',
        async () => {
            try {
                startWatchUpload()
            } catch (error) {
                await vscode.window.showErrorMessage(
                    error instanceof Error
                        ? `Unable to start Dataverse watch upload: ${error.message}`
                        : 'Unable to start Dataverse watch upload.',
                )
            }
        },
    )

    const stopWatchCommand = vscode.commands.registerCommand(
        'dataverseWebResources.stopWatch',
        async () => {
            if (fileWatcher == null) {
                await vscode.window.showInformationMessage(
                    'Dataverse watch upload is not running.',
                )

                return
            }

            stopWatchUpload()

            output.appendLine('[watch] Stopped.')

            await vscode.window.showInformationMessage(
                'Dataverse watch upload stopped.',
            )
        },
    )

    const uploadConfiguredFilesCommand =
        vscode.commands.registerCommand(
            'dataverseWebResources.uploadConfiguredFiles',
            async () => {
                try {
                    const settings = getSettings(
                        vscode,
                        workspaceRootUri,
                    )

                    const files = await getConfiguredUploadFiles(
                        vscode,
                        workspaceRootUri,
                        settings,
                    )

                    await uploadFiles(files)
                } catch (error) {
                    await vscode.window.showErrorMessage(
                        error instanceof Error
                            ? `Dataverse upload failed: ${error.message}`
                            : 'Dataverse upload failed.',
                    )
                }
            },
        )

    const uploadSelectionCommand =
        vscode.commands.registerCommand(
            'dataverseWebResources.uploadSelection',
            async (selection: unknown) => {
                const uris = toUris(selection)

                if (uris.length === 0) {
                    await vscode.window.showWarningMessage(
                        'Select one or more files or folders in Explorer first.',
                    )

                    return
                }

                try {
                    await uploadFiles(uris)
                } catch (error) {
                    await vscode.window.showErrorMessage(
                        error instanceof Error
                            ? `Dataverse upload failed: ${error.message}`
                            : 'Dataverse upload failed.',
                    )
                }
            },
        )

    const uploadActiveFileCommand =
        vscode.commands.registerCommand(
            'dataverseWebResources.uploadActiveFile',
            async () => {
                const document = vscode.window.activeTextEditor?.document

                if (
                    document == null ||
                    document.uri.scheme !== 'file'
                ) {
                    await vscode.window.showWarningMessage(
                        'Open a workspace file before using Dataverse: Upload Active File.',
                    )

                    return
                }

                try {
                    await document.save()
                    await uploadFiles([document.uri])
                } catch (error) {
                    await vscode.window.showErrorMessage(
                        error instanceof Error
                            ? `Dataverse upload failed: ${error.message}`
                            : 'Dataverse upload failed.',
                    )
                }
            },
        )

    const previewSelectionCommand =
        vscode.commands.registerCommand(
            'dataverseWebResources.previewSelection',
            async (selection: unknown) => {
                const selectedUris = toUris(selection)

                const selectedUri =
                    selectedUris[0] ??
                    vscode.window.activeTextEditor?.document.uri

                if (selectedUri == null) {
                    await vscode.window.showWarningMessage(
                        'Select or open an HTML file before previewing.',
                    )

                    return
                }

                const extension = selectedUri.path
                    .split('.')
                    .at(-1)
                    ?.toLowerCase()

                if (extension !== 'html' && extension !== 'htm') {
                    await vscode.window.showWarningMessage(
                        'Dataverse preview is available only for HTML web resources.',
                    )

                    return
                }

                try {
                    const settings = getSettings(
                        vscode,
                        workspaceRootUri,
                    )

                    const uploadRootUri =
                        settings.uploadRoot.length === 0
                            ? workspaceRootUri
                            : vscode.Uri.joinPath(
                                workspaceRootUri,
                                ...settings.uploadRoot.split('/'),
                            )

                    const relativePath = getRelativePath(
                        uploadRootUri,
                        selectedUri,
                    )

                    const webResourceName = buildWebResourceName(
                        settings,
                        relativePath,
                    )

                    const dataverseOrigin =
                        settings.apiBaseUrl?.replace(/\/+$/, '') ||
                        window.location.origin

                    const encodedName = webResourceName
                        .split('/')
                        .map((segment) => encodeURIComponent(segment))
                        .join('/')

                    const previewUrl =
                        `${dataverseOrigin}/WebResources/${encodedName}`

                    const previewWindow = window.open(
                        previewUrl,
                        '_blank',
                        'noopener',
                    )

                    if (previewWindow == null) {
                        await vscode.window.showWarningMessage(
                            'The browser blocked the preview popup.',
                        )
                    }
                } catch (error) {
                    await vscode.window.showErrorMessage(
                        error instanceof Error
                            ? `Unable to preview web resource: ${error.message}`
                            : 'Unable to preview web resource.',
                    )
                }
            },
        )

    return {
        dispose() {
            stopWatchUpload()

            uploadConfiguredFilesCommand.dispose()
            uploadSelectionCommand.dispose()
            uploadActiveFileCommand.dispose()
            previewSelectionCommand.dispose()
            startWatchCommand.dispose()
            stopWatchCommand.dispose()

            output.dispose()
        },
    }
}

import type { ExtensionContext, IdeExtension } from '../api.js'

import {
  contributeExtensionManifest,
} from '../api.js'

import * as vscodeTypeBottom from 'vscode'

/*
 * Registry adapter: the original install function is preserved for direct
 * callers, but the extension registry activates features through `default`.
 */

const CONFIG_SECTION_BOTTOM = 'dataverseWebResources'

type SettingsTreeKey =
  | 'prefix'
  | 'solution'
  | 'uploadRoot'
  | 'publishAfterUpload'
  | 'apiBaseUrl'
  | 'files'
  | 'exclude'

type BottomSettings = {
  prefix: string
  solution?: string
  uploadRoot: string
  publishAfterUpload: boolean
  apiBaseUrl?: string
  files: string[]
  exclude: string[]
}

class DataverseSettingsProvider
  implements vscodeTypeBottom.TreeDataProvider<{ key: SettingsTreeKey; label: string }>{
  private readonly onDidChangeEmitter = new vscodeTypeBottom.EventEmitter<{ key: SettingsTreeKey; label: string } | undefined>()

  readonly onDidChangeTreeData: vscodeTypeBottom.Event<{ key: SettingsTreeKey; label: string } | undefined> = this.onDidChangeEmitter.event

  constructor(
    private readonly vscode: typeof vscodeTypeBottom,
    private readonly rootUri: vscodeTypeBottom.Uri,
  ) {}

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined)
  }

  private readSettings(): BottomSettings {
    const config = this.vscode.workspace.getConfiguration(
      CONFIG_SECTION_BOTTOM,
      this.rootUri,
    )

    return {
      prefix: config.get<string>('prefix', ''),
      solution: config.get<string>('solution', '') || undefined,
      uploadRoot: config.get<string>('uploadRoot', ''),
      publishAfterUpload: config.get<boolean>('publishAfterUpload', true),
      apiBaseUrl: config.get<string>('apiBaseUrl', '') || undefined,
      files: config.get<string[]>('files', []),
      exclude: config.get<string[]>('exclude', []),
    }
  }

  async getChildren(): Promise<{ key: SettingsTreeKey; label: string }[]> {
    const settings = this.readSettings()

    return [
      {
        key: 'prefix',
        label: `Web Resource Prefix: ${settings.prefix === '' ? '(not set)' : settings.prefix}`,
      },
      {
        key: 'solution',
        label: `Solution: ${settings.solution ?? '(default solution)'}`,
      },
      {
        key: 'uploadRoot',
        label: `Upload Root: ${settings.uploadRoot === '' ? '(workspace root)' : settings.uploadRoot}`,
      },
      {
        key: 'publishAfterUpload',
        label: `Publish After Upload: ${settings.publishAfterUpload ? 'on' : 'off'}`,
      },
      {
        key: 'apiBaseUrl',
        label: `API Base URL Override: ${settings.apiBaseUrl ?? '(org default)'}`,
      },
      {
        key: 'files',
        label: `Include Patterns: ${settings.files.join(', ')}`,
      },
      {
        key: 'exclude',
        label: `Exclude Patterns: ${settings.exclude.length === 0 ? '(none)' : settings.exclude.join(', ')}`,
      },
    ]
  }

  getTreeItem(element: { key: SettingsTreeKey; label: string }): vscodeTypeBottom.TreeItem {
    const item = new this.vscode.TreeItem(
      element.label,
      this.vscode.TreeItemCollapsibleState.None,
    )

    item.command = {
      command: 'dataverseIde.dataverse.settingClick',
      title: 'Edit Dataverse setting',
      arguments: [element.key],
    }

    return item
  }
}

export default {
  id: 'dataverse',

  async activate(context: ExtensionContext): Promise<void> {
    const handle = context.workspaceDirectoryHandle

    if (handle == null) {
      throw new Error(
        'The dataverse extension currently requires a local workspace directory handle.',
      )
    }

    const vscodeBottom: typeof vscodeTypeBottom = context.vscode

    await contributeExtensionManifest({
      id: 'dataverse',
      displayName: 'Dataverse IDE Dataverse',
      description: 'Web resource upload and settings management.',
      commands: [
        {
          command: 'dataverseIde.dataverse.settingClick',
          title: 'Dataverse: Edit Web Resource Settings…',
        },
      ],
      views: {
        containerId: 'dataverseIde',
        containerTitle: 'Dataverse IDE',
        views: [
          {
            id: 'dataverseIde.dataverse.settings',
            name: 'Dataverse Settings',
          },
        ],
      },
    })

    const settingsClickCommand =
        vscodeBottom.commands.registerCommand(
          'dataverseIde.dataverse.settingClick',
          async (key: SettingsTreeKey) => {
            const config = vscodeBottom.workspace.getConfiguration(
              CONFIG_SECTION_BOTTOM,
              context.workspaceRootUri,
            )

            if (key === 'publishAfterUpload') {
              const current = config.get<boolean>('publishAfterUpload', true)

              await config.update(
                'publishAfterUpload',
                !current,
                vscodeBottom.ConfigurationTarget.Workspace,
              )

              dataverseSettingsProvider.refresh()

              return
            }

            if (key === 'files' || key === 'exclude') {
              const current = config.get<string[]>(key, [])

              const text = await vscodeBottom.window.showInputBox({
                title: `Dataverse: ${key === 'files' ? 'Include' : 'Exclude'} Patterns`,
                prompt: 'Comma-separated glob patterns.',
                value: current.join(', '),
                ignoreFocusOut: true,
              })

              if (text == null) {
                return
              }

              await config.update(
                key,
                text
                  .split(',')
                  .map((pattern) => pattern.trim())
                  .filter((pattern) => pattern.length > 0),
                vscodeBottom.ConfigurationTarget.Workspace,
              )

              dataverseSettingsProvider.refresh()

              return
            }

            const prompts: Record<Exclude<SettingsTreeKey, 'publishAfterUpload' | 'files' | 'exclude'>, string> = {
              prefix: 'Publisher prefix ending in an underscore, e.g. dv_/ide',
              solution: 'Unique name of the target solution (empty = default)',
              uploadRoot: 'Directory (relative to workspace root) to upload',
              apiBaseUrl: 'Override the Dataverse API base URL (usually leave empty)',
            }

            const value = await vscodeBottom.window.showInputBox({
              title: 'Dataverse: Web Resource Settings',
              prompt: prompts[key as 'prefix'],
              value: config.get<string>(key as 'prefix', ''),
              ignoreFocusOut: true,
            })

            if (value == null) {
              return
            }

            await config.update(
              key as 'prefix',
              value.trim(),
              vscodeBottom.ConfigurationTarget.Workspace,
            )

            dataverseSettingsProvider.refresh()
          },
        )

    const dataverseSettingsProvider = new DataverseSettingsProvider(
      vscodeBottom,
      context.workspaceRootUri,
    )

    const settingsTreeRegistration =
        vscodeBottom.window.registerTreeDataProvider(
          'dataverseIde.dataverse.settings',
          dataverseSettingsProvider,
        )

    const configChangeWatcher = vscodeBottom.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration(CONFIG_SECTION_BOTTOM)) {
          dataverseSettingsProvider.refresh()
        }
      },
    )

    void settingsClickCommand
    void settingsTreeRegistration
    void configChangeWatcher

    await installDataverseUploadExtension(context.workspaceRootUri)
  },
} satisfies IdeExtension
