import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { badRequest } from './errors.js';

/**
 * Checks a group's project folder and creates it if missing. Refuses folders that would be
 * dangerous to turn into a git repo: the filesystem root, the home folder, and Symposium's own data.
 */
export async function prepareProjectFolder(folderPath: string, dataDir: string): Promise<string> {
  const trimmed = folderPath.trim();
  if (!isAbsolute(trimmed)) throw badRequest('Project folder must be an absolute path');
  const folder = resolve(trimmed);

  if (folder === resolve('/') || folder === resolve(homedir())) {
    throw badRequest('Pick a project folder, not the root or home folder');
  }
  const insideData = relative(resolve(dataDir), folder);
  if (insideData === '' || (!insideData.startsWith('..') && !isAbsolute(insideData))) {
    throw badRequest("Project folder can't be inside Symposium's data folder");
  }

  try {
    const info = await stat(folder);
    if (!info.isDirectory()) throw badRequest(`${folder} exists and is not a folder`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(folder, { recursive: true });
  }
  return folder;
}
