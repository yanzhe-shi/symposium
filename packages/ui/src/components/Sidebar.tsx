import type { Group } from '@symposium/engine/protocol';

interface SidebarProps {
  groups: Group[];
  selectedId: string | undefined;
  onSelect: (groupId: string) => void;
  onNew: () => void;
}

export function Sidebar({ groups, selectedId, onSelect, onNew }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Groups">
      <div className="sidebar-title">Symposium</div>
      <ul className="group-list">
        {groups.map((group) => (
          <li key={group.id}>
            <button
              type="button"
              className={`group-link${group.id === selectedId ? ' group-link-selected' : ''}`}
              onClick={() => onSelect(group.id)}
              title={group.folderPath ?? undefined}
            >
              # {group.name}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="button-secondary sidebar-new" onClick={onNew}>
        + New group
      </button>
    </nav>
  );
}
