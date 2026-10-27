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
        'dataverseIde.dataverse',
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
            'Set dataverseIde.dataverse.prefix before uploading.',
        )
    }

    if (
        prefix.length < 3 ||
        prefix.indexOf('_') < 2 ||
        prefix.endsWith('/')
    ) {
        throw new Error(
            'dataverseIde.dataverse.prefix must contain an underscore somewhere after its first two characters. Example: dv_/ide.',
        )
    }

    if (
        uploadRoot === '..' ||
        uploadRoot.startsWith('../') ||
        uploadRoot.includes('/../')
    ) {
        throw new Error(
            'dataverseIde.dataverse.uploadRoot cannot contain path traversal values.',
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
                        'dataverseIde.dataverse.prefix': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Dataverse web-resource root, including publisher prefix. Example: dv_/ide.',
                        },

                        'dataverseIde.dataverse.solution': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Optional Dataverse solution unique name used for web-resource create and update operations.',
                        },

                        'dataverseIde.dataverse.uploadRoot': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Workspace-relative directory whose contents upload beneath the configured Dataverse web-resource prefix.',
                        },

                        'dataverseIde.dataverse.files': {
                            type: 'array',
                            default: ['**/*'],
                            scope: 'window',
                            items: {
                                type: 'string',
                            },
                            description:
                                'Glob patterns relative to uploadRoot used by Dataverse: Upload Configured Files.',
                        },

                        'dataverseIde.dataverse.exclude': {
                            type: 'array',
                            default: [],
                            scope: 'window',
                            items: {
                                type: 'string',
                            },
                            description:
                                'Glob patterns relative to uploadRoot excluded from configured uploads and watch uploads.',
                        },

                        'dataverseIde.dataverse.publishAfterUpload': {
                            type: 'boolean',
                            default: true,
                            scope: 'window',
                            description:
                                'Publish successfully uploaded Dataverse web resources after a complete upload batch.',
                        },

                        'dataverseIde.dataverse.apiBaseUrl': {
                            type: 'string',
                            default: '',
                            scope: 'window',
                            description:
                                'Optional Dataverse organization URL. Leave blank when the IDE runs inside Dataverse.',
                        },

                        'dataverseIde.dataverse.watchDebounceMs': {
                            type: 'number',
                            default: 300,
                            minimum: 100,
                            scope: 'window',
                            description:
                                'Milliseconds to wait before batching file changes for Dataverse watch upload.',
                        },

                        'dataverseIde.user.name': {
                            type: 'string',
                            default: '',
                            description:
                                'IDE user identity full name (populated by Dataverse: Load User Identity).',
                        },

                        'dataverseIde.user.email': {
                            type: 'string',
                            default: '',
                            description:
                                'IDE user identity email address (populated by Dataverse: Load User Identity).',
                        },
                    },
                },

                commands: [
                    {
                        command:
                            'dataverseIde.dataverse.uploadConfiguredFolder',
                        title:
                            'Dataverse: Upload Configured Web Resource Folder',
                    },
                    {
                        command:
                            'dataverseIde.dataverse.uploadSelection',
                        title:
                            'Dataverse: Upload Selected Files or Folders',
                    },
                    {
                        command:
                            'dataverseIde.dataverse.uploadActiveFile',
                        title:
                            'Dataverse: Upload Active File',
                    },
                    {
                        command: 'dataverseIde.dataverse.previewSelection',
                        title: 'Dataverse: Preview Selected HTML Web Resource',
                    },
                    {
                        command: 'dataverseIde.dataverse.startWatch',
                        title: 'Dataverse: Start Watch Upload',
                    },
                    {
                        command: 'dataverseIde.dataverse.stopWatch',
                        title: 'Dataverse: Stop Watch Upload',
                    },
                    {
                        command: 'dataverseIde.dataverse.loadUserIdentity',
                        title: 'Dataverse: Load User Identity',
                    },
                    {
                        command: 'dataverseIde.dataverse.refreshSolutions',
                        title: 'Dataverse: Refresh Solutions',
                    },
                ],

                menus: {
                    commandPalette: [
                        {
                            command:
                                'dataverseIde.dataverse.uploadConfiguredFiles',
                        },
                        {
                            command:
                                'dataverseIde.dataverse.uploadSelection',
                        },
                        {
                            command:
                                'dataverseIde.dataverse.uploadActiveFile',
                        },
                        {
                            command:
                                'dataverseIde.dataverse.previewSelection',
                        },
                        {
                            command:
                                'dataverseIde.dataverse.startWatch',
                        },
                        {
                            command:
                                'dataverseIde.dataverse.stopWatch',
                        },
                    ],

                    'explorer/context': [
                        {
                            command:
                                'dataverseIde.dataverse.uploadSelection',
                            group: 'navigation@50',
                        },
                        {
                            command:
                                'dataverseIde.dataverse.previewSelection',
                            when: 'resourceExtname == .html || resourceExtname == .htm',
                            group: 'navigation@51',
                        },
                    ],

                    'editor/title': [
                        {
                            command:
                                'dataverseIde.dataverse.previewSelection',
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
             * dataverseIde.dataverse.files
             * dataverseIde.dataverse.exclude
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
        'dataverseIde.dataverse.startWatch',
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
        'dataverseIde.dataverse.stopWatch',
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
            'dataverseIde.dataverse.uploadConfiguredFiles',
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
            'dataverseIde.dataverse.uploadSelection',
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
            'dataverseIde.dataverse.uploadActiveFile',
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
            'dataverseIde.dataverse.previewSelection',
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

import {
  createPanelIcon,
  PANEL_GLYPHS,
  registerExtensionPanel,
} from '../panels.js'

import * as vscodeTypeBottom from 'vscode'

/*
 * Registry adapter: the original install function is preserved for direct
 * callers, but the extension registry activates features through `default`.
 */

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
      commands: [],
    })

    /*
     * Sidebar panel: "Dataverse" — web resource settings as real controls
     * (input boxes, checkbox, glob lists) backed by the same
     * dataverseIde.dataverse configuration section the uploader reads.
     */
    const dataversePanel = registerExtensionPanel(vscodeBottom, {
      extensionId: 'dataverse',
      title: 'Dataverse',
      icon: createPanelIcon(PANEL_GLYPHS.cloud),
      description:
        'Upload workspace files to Dataverse as web resources. Configure the prefix and upload root below.',
      workspaceRootUri: context.workspaceRootUri,
      settings: [
        {
          type: 'string',
          key: 'prefix',
          label: 'Web resource prefix',
          default: '',
          description: 'Underscore somewhere after the first two characters, e.g. dv_/ide',
          placeholder: 'dv_/ide',
        },
        {
          type: 'enum',
          key: 'solution',
          label: 'Solution',
          default: '',
          description: 'Target solution (first entry = default solution)',
          options: [{ value: '', label: '(default solution)' }],
          optionsProvider: async () => {
            const config = vscodeBottom.workspace.getConfiguration(
              'dataverseIde.dataverse',
              context.workspaceRootUri,
            )

            const client = new DataverseWebResourceClient({
              apiBaseUrl: config.get<string>('apiBaseUrl', '') || undefined,
            })

            const solutions = await client.listSolutions()

            return [
              { value: '', label: '(default solution)' },
              ...solutions.map((solution) => ({
                value: solution.uniquename,
                label: solution.friendlyname
                  ? `${solution.friendlyname} (${solution.uniquename})`
                  : solution.uniquename,
              })),
            ]
          },
        },
        {
          type: 'string',
          key: 'uploadRoot',
          label: 'Upload root',
          default: '',
          description: 'Directory (relative to workspace root) to upload (empty = workspace root)',
        },
        {
          type: 'boolean',
          key: 'publishAfterUpload',
          label: 'Publish after upload',
          default: true,
        },
        {
          type: 'string',
          key: 'apiBaseUrl',
          label: 'API base URL override',
          default: '',
          description: 'Usually leave empty to use the org default',
        },
        {
          type: 'stringList',
          key: 'files',
          label: 'Include patterns',
          default: ['**/*'],
          description: 'Glob patterns included in the upload',
          placeholder: '**/*',
        },
        {
          type: 'stringList',
          key: 'exclude',
          label: 'Exclude patterns',
          default: [],
          description: 'Glob patterns excluded from the upload',
          placeholder: 'node_modules/**',
        },
      ],
      actions: [
        {
          label: 'Load User Identity',
          command: 'dataverseIde.dataverse.loadUserIdentity',
          primary: true,
          tooltip:
            'Fetch the current Dataverse user (WhoAmI + systemusers) and apply it as the git commit author and IDE user',
        },
        {
          label: 'Refresh Solutions',
          command: 'dataverseIde.dataverse.refreshSolutions',
          tooltip: 'Re-fetch the solution list from the org',
        },
      ],
    })

    const refreshSolutionsCommand = vscodeBottom.commands.registerCommand(
      'dataverseIde.dataverse.refreshSolutions',
      () => {
        dataversePanel.refresh()
      },
    )

    /*
     * Identity: WhoAmI + systemusers -> git commit author + IDE user.
     * Written to dataverseIde.git.authorName/authorEmail (git extension
     * reads those to skip the prompts) and dataverseIde.user.*.
     */
    const loadUserIdentityCommand = vscodeBottom.commands.registerCommand(
      'dataverseIde.dataverse.loadUserIdentity',
      async () => {
        try {
          const config = vscodeBottom.workspace.getConfiguration(
            'dataverseIde.dataverse',
            context.workspaceRootUri,
          )

          const client = new DataverseWebResourceClient({
            apiBaseUrl: config.get<string>('apiBaseUrl', '') || undefined,
          })

          const user = await vscodeBottom.window.withProgress(
            {
              location: vscodeBottom.ProgressLocation.Notification,
              title: 'Dataverse: loading user identity…',
              cancellable: false,
            },
            () => client.getCurrentUser(),
          )

          if (user.fullName.length === 0 || user.email.length === 0) {
            await vscodeBottom.window.showWarningMessage(
              'Dataverse: the user record has no full name or email; identity not applied.',
            )

            return
          }

          /*
           * Identity is user-scoped (global): it describes the signed-in
           * person, not the project, so it follows the user across
           * workspaces.
           */
          const gitConfig = vscodeBottom.workspace.getConfiguration(
            'dataverseIde.git',
            context.workspaceRootUri,
          )

          await gitConfig.update(
            'authorName',
            user.fullName,
            vscodeBottom.ConfigurationTarget.Global,
          )

          await gitConfig.update(
            'authorEmail',
            user.email,
            vscodeBottom.ConfigurationTarget.Global,
          )

          const userConfig = vscodeBottom.workspace.getConfiguration(
            'dataverseIde.user',
            context.workspaceRootUri,
          )

          await userConfig.update(
            'name',
            user.fullName,
            vscodeBottom.ConfigurationTarget.Global,
          )

          await userConfig.update(
            'email',
            user.email,
            vscodeBottom.ConfigurationTarget.Global,
          )

          await vscodeBottom.window.showInformationMessage(
            `Dataverse: identity applied — ${user.fullName} <${user.email}>. Git commits now use this author automatically.`,
          )
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)

          await vscodeBottom.window.showErrorMessage(
            `Dataverse: loading user identity failed: ${message}`,
          )
        }
      },
    )

    await installDataverseUploadExtension(context.workspaceRootUri)
  },
} satisfies IdeExtension
