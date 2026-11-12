import type { Group } from '@symposium/engine/protocol';
import { useCallback, useEffect, useEffectEvent, useReducer, useState } from 'react';
import { api, connectGroup, type ConnectionStatus } from './api.ts';
import { groupReducer, initialGroupState, type GroupState } from './group-state.ts';

export interface UseGroup {
  state: GroupState;
  status: ConnectionStatus;
  loadError: string | undefined;
  send: (body: string) => Promise<void>;
  reloadAgents: () => Promise<void>;
}

/** Live state for one group: loads it, then follows its WebSocket events. */
export function useGroup(groupId: string, onGroupChanged: (group: Group) => void): UseGroup {
  const [state, dispatch] = useReducer(groupReducer, initialGroupState);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [loadError, setLoadError] = useState<string>();
  const groupChanged = useEffectEvent(onGroupChanged);

  const reloadAgents = useCallback(async () => {
    dispatch({ type: 'agentsLoaded', agents: await api.agents(groupId) });
  }, [groupId]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    let active = true;

    // Loads everything. Runs on open and on every reconnect; merging makes repeats harmless.
    async function load(): Promise<void> {
      try {
        const [messages, agents, run] = await Promise.all([
          api.messages(groupId),
          api.agents(groupId),
          api.runStatus(groupId),
        ]);
        if (!active) return;
        dispatch({ type: 'agentsLoaded', agents });
        dispatch({ type: 'messagesReceived', messages });
        dispatch({ type: 'statusLoaded', status: run });
        setLoadError(undefined);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      }
    }

    // Load right away rather than waiting for the socket, so the chat still shows if the live
    // connection is slow or failing.
    void load();
    const stop = connectGroup(groupId, {
      onOpen: () => void load(),
      onStatusChange: setStatus,
      onEvent: (event) => {
        if (!active) return;
        switch (event.type) {
          case 'message.created':
          case 'message.updated':
            dispatch({ type: 'messagesReceived', messages: [event.message] });
            break;
          case 'agents.changed':
            void api.agents(groupId).then((agents) => {
              if (active) dispatch({ type: 'agentsLoaded', agents });
            });
            break;
          case 'agent.activity':
            dispatch({ type: 'activity', agentId: event.agentId, activity: event.activity });
            break;
          case 'agent.queue':
            dispatch({
              type: 'queue',
              agentId: event.agentId,
              queuedMessageIds: event.queuedMessageIds,
            });
            break;
          case 'message.delivered':
            dispatch({ type: 'delivered', agentId: event.agentId, messageId: event.messageId });
            break;
          case 'run.status':
            dispatch({ type: 'running', running: event.running });
            break;
          case 'project.updated':
            dispatch({ type: 'projectUpdated' });
            break;
          case 'group.changed':
            groupChanged(event.group);
            break;
        }
      },
    });

    return () => {
      active = false;
      stop();
    };
  }, [groupId]);

  const send = useCallback(
    async (body: string) => {
      const message = await api.post(groupId, body);
      dispatch({ type: 'messagesReceived', messages: [message] });
    },
    [groupId],
  );

  return { state, status, loadError, send, reloadAgents };
}
