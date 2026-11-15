import type { Group } from '@symposium/engine/protocol';
import { useEffect, useRef } from 'react';
import type { GroupState } from './group-state.ts';
import { arrivalNotice, notify, pageTitle, stoppedNotice, waitingCount } from './notify.ts';

/**
 * Tells the human that the open group needs them: the number of waiting cards in the tab's
 * title, and a desktop notification (when switched on, and the page is not in view) for a card
 * that holds an agent up and for the team coming to a stop.
 */
export function useWaitingSignals(group: Group, state: GroupState): void {
  const { messages, agents, running } = state;
  const waiting = waitingCount(messages);
  useEffect(() => {
    document.title = pageTitle(waiting);
    return () => {
      document.title = pageTitle(0);
    };
  }, [waiting]);

  // The newest message already looked at. Undefined until the chat has loaded, so that opening
  // a group announces nothing that was there before.
  const seenUpTo = useRef<number>(undefined);
  useEffect(() => {
    const newest = messages.at(-1)?.id;
    if (newest === undefined) return;
    const seen = seenUpTo.current;
    seenUpTo.current = newest;
    if (seen === undefined) return;
    const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? 'An agent';
    for (const message of messages) {
      if (message.id <= seen) continue;
      const notice = arrivalNotice(message, group.name, nameOf);
      if (notice) notify(notice, `symposium-card-${message.id}`);
    }
  }, [messages, agents, group.name]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      const notice = stoppedNotice(messages, group.name);
      if (notice) notify(notice, `symposium-stopped-${group.id}`);
    }
    wasRunning.current = running;
    // Only a change of `running` is an occasion to tell. The messages are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
}
