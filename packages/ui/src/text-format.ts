export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'file' | 'context';

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return 'file';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

/** A file size for people: "812 B", "4.2 KB", "1.3 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The folder suggested for a new project: the group's name, made safe for a path, inside the
 * projects folder. "Sock Shop!" in /home/you/symposium-projects gives …/sock-shop.
 */
export function projectFolderFor(projectsFolder: string, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const base = projectsFolder.replace(/[/\\]+$/, '');
  return slug ? `${base}/${slug}` : '';
}

/** The end of a long path, for a title bar: "/home/you/projects/sock-shop" gives "…/projects/sock-shop". */
export function shortPath(path: string, keep = 2): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join('/')}`;
}
