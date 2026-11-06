import type * as vscodeType from "vscode";

import {
  EditorInputCapabilities,
  SimpleEditorInput,
  SimpleEditorPane,
  registerEditorPane,
} from "@codingame/monaco-vscode-api/service-override/tools/views";

import {
  MenuId,
  MenuRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { StandaloneServices } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices";
import type { IEditorGroup } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";

import { contributeExtensionManifest } from "../api.js";
import { RECOMMENDED_EXTENSIONS } from "../vsix/recommended.js";

import guideContent from "./GUIDE.md?raw";

import { registerGuide } from "../shared/guide.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * Welcome extension: an editor-area landing page that explains the features
 * and extensions that make this workspace different from plain VS Code.
 *
 * It is a regular custom editor pane (built with the same monaco-vscode-api
 * tools the side panels use), so it participates in tabs, split groups and
 * the normal editor lifecycle. The command palette entry and the Help menu
 * entry make it reachable at any time; `dataverseIde.welcome.showOnStartup`
 * decides whether it also opens automatically after the workbench boots.
 */

const COMMAND_OPEN = "dataverseIde.welcome.open";
const CONFIG_SECTION = "dataverseIde.welcome";
const SETTING_SHOW_ON_STARTUP = "showOnStartup";

const EDITOR_ID = "workbench.editors.dataverseIdeWelcome";
const WELCOME_RESOURCE = URI.parse("dataverse-ide-welcome:/Welcome");

type WelcomeAction = {
  label: string;
  command: string;
  args?: unknown[];
  primary?: boolean;
};

type WelcomeFeature = {
  title: string;
  description: string;
  icon: string;
  /** Command that opens this feature's colocated GUIDE.md. */
  guide?: string;
  actions?: WelcomeAction[];
};

type WelcomeSection = {
  id: string;
  title: string;
  features: WelcomeFeature[];
};

/*
 * Feature catalogue. Keep this in sync when a new extension or command is
 * added; the page is intentionally content, not a generated registry dump.
 */
const SECTIONS: WelcomeSection[] = [
  {
    id: "workspace",
    title: "Workspace & editing",
    features: [
      {
        title: "Real local folders",
        description:
          "Mount a directory from your machine through the File System Access API. Files are read and written directly, and dirty buffers are saved automatically after one second.",
        icon: "folder-opened",
        actions: [
          {
            label: "Open Local Folder…",
            command: "dataverseIde.workspace.openLocalFolder",
            primary: true,
          },
          {
            label: "Recent Workspaces…",
            command: "dataverseIde.workspace.chooseRecent",
          },
        ],
      },
      {
        title: "Browser workspaces",
        description:
          "No local folder access? Create a persistent workspace in the Origin Private File System (OPFS). Top-level node_modules can be layered in browser storage too.",
        icon: "cloud",
        actions: [
          {
            label: "New Browser Workspace…",
            command: "dataverseIde.workspace.newBrowserWorkspace",
          },
        ],
      },
      {
        title: "Language smarts in the browser",
        description:
          "Project-wide TypeScript and JavaScript IntelliSense via tsserver, plus HTML, CSS, JSON, Markdown, Emmet and XML language features.",
        icon: "code",
      },
      {
        title: "Configure & extend",
        description:
          "Every feature is an IDE extension with its own enable/disable toggle and output channel. Config files such as dataverse.config.json and esbuild.config.json get JSON Schema validation in the editor.",
        icon: "extensions",
        guide: "dataverseIde.welcome.openGuide",
        actions: [
          {
            label: "Open Extensions",
            command: "workbench.view.extensions",
            primary: true,
          },
          {
            label: "Open Settings",
            command: "workbench.action.openSettings",
          },
        ],
      },
      {
        title: "Install VSIX extensions",
        description:
          "Bring browser-ready extensions into the IDE from local .vsix files or a direct URL. Packages persist in browser storage and are restored alongside the built-in extension toggles.",
        icon: "cloud-download",
        guide: "dataverseIde.vsix.openGuide",
        actions: [
          {
            label: "Install from VSIX…",
            command: "dataverseIde.vsix.install",
            primary: true,
          },
          {
            label: "Install from URL…",
            command: "dataverseIde.vsix.installFromUrl",
          },
        ],
      },
    ],
  },
  {
    id: "dataverse",
    title: "Dataverse deployment",
    features: [
      {
        title: "Web resource uploads",
        description:
          "Push files straight to a Dataverse organisation as web resources, preview the plan, and publish when the upload completes. Watch mode keeps the org in sync while you edit.",
        icon: "cloud-upload",
        guide: "dataverseIde.dataverse.openGuide",
        actions: [
          {
            label: "Upload Configured Files",
            command: "dataverseIde.dataverse.uploadConfiguredFiles",
            primary: true,
          },
          {
            label: "Open dataverse.config.json",
            command: "dataverseIde.dataverse.openConfig",
          },
        ],
      },
      {
        title: "Table & column provisioning",
        description:
          "Declare tables and columns in dataverse.schema.json, preview a +/=/! plan, and create only what is missing. Existing metadata is never updated or deleted.",
        icon: "database",
        guide: "dataverseIde.dataverse.openGuide",
        actions: [
          {
            label: "Preview Schema Plan",
            command: "dataverseIde.dataverse.previewSchema",
            primary: true,
          },
          {
            label: "Open dataverse.schema.json",
            command: "dataverseIde.dataverse.openSchema",
          },
        ],
      },
      {
        title: "Watch & publish",
        description:
          "Start a debounced watch on the configured files. Uploads and publishing are driven entirely by dataverse.config.json, which has inline JSON Schema validation.",
        icon: "sync",
        guide: "dataverseIde.dataverse.openGuide",
        actions: [
          {
            label: "Start Watch",
            command: "dataverseIde.dataverse.startWatch",
          },
          {
            label: "Stop Watch",
            command: "dataverseIde.dataverse.stopWatch",
          },
        ],
      },
      {
        title: "Dataverse identity",
        description:
          "Resolves the signed-in Dataverse user at startup and uses their name and email for file metadata and commit authorship.",
        icon: "person",
        guide: "dataverseIde.dataverse.openGuide",
        actions: [
          {
            label: "Load User Identity",
            command: "dataverseIde.dataverse.loadUserIdentity",
          },
        ],
      },
    ],
  },
  {
    id: "build",
    title: "Build & bundle",
    features: [
      {
        title: "esbuild, Solid & JSX",
        description:
          "Bundle TypeScript, TSX and JSX with esbuild-wasm. Resolve npm imports from the workspace, compile Solid v1/v2 with Babel, and optionally run the Tagged JSX transform before bundling.",
        icon: "zap",
        guide: "dataverseIde.esbuild.openGuide",
        actions: [
          {
            label: "Build Workspace…",
            command: "dataverseIde.esbuild.buildWorkspace",
            primary: true,
          },
          {
            label: "Open esbuild.config.json",
            command: "dataverseIde.esbuild.openConfig",
          },
        ],
      },
      {
        title: "Self-contained HTML",
        description:
          "Inline local scripts, stylesheets, SVG, images and media into a single deployable HTML file. Watch mode rebuilds when any inlined dependency changes.",
        icon: "file-code",
        guide: "dataverseIde.html.openGuide",
        actions: [
          {
            label: "Bundle Workspace…",
            command: "dataverseIde.html.bundleWorkspace",
            primary: true,
          },
          {
            label: "Open html.config.json",
            command: "dataverseIde.html.openConfig",
          },
        ],
      },
      {
        title: "Tailwind v4",
        description:
          "Class completions and hovers generated from the installed design system, with no WASM runtime. Compile the classes actually used in the workspace to CSS on demand.",
        icon: "paintcan",
        guide: "dataverseIde.tailwind.openGuide",
        actions: [
          {
            label: "Compile CSS",
            command: "dataverseIde.tailwind.compileCss",
            primary: true,
          },
          {
            label: "Open tailwind.config.json",
            command: "dataverseIde.tailwind.openConfig",
          },
        ],
      },
    ],
  },
  {
    id: "run-ship",
    title: "Run & ship",
    features: [
      {
        title: "Node runtime",
        description:
          "Run a workspace module graph directly through the File System Access API. Permission levels control filesystem writes and same-origin network access per run.",
        icon: "play",
        guide: "dataverseIde.node-runtime.openGuide",
        actions: [
          {
            label: "Run File…",
            command: "dataverseIde.nodeRuntime.runFile",
            primary: true,
          },
          {
            label: "Run Active File",
            command: "dataverseIde.nodeRuntime.runEntry",
          },
        ],
      },
      {
        title: "Terminal",
        description:
          "A just-bash shell in the native terminal panel, backed directly by the workspace filesystem. No virtual filesystem mirror or sync-back step; node and npm run through the same direct runtime.",
        icon: "terminal",
        guide: "dataverseIde.terminal.openGuide",
        actions: [
          {
            label: "New Shell",
            command: "dataverseIde.terminal.new",
            primary: true,
          },
          {
            label: "Run Command…",
            command: "dataverseIde.terminal.run",
          },
        ],
      },
      {
        title: "npm in the browser",
        description:
          "Real installs into the workspace node_modules through a local resolver and registry client. Add dependencies, install from package.json, or prune extraneous packages.",
        icon: "package",
        guide: "dataverseIde.npm.openGuide",
        actions: [
          {
            label: "Install All",
            command: "dataverseIde.npm.installAll",
            primary: true,
          },
          {
            label: "Add Dependency…",
            command: "dataverseIde.npm.addDependency",
          },
        ],
      },
      {
        title: "Git",
        description:
          "isomorphic-git brings clone, fetch, pull and push to the browser. Stage, commit, branch and review history, with PATs cached safely in secret storage.",
        icon: "git-branch",
        guide: "dataverseIde.git.openGuide",
        actions: [
          {
            label: "Initialize Repository",
            command: "dataverseGit.initialize",
            primary: true,
          },
          {
            label: "Sync",
            command: "dataverseGit.sync",
          },
        ],
      },
      {
        title: "GitLab",
        description:
          "Connect with a personal access token to clone projects, browse merge requests, issues and pipelines, or open a new merge request without leaving the IDE.",
        icon: "git-pull-request",
        guide: "dataverseIde.gitlab.openGuide",
        actions: [
          {
            label: "Connect…",
            command: "dataverseIde.gitlab.connect",
            primary: true,
          },
          {
            label: "Clone Repository",
            command: "dataverseIde.gitlab.cloneRepository",
          },
          {
            label: "Merge Requests",
            command: "dataverseIde.gitlab.showMergeRequests",
          },
        ],
      },
    ],
  },
  {
    id: "utilities",
    title: "Utilities & automation",
    features: [
      {
        title: "Flatten files",
        description:
          "Right-click one or more files or folders in the explorer to combine their text into a numbered markdown bundle, or run the configured variant to collect paths from `dataverseIde.flatten.include` — handy as LLM context or for a quick review.",
        icon: "files",
        guide: "dataverseIde.flatten.openGuide",
        actions: [
          {
            label: "Flatten Selection",
            command: "dataverseIde.flatten.selected",
          },
          {
            label: "Flatten Configured",
            command: "dataverseIde.flatten.configured",
          },
        ],
      },
      {
        title: "Scripts",
        description:
          "Run command chains from a dataverseIde.scripts.scripts setting: steps run in series, arrays run in parallel, and failures can abort or continue per script.",
        icon: "run-all",
        guide: "dataverseIde.scripts.openGuide",
        actions: [
          {
            label: "Run Script…",
            command: "dataverseIde.scripts.run",
            primary: true,
          },
        ],
      },
    ],
  },
  {
    id: "recommended",
    title: "Recommended extensions",
    features: RECOMMENDED_EXTENSIONS.map((extension) => ({
      title: extension.displayName,
      description: `${extension.description} Recommended version: ${extension.version}.`,
      icon: "extensions",
      actions: [
        {
          label: "Install from Open VSX…",
          command: "workbench.extensions.installExtension",
          args: [extension.id],
          primary: true,
        },
        {
          label: "Install from URL…",
          command: "dataverseIde.vsix.installFromUrl",
          args: [extension.url],
        },
      ],
    })),
  },
];

let api: typeof vscodeType | undefined;

function vscodeApi(): typeof vscodeType {
  if (api == null) {
    throw new Error("[welcome] The welcome editor was opened before activation.");
  }

  return api;
}

function readShowOnStartup(): boolean {
  return vscodeApi()
    .workspace.getConfiguration(CONFIG_SECTION)
    .get<boolean>(SETTING_SHOW_ON_STARTUP, true);
}

async function writeShowOnStartup(value: boolean): Promise<void> {
  await vscodeApi()
    .workspace.getConfiguration(CONFIG_SECTION)
    .update(SETTING_SHOW_ON_STARTUP, value, vscodeApi().ConfigurationTarget.Global);
}

class WelcomeEditorInput extends SimpleEditorInput {
  static readonly ID = EDITOR_ID;
  static readonly RESOURCE = WELCOME_RESOURCE;

  constructor() {
    super(WelcomeEditorInput.RESOURCE);

    this.setName("Welcome");
    this.setTitle("Welcome to Dataverse IDE");
    this.setDescription("Features & extensions");
    this.addCapability(EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton);
  }

  get typeId(): string {
    return WelcomeEditorInput.ID;
  }
}

class WelcomeEditorPane extends SimpleEditorPane {
  constructor(group: IEditorGroup) {
    super(WelcomeEditorInput.ID, group);
  }

  initialize(): HTMLElement {
    ensureStyles();

    const root = document.createElement("div");
    root.className = "diw-root";
    root.tabIndex = 0;
    root.setAttribute("role", "document");
    root.setAttribute("aria-label", "Dataverse IDE welcome page");

    const page = document.createElement("div");
    page.className = "diw-page";
    root.append(page);

    page.append(createHero());

    for (const section of SECTIONS) {
      page.append(createSection(section));
    }

    page.append(createFooter());

    return root;
  }

  async renderInput(): Promise<{ dispose(): void }> {
    return {
      dispose() {
        /* The page is static; nothing to clean up per input. */
      },
    };
  }
}

function createHero(): HTMLElement {
  const hero = document.createElement("header");
  hero.className = "diw-hero";

  const eyebrow = document.createElement("div");
  eyebrow.className = "diw-eyebrow";
  eyebrow.textContent = "DATAVERSE IDE";

  const heading = document.createElement("h1");
  heading.textContent = "Welcome to your browser IDE";

  const lead = document.createElement("p");
  lead.className = "diw-lead";
  lead.textContent =
    "A full VS Code workbench that opens real local folders, deploys Dataverse web resources, builds bundles and runs Node — all without a desktop install.";

  const actions = document.createElement("div");
  actions.className = "diw-hero-actions";

  actions.append(
    createButton({
      label: "Show All Commands",
      command: "workbench.action.showCommands",
      primary: true,
    }),
    createButton({
      label: "Open Extensions",
      command: "workbench.view.extensions",
    }),
    createButton({
      label: "Open Settings",
      command: "workbench.action.openSettings",
    }),
  );

  hero.append(eyebrow, heading, lead, actions);

  return hero;
}

function createSection(section: WelcomeSection): HTMLElement {
  const element = document.createElement("section");
  element.className = "diw-section";
  element.id = `diw-section-${section.id}`;

  const heading = document.createElement("h2");
  heading.textContent = section.title;
  element.append(heading);

  const grid = document.createElement("div");
  grid.className = "diw-grid";
  element.append(grid);

  for (const feature of section.features) {
    grid.append(createFeatureCard(feature));
  }

  return element;
}

function createFeatureCard(feature: WelcomeFeature): HTMLElement {
  const card = document.createElement("article");
  card.className = "diw-card";

  const head = document.createElement("div");
  head.className = "diw-card-head";

  const icon = document.createElement("span");
  icon.className = `codicon codicon-${feature.icon} diw-card-icon`;
  icon.setAttribute("aria-hidden", "true");

  const title = document.createElement("h3");
  title.textContent = feature.title;

  head.append(icon, title);
  card.append(head);

  const description = document.createElement("p");
  description.textContent = feature.description;
  card.append(description);

  if (feature.actions != null && feature.actions.length > 0) {
    const actions = document.createElement("div");
    actions.className = "diw-card-actions";

    for (const action of feature.actions) {
      actions.append(createButton(action));
    }

    card.append(actions);
  }

  if (feature.guide != null) {
    card.append(createGuideLink(feature.guide));
  }

  return card;
}

function runCommand(command: string, args?: unknown[]): void {
  void vscodeApi()
    .commands.executeCommand(command, ...(args ?? []))
    .then(undefined, (error: unknown) => {
      void vscodeApi().window.showErrorMessage(
        `Could not run "${command}": ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

function createButton(action: WelcomeAction): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action.primary === true ? "diw-button primary" : "diw-button";
  button.textContent = action.label;

  button.addEventListener("click", () => {
    runCommand(action.command, action.args);
  });

  return button;
}

function createGuideLink(command: string): HTMLButtonElement {
  const link = document.createElement("button");
  link.type = "button";
  link.className = "diw-guide-link";
  link.textContent = "How-to guide →";

  link.addEventListener("click", () => {
    runCommand(command);
  });

  return link;
}

function createFooter(): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "diw-footer";

  const toggle = document.createElement("label");
  toggle.className = "diw-toggle";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = readShowOnStartup();

  checkbox.addEventListener("change", () => {
    void writeShowOnStartup(checkbox.checked).catch((error: unknown) => {
      void vscodeApi().window.showErrorMessage(
        `Could not save the welcome setting: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });

  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = "Show this page on startup";

  toggle.append(checkbox, toggleLabel);

  const hint = document.createElement("span");
  hint.className = "diw-hint";
  hint.append(
    document.createTextNode("Run "),
    createKbd("Ctrl"),
    document.createTextNode(" + "),
    createKbd("Shift"),
    document.createTextNode(" + "),
    createKbd("P"),
    document.createTextNode(' and choose "Welcome: Show Welcome Page" any time.'),
  );

  footer.append(toggle, hint);

  return footer;
}

function createKbd(label: string): HTMLElement {
  const kbd = document.createElement("kbd");
  kbd.textContent = label;

  return kbd;
}

const STYLE_ID = "dataverse-ide-welcome-styles";

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) != null) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.diw-root {
  box-sizing: border-box;
  min-height: 100%;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}

