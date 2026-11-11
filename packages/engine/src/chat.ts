import type { AppContext } from './context.js';
import type { Message, MessageMeta } from './protocol.js';
import { insertMessage, updateMessageMeta, type NewMessage } from './store/messages.js';

/** Stores a message and pushes it to everyone watching the group. */
export function postMessage(ctx: AppContext, input: NewMessage): Message {
  const message = insertMessage(ctx.db, input);
  ctx.hub.broadcast(input.groupId, { type: 'message.created', message });
  return message;
}

/** A message from Symposium itself: hires, errors, merges and so on. */
export function postNotice(
  ctx: AppContext,
  groupId: string,
  body: string,
  level: 'info' | 'warning' | 'error' = 'info',
): Message {
  return postMessage(ctx, {
    groupId,
    authorKind: 'system',
    body,
    meta: { type: 'notice', level },
  });
}

export function setMessageMeta(ctx: AppContext, message: Message, meta: MessageMeta): Message {
  const updated = updateMessageMeta(ctx.db, message.id, meta)!;
  ctx.hub.broadcast(message.groupId, { type: 'message.updated', message: updated });
  return updated;
}
