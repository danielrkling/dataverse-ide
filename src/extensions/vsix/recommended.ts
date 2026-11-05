/*
 * Extensions that Dataverse IDE recommends.
 *
 * The workbench is connected to the Open VSX gallery, so these are installed
 * through the normal extension management flow. The Welcome page links to the
 * gallery install command so users do not have to search for them.
 */

export type RecommendedExtension = {
  id: string;
  displayName: string;
  version: string;
  description: string;
  /** Direct URL to a web-compatible VSIX, for the VSIX URL fallback. */
  url: string;
};

export const RECOMMENDED_EXTENSIONS: RecommendedExtension[] = [
  {
    id: "esbenp.prettier-vscode",
    displayName: "Prettier - Code formatter",
    version: "12.4.0",
    description:
      "The official Prettier extension. Its web build formats TSX, TypeScript, JavaScript, HTML, CSS, JSON, YAML, Markdown and GraphQL with bundled Prettier, driven by the standard editor.formatOnSave and prettier.* settings. After installing, set it as the default formatter for TypeScript and TypeScript React; project .prettierrc files are not read by the web build.",
    url: "https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/esbenp.prettier-vscode-12.4.0.vsix",
  },
];