.diw-page {
  box-sizing: border-box;
  width: min(1120px, 100%);
  margin: 0 auto;
  padding: 48px 40px 64px;
}

.diw-hero {
  margin-bottom: 48px;
}

.diw-eyebrow {
  color: var(--vscode-textLink-foreground);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.6px;
  margin-bottom: 10px;
}

.diw-hero h1 {
  margin: 0 0 14px;
  font-size: 34px;
  font-weight: 300;
  line-height: 1.2;
  letter-spacing: -0.4px;
}

.diw-lead {
  max-width: 760px;
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 15px;
  line-height: 1.6;
}

.diw-hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}

.diw-button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 6px 13px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.diw-button:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.diw-button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.diw-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.diw-button.primary:hover {
  background: var(--vscode-button-hoverBackground);
}

.diw-section {
  margin-bottom: 40px;
}

.diw-section h2 {
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  font-size: 17px;
  font-weight: 500;
}

.diw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.diw-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 16px 18px 18px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
}

.diw-card-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
}

.diw-card-icon {
  color: var(--vscode-textLink-foreground);
  font-size: 18px;
  line-height: 1;
}

.diw-card h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.diw-card p {
  flex: 1;
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12.5px;
  line-height: 1.55;
}

.diw-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.diw-guide-link {
  align-self: flex-start;
  margin-top: 12px;
  padding: 0;
  border: none;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.diw-guide-link:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}

