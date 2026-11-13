import type { Agent, Group } from '@symposium/engine/protocol';
import { useCallback, useEffect, useEffectEvent, useReducer, useState } from 'react';
import { api, connectGroup, type CodeLocation, type ConnectionStatus } from './api.ts';
import { groupReducer, initialGroupState, type GroupState } from './group-state.ts';

export interface UseGroup {
  state: GroupState;
  status: ConnectionStatus;
  loadError: string | undefined;
  send: (body: string) => Promise<void>;
  /** Runs a command of your own in the project folder or an agent's worktree. */
  runCommand: (where: CodeLocation, command: string) => Promise<void>;
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
        void loadLiveView(agents);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      }
    }

    // What agents did lately and what they have changed but not committed. The chat works
    // without these, so a failure here is not an error worth showing.
    async function loadLiveView(agents: Agent[]): Promise<void> {
      void api
        .activity(groupId)
        .then((progress) => {
          if (active) dispatch({ type: 'progress', progress });
        })
        .catch(() => undefined);
      for (const agent of agents) {
        if (agent.firedAt !== null || agent.settings.files !== 'edit') continue;
        void api
          .changes(groupId, agent.id)
          .then((changes) => {
            if (active) dispatch({ type: 'changes', agentId: agent.id, changes });
          })
          .catch(() => undefined);
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
            dispatch({ type: 'messagesReceived', messages: [event.message] });
            break;
          case 'message.updated':
            dispatch({ type: 'messagesReceived', messages: [event.message] });
            // A merge or a discard changes files on disk.
            if (event.message.meta?.type === 'diff') dispatch({ type: 'filesChanged' });
            break;
          case 'agent.progress':
            dispatch({ type: 'progress', progress: [event.progress] });
            break;
          case 'worktree.changed':
            dispatch({ type: 'changes', agentId: event.agentId, changes: event.changes });
            break;
          case 'terminal.output':
            dispatch({ type: 'terminalOutput', runId: event.runId, text: event.text });
            break;
          case 'terminal.exit':
            dispatch({ type: 'terminalExit', runId: event.runId, exitCode: event.exitCode });
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

  const runCommand = useCallback(
    async (where: CodeLocation, command: string) => {
      dispatch({ type: 'terminalStarted', run: await api.runCommand(groupId, where, command) });
    },
    [groupId],
  );

  return { state, status, loadError, send, runCommand, reloadAgents };
}
