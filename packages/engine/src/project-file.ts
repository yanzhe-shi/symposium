import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PROJECT_FILE = 'project.md';
export const MAX_PROJECT_IN_PROMPT = 30_000;

export function projectFilePath(folder: string): string {
  return join(folder, PROJECT_FILE);
}

/** Reads the group's project.md. Missing file means an empty project description. */
export async function readProjectFile(folder: string | null): Promise<string> {
  if (!folder) return '';
  try {
    return await readFile(projectFilePath(folder), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function projectForPrompt(text: string): string {
  return text.length > MAX_PROJECT_IN_PROMPT
    ? `${text.slice(0, MAX_PROJECT_IN_PROMPT)}\n(project.md truncated)`
    : text;
}

export async function writeProjectFile(folder: string, text: string): Promise<void> {
  await writeFile(projectFilePath(folder), text.endsWith('\n') ? text : `${text}\n`);
}

export function initialProjectFile(groupName: string): string {
  return `# ${groupName}

## Goal

_Not set yet. Tell the lead what you want to build._

## Decisions

## Plan

## Status

## Open questions
`;
}
