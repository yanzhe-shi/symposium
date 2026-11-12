import { CancelledError, DEFAULT_TIMEOUT_MS } from '@symposium/adapters';
import { postNotice } from './chat.js';
import type { AppContext } from './context.js';
import { readProjectFile, writeProjectFile } from './project-file.js';
import type { Group } from './protocol.js';
import { loadRoleText } from './roles.js';
import { formatMessage, MAX_TRANSCRIPT_CHARS } from './routing/prompt.js';
import { listAgents } from './store/agents.js';
import { logEvent } from './store/events.js';
import { getScribeCursor, setScribeCursor } from './store/groups.js';
import { listMessagesSince } from './store/messages.js';

export const MAX_PROJECT_FILE = 100_000;

/** Removes a code fence wrapped around the whole reply, which models sometimes add. */
export function unwrapMarkdown(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md)?[^\S\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

/**
 * Asks the scribe to fold the messages since its last update into project.md, then writes the
 * file. The scribe only returns text: the engine does the writing. Does nothing without a scribe
 * or new messages.
 */
export async function updateProjectFile(
  ctx: AppContext,
  group: Group,
  signal?: AbortSignal,
): Promise<boolean> {
  const scribe = listAgents(ctx.db, group.id).find((agent) => agent.role === 'scribe');
  if (!scribe || !group.folderPath) return false;

  const everyone = listAgents(ctx.db, group.id, { includeFired: true });
  const cursor = getScribeCursor(ctx.db, group.id);
  // The scribe's own notices are not news.
  const fresh = listMessagesSince(ctx.db, group.id, cursor).filter(
    (message) => !(message.meta?.type === 'notice' && message.body.includes('updated project.md')),
  );
  if (fresh.length === 0) return false;
  const lastId = fresh.at(-1)!.id;

  const entries = fresh.map((message) => formatMessage(message, everyone, false));
  let total = entries.reduce((sum, entry) => sum + entry.length + 2, 0);
  while (entries.length > 1 && total > MAX_TRANSCRIPT_CHARS) total -= entries.shift()!.length + 2;

  const current = await readProjectFile(group.folderPath);
  const systemPrompt = [
    `You are ${scribe.name}, the scribe of a software team working in a group chat called "${group.name}".`,
    await loadRoleText(ctx.rolesDir, 'scribe'),
    scribe.instructions ? `## Your specialty\n\n${scribe.instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const prompt = [
    `# Current project.md\n\n${current.trim() || '(empty)'}`,
    `# New messages since your last update\n\n${entries.join('\n\n')}`,
    '# Your task\n\nReturn the complete, updated project.md. Output only the file content.',
  ].join('\n\n---\n\n');

  ctx.hub.broadcast(group.id, { type: 'agent.activity', agentId: scribe.id, activity: 'working' });
  try {
    const result = await ctx.createAdapter(scribe).run({
      agentName: scribe.name,
      model: scribe.model,
      systemPrompt,
      prompt,
      trigger: 'Update project.md',
      workingDirectory: group.folderPath,
      access: 'none',
      effort: scribe.settings.effort,
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const content = unwrapMarkdown(result.text);
    if (content === '' || content.length > MAX_PROJECT_FILE) {
      throw new Error(
        content === '' ? 'the reply was empty' : 'the reply was too long for project.md',
      );
    }
    await writeProjectFile(group.folderPath, content);
    setScribeCursor(ctx.db, group.id, lastId);
    logEvent(ctx.db, {
      groupId: group.id,
      agentId: scribe.id,
      kind: 'project.updated',
      detail: { throughMessageId: lastId, costUsd: result.costUsd, chars: content.length },
    });
    ctx.hub.broadcast(group.id, { type: 'project.updated' });
    postNotice(ctx, group.id, `${scribe.name} updated project.md.`);
    return true;
  } catch (error) {
    if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
    postNotice(
      ctx,
      group.id,
      `${scribe.name} could not update project.md: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
    return false;
  } finally {
    ctx.hub.broadcast(group.id, { type: 'agent.activity', agentId: scribe.id, activity: 'idle' });
  }
}
