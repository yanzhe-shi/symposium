import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** How much memory goes into each prompt. The newest notes are kept. */
export const MAX_MEMORY_IN_PROMPT = 8_000;
export const MAX_MEMORY_FILE = 200_000;

/**
 * Each agent's memory is a Markdown file owned by Symposium, not by the provider, so it follows
 * the agent across models and (in version 2) across groups.
 */
export function memoryPath(dataDir: string, agentId: string): string {
  return join(dataDir, 'agents', agentId, 'memory.md');
}

export async function readMemory(dataDir: string, agentId: string): Promise<string> {
  try {
    return await readFile(memoryPath(dataDir, agentId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** The part of memory that goes into a prompt: the newest notes, cut at a line break. */
export function memoryForPrompt(memory: string): string {
  if (memory.length <= MAX_MEMORY_IN_PROMPT) return memory;
  const tail = memory.slice(-MAX_MEMORY_IN_PROMPT);
  const firstBreak = tail.indexOf('\n');
  return `(older notes omitted)\n${firstBreak === -1 ? tail : tail.slice(firstBreak + 1)}`;
}

export async function appendMemory(
  dataDir: string,
  agentId: string,
  notes: string[],
  context: string,
  now = new Date(),
): Promise<void> {
  if (notes.length === 0) return;
  const path = memoryPath(dataDir, agentId);
  await mkdir(dirname(path), { recursive: true });
  const heading = `## ${now.toISOString().slice(0, 10)} · ${context}`;
  await appendFile(path, `\n${heading}\n\n${notes.join('\n\n')}\n`);
}

export async function writeMemory(dataDir: string, agentId: string, text: string): Promise<void> {
  const path = memoryPath(dataDir, agentId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
