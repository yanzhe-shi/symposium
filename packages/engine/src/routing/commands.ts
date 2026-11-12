/** Chat commands the human can start a message with. They control the team; agents never run them. */
export type ChatCommand = 'stop' | 'now';

const COMMAND_PATTERN = /^\s*\/(stop|now)(?=\s|$)/i;

/**
 * - `/stop` cancels the agents the message mentions, or everyone if it mentions nobody.
 * - `/now` interrupts the agents the message is for and restarts them on this message.
 */
export function parseCommand(body: string): ChatCommand | undefined {
  const match = COMMAND_PATTERN.exec(body);
  return match ? (match[1]!.toLowerCase() as ChatCommand) : undefined;
}