.diw-guide-link:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.diw-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.diw-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.diw-toggle input {
  accent-color: var(--vscode-checkbox-background);
}

.diw-hint {
  line-height: 1.6;
}

.diw-hint kbd {
  padding: 1px 5px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  border-radius: 3px;
  background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.12));
  color: var(--vscode-keybindingLabel-foreground, inherit);
  font-family: inherit;
  font-size: 11px;
}
`;

  document.head.append(style);
}

async function openWelcomeEditor(): Promise<void> {
  const editorService = StandaloneServices.get(IEditorService);
  const existing = editorService.findEditors(WelcomeEditorInput.RESOURCE)[0]?.editor;

  await editorService.openEditor(existing ?? new WelcomeEditorInput(), {
    pinned: true,
    revealIfOpened: true,
  });
}

export default {
  id: "welcome",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    api = context.vscode;

    let startupTimer: number | undefined;

    await contributeExtensionManifest({
      id: "welcome",
      displayName: "Dataverse IDE Welcome",
      description: "Landing page describing the IDE's features and extensions.",
      commands: [
        {
          command: COMMAND_OPEN,
          title: "Welcome: Show Welcome Page",
        },
        {
          command: "dataverseIde.welcome.openGuide",
          title: "Welcome: How-to Guide",
        },
      ],
      configuration: {
        title: "Dataverse IDE Welcome",
        properties: {
          "dataverseIde.welcome.showOnStartup": {
            type: "boolean",
            default: true,
            description: "Show the Dataverse IDE welcome page when the workbench starts.",
          },
        },
      },
    });

    const guideRegistration = registerGuide({
      vscode: context.vscode,
      extensionId: "welcome",
      content: guideContent,
    });

    const paneRegistration = registerEditorPane(
      WelcomeEditorInput.ID,
      "Dataverse IDE Welcome",
      WelcomeEditorPane,
      [WelcomeEditorInput],
    );

    const commandRegistration = context.vscode.commands.registerCommand(COMMAND_OPEN, () =>
      openWelcomeEditor(),
    );

    const menuRegistration = MenuRegistry.appendMenuItem(MenuId.MenubarHelpMenu, {
      command: {
        id: COMMAND_OPEN,
        title: "Welcome",
      },
      group: "1_welcome",
      order: 0,
    });

    if (readShowOnStartup()) {
      /*
       * Let the workbench finish its first layout before opening a tab, and
       * never replace an editor the user already has open (for example when
       * the workbench restores a previous session).
       */
      startupTimer = window.setTimeout(() => {
        try {
          const editorService = StandaloneServices.get(IEditorService);

          if (editorService.activeEditor == null) {
            void openWelcomeEditor().catch((error: unknown) => {
              context.outputChannel.appendLine(
                `[welcome] Could not open the welcome page: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          }
        } catch (error) {
          context.outputChannel.appendLine(
            `[welcome] Could not read the editor service: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }, 250);
    }

    context.outputChannel.appendLine("[welcome] extension activated.");

    return {
      dispose() {
        if (startupTimer != null) {
          window.clearTimeout(startupTimer);
        }

        paneRegistration.dispose();
        commandRegistration.dispose();
        menuRegistration.dispose();
        guideRegistration.dispose();
      },
    };
  },
} satisfies IdeExtension;
