#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const outputFileName = process.argv[2] ?? "temp/agent-context.md";
const outputPath = path.resolve(projectRoot, outputFileName);

const excludedTopLevelFiles = new Set([
  "package-lock.json",
  path.basename(outputPath),
]);

const languageByExtension = {
  ".c": "c",
  ".cc": "cpp",
  ".css": "css",
  ".csv": "csv",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "jsx",
  ".md": "markdown",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".py": "python",
  ".sh": "bash",
  ".sql": "sql",
  ".svg": "xml",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".txt": "text",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

function getLanguage(filePath) {
  const baseName = path.basename(filePath);

  if (baseName === "Dockerfile") return "dockerfile";
  if (baseName === ".gitignore") return "gitignore";
  if (baseName === ".env.example") return "dotenv";

  return languageByExtension[path.extname(filePath).toLowerCase()] ?? "text";
}

function getFence(content) {
  let longestRun = 0;
  let currentRun = 0;

  for (const character of content) {
    if (character === "`") {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  }

  return "`".repeat(Math.max(3, longestRun + 1));
}

function isProbablyBinary(buffer) {
  return buffer.includes(0);
}

async function getTopLevelFiles() {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => !excludedTopLevelFiles.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function getSourceFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await getSourceFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function readTextFile(relativePath) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const buffer = await fs.readFile(absolutePath);

  if (isProbablyBinary(buffer)) {
    return null;
  }

  return buffer.toString("utf8");
}

async function main() {
  const topLevelFiles = await getTopLevelFiles();

  const srcDirectory = path.join(projectRoot, "src");
  let sourceFiles = [];

  try {
    const srcStats = await fs.stat(srcDirectory);

    if (srcStats.isDirectory()) {
      sourceFiles = (await getSourceFiles(srcDirectory))
        .map((absolutePath) => path.relative(projectRoot, absolutePath))
        .sort((a, b) => a.localeCompare(b));
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const files = [...topLevelFiles, ...sourceFiles];

  const sections = [
    "# Agent Context",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "This file contains top-level project files and all text files under `src/`.",
    "`package-lock.json` and this generated file are excluded.",
    "",
    "---",
    "",
  ];

  for (const relativePath of files) {
    const content = await readTextFile(relativePath);

    if (content === null) {
      sections.push(`## \`${relativePath}\``);
      sections.push("");
      sections.push("_Skipped: file appears to be binary._");
      sections.push("");
      continue;
    }

    const normalizedContent = content.replace(/\r\n/g, "\n");
    const fence = getFence(normalizedContent);
    const language = getLanguage(relativePath);

    sections.push(`## \`${relativePath}\``);
    sections.push("");
    sections.push(`${fence}${language}`);
    sections.push(normalizedContent.endsWith("\n")
      ? normalizedContent.slice(0, -1)
      : normalizedContent);
    sections.push(fence);
    sections.push("");
  }

  await fs.writeFile(outputPath, sections.join("\n"), "utf8");

  console.log(
    `Created ${path.relative(projectRoot, outputPath)} with ${files.length} file(s).`,
  );
}

main().catch((error) => {
  console.error("Failed to build agent context:", error);
  process.exitCode = 1;
});