import type { Group } from '@symposium/engine/protocol';
import { useEffect, useState } from 'react';
import { fetchGroups } from './api.ts';
import { ChatView } from './components/ChatView.tsx';

export function App() {
  const [group, setGroup] = useState<Group>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    // Milestone 1 has a single default group. Group selection arrives in milestone 3.
    fetchGroups()
      .then((groups) => {
        if (!active) return;
        if (groups[0]) setGroup(groups[0]);
        else setError('The engine has no groups.');
      })
      .catch((err: unknown) => {
        if (active) setError(`Could not reach the engine: ${String(err)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <p className="app-message app-error">{error}</p>;
  if (!group) return <p className="app-message">Loading…</p>;
  return <ChatView group={group} />;
}
