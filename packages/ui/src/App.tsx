import type { Group, ProviderInfo, RoleInfo } from '@symposium/engine/protocol';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { GroupView } from './components/GroupView.tsx';
import { NewGroupForm } from './components/NewGroupForm.tsx';
import { Sidebar } from './components/Sidebar.tsx';

const SELECTED_GROUP_KEY = 'symposium.selectedGroup';

export interface Catalog {
  providers: ProviderInfo[];
  roles: RoleInfo[];
}

export function App() {
  const [groups, setGroups] = useState<Group[]>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(SELECTED_GROUP_KEY));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    Promise.all([api.groups(), api.providers(), api.roles()])
      .then(([loadedGroups, providers, roles]) => {
        if (!active) return;
        setGroups(loadedGroups);
        setCatalog({ providers, roles });
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
              catalog={catalog}
              onGroupChanged={onGroupChanged}
              onGroupDeleted={onGroupDeleted}
            />
          )
        )}
      </main>
    </div>
  );
}
