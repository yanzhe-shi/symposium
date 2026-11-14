import type { Group, ProviderInfo, RoleInfo, SystemInfo } from '@symposium/engine/protocol';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { GroupView } from './components/GroupView.tsx';
import { NewGroupForm } from './components/NewGroupForm.tsx';
import { Sidebar } from './components/Sidebar.tsx';

const SELECTED_GROUP_KEY = 'symposium.selectedGroup';

export interface Catalog {
  providers: ProviderInfo[];
  roles: RoleInfo[];
  /** What is installed here. Undefined if the engine could not say. */
  system: SystemInfo | undefined;
  /** Reads the roles again, after one was added, changed or removed. */
  reloadRoles: () => Promise<void>;
}

export function App() {
  const [groups, setGroups] = useState<Group[]>();
  const [catalog, setCatalog] = useState<Omit<Catalog, 'reloadRoles'>>();
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(SELECTED_GROUP_KEY));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    // The checks are a help, not a need: without them the app still works.
    const system = api.system().catch(() => undefined);
    Promise.all([api.groups(), api.providers(), api.roles(), system])
      .then(([loadedGroups, providers, roles, systemInfo]) => {
        if (!active) return;
        setGroups(loadedGroups);
        setCatalog({ providers, roles, system: systemInfo });
      })
      .catch((err: unknown) => {
        if (active) setError(`Could not reach the engine: ${String(err)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  const select = useCallback((groupId: string) => {
    localStorage.setItem(SELECTED_GROUP_KEY, groupId);
    setSelectedId(groupId);
    setCreating(false);
  }, []);

  const onGroupChanged = useCallback((changed: Group) => {
    setGroups((current) => current?.map((group) => (group.id === changed.id ? changed : group)));
  }, []);

  const reloadRoles = useCallback(async () => {
    const roles = await api.roles();
    setCatalog((current) => current && { ...current, roles });
  }, []);

  const onGroupDeleted = useCallback((groupId: string) => {
    setGroups((current) => current?.filter((group) => group.id !== groupId));
  }, []);

  if (error) return <p className="app-message app-error">{error}</p>;
  if (!groups || !catalog) return <p className="app-message">Loading…</p>;

  const selected = groups.find((group) => group.id === selectedId) ?? groups[0];
  const showForm = creating || groups.length === 0;

  return (
    <div className="app">
      <Sidebar
        groups={groups}
        selectedId={showForm ? undefined : selected?.id}
        onSelect={select}
        onNew={() => setCreating(true)}
      />
      <main className="app-main">
        {showForm ? (
          <NewGroupForm
            firstGroup={groups.length === 0}
            providers={catalog.providers}
            system={catalog.system}
            onCancel={groups.length > 0 ? () => setCreating(false) : undefined}
            onCreated={(group) => {
              setGroups((current) => [...(current ?? []), group]);
              select(group.id);
            }}
          />
        ) : (
          selected && (
            <GroupView
              key={selected.id}
              group={selected}
              catalog={{ ...catalog, reloadRoles }}
              onGroupChanged={onGroupChanged}
              onGroupDeleted={onGroupDeleted}
            />
          )
        )}
      </main>
    </div>
  );
}
