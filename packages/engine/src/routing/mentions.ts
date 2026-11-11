import type { Agent } from '../protocol.js';

// "@Name" not preceded by a word character, dot, slash or @ (so emails and paths don't count).
const MENTION_PATTERN = /(^|[^A-Za-z0-9_@./-])@([A-Za-z][A-Za-z0-9_-]{0,31})(?![A-Za-z0-9_])/g;

/** Removes fenced code blocks and inline code, where an @ is code, not a mention. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * The agents mentioned in `text`, in order of first mention, matched case-insensitively.
 * Names that match no agent are ignored. Trailing - or _ is trimmed ("@Ada-" means Ada).
 */
export function parseMentions(text: string, agents: readonly Agent[]): Agent[] {
  const byName = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent]));
  const found: Agent[] = [];
  for (const match of withoutCode(text).matchAll(MENTION_PATTERN)) {
    const raw = match[2]!.toLowerCase();
    const agent = byName.get(raw) ?? byName.get(raw.replace(/[-_]+$/, ''));
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}
