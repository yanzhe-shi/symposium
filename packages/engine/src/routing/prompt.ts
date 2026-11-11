import type { AgentAccess } from '@symposium/adapters';
import type { Agent, Group, Message } from '../protocol.js';

/** Upper bound on the conversation part of a prompt, in characters. Oldest messages go first. */
export const MAX_TRANSCRIPT_CHARS = 60_000;
/** How many recent messages the lead sees. */
export const LEAD_HISTORY = 60;
/** How many relevant messages other agents see. */
export const MEMBER_HISTORY = 25;
const MAX_DIFF_IN_PROMPT = 30_000;

export interface PromptInput {
  group: Group;
  agent: Agent;
  /** Active team, including the agent itself. */
  team: Agent[];
  /** All agents that ever wrote in the group, to name authors of old messages. */
  everyone: Agent[];
  roleText: string;
  access: AgentAccess;
  /** Branch the agent works on, for workers. */
  branch?: string;
  projectMd: string;
  memory: string;
  /** Recent messages in the group, oldest first. */
  history: Message[];
  trigger: Message;
}

function describeAgent(agent: Agent): string {
  const specialty = agent.instructions ? `: ${agent.instructions.split('\n')[0]}` : '';
  return `${agent.name}: ${agent.role}${specialty}`;
}

function accessRules(access: AgentAccess, branch?: string): string {
  switch (access) {
    case 'edit':
      return [
        `- You work in your own git worktree${branch ? ` on branch \`${branch}\`` : ''}. Edit files there.`,
        '- After your turn Symposium commits your changes and shows the CEO a diff. Nothing reaches the main project until the CEO merges it.',
        '- You cannot run shell commands, install packages or use git.',
      ].join('\n');
    case 'read':
      return '- You can read files in the project folder, but you cannot change them or run commands.';
    case 'none':
      return '- You have no tools. Work only from the text you are given.';
  }
}

const HIRE_HELP = `## Proposing hires

To propose a new teammate, add one block per person:

\`\`\`hire
{"name": "Max", "role": "worker", "provider": "claude-code", "model": "sonnet", "instructions": "Backend specialist: APIs and the database"}
\`\`\`

- role: worker, reviewer or scribe (there is only one lead: you)
- provider: claude-code, antigravity, openai-compatible or mock. Prefer the providers your current team uses.
- The CEO approves or rejects each proposal. Don't assign work to someone until they have joined.`;

export function buildSystemPrompt(input: PromptInput): string {
  const { group, agent, team, roleText, access, branch } = input;
  const roster = team
    .map((member) => `- ${describeAgent(member)}${member.id === agent.id ? ' (you)' : ''}`)
    .join('\n');

  const sections = [
    `You are ${agent.name}, the ${agent.role} of a software team that works together in a group chat called "${group.name}". The human running the project is the CEO: they approve plans, hires and merges.`,
    roleText,
  ];
  if (agent.instructions) sections.push(`## Your specialty\n\n${agent.instructions}`);
  sections.push(
    `## The team\n\n${roster}\n- The CEO (human)`,
    [
      '## How the chat works',
      '',
      '- To give a teammate work or ask them something, @mention them by name, like "@Ada please add the login form". Every mention gives that teammate a turn, so mention someone only when you need them to act.',
      '- If you mention nobody, your reply goes to the CEO and the team waits for them.',
      '- Never mention yourself. The CEO needs no mention.',
      '- Keep replies short and concrete. No greetings or sign-offs.',
      accessRules(access, branch),
    ].join('\n'),
    [
      '## Your memory',
      '',
      'You have a private memory that follows you between turns and projects. To save a note, add a block:',
      '',
      '```memory',
      '- The CEO prefers small pull requests',
      '```',
      '',
      'It is removed from your message and shown to you in every future turn. Save only lasting facts and preferences.',
    ].join('\n'),
  );
  if (agent.role === 'lead') sections.push(HIRE_HELP);
  return sections.join('\n\n');
}

function authorLabel(message: Message, everyone: Agent[]): string {
  if (message.authorKind === 'human') return 'CEO';
  if (message.authorKind === 'system') return 'Symposium';
  const author = everyone.find((agent) => agent.id === message.authorAgentId);
  return author ? `${author.name} (${author.role})` : 'Former agent';
}

function formatMessage(message: Message, everyone: Agent[]): string {
  let body = message.body;
  if (message.meta?.type === 'diff') {
    const { stat, diff, truncated, status } = message.meta;
    body = `${message.body}\nStatus: ${status}\n${stat}`;
    // Pending diffs are shown in full so the lead and reviewers can judge them.
    if (status === 'pending') {
      const shown = diff.length > MAX_DIFF_IN_PROMPT ? diff.slice(0, MAX_DIFF_IN_PROMPT) : diff;
      const cut = truncated || shown.length < diff.length ? '\n[diff truncated]' : '';
      body += `\n\`\`\`diff\n${shown}\n\`\`\`${cut}`;
    }
  }
  return `[#${message.id} · ${authorLabel(message, everyone)}]\n${body}`;
}

/** Messages this agent may see. The lead sees everything; others see what concerns them. */
export function visibleHistory(input: PromptInput): Message[] {
  const { agent, history, trigger } = input;
  if (agent.role === 'lead') return history.slice(-LEAD_HISTORY);

  const mentionPattern = new RegExp(`(^|[^A-Za-z0-9_@./-])@${agent.name}(?![A-Za-z0-9_])`, 'i');
  const relevant = history.filter(
    (message) =>
      message.id === trigger.id ||
      message.authorAgentId === agent.id ||
      mentionPattern.test(message.body) ||
      // Work waiting for review is relevant to everyone who might be asked about it.
      (message.meta?.type === 'diff' && message.meta.status === 'pending'),
  );
  return relevant.slice(-MEMBER_HISTORY);
}

export function buildPrompt(input: PromptInput): string {
  const { agent, everyone, trigger, projectMd, memory } = input;
  const entries = visibleHistory(input).map((message) => formatMessage(message, everyone));

  // Drop the oldest entries until the conversation fits.
  let total = entries.reduce((sum, entry) => sum + entry.length + 2, 0);
  while (entries.length > 1 && total > MAX_TRANSCRIPT_CHARS) {
    total -= entries.shift()!.length + 2;
  }

  const from = authorLabel(trigger, everyone);
  return [
    `# project.md\n\n${projectMd.trim() || '(empty)'}`,
    `# Your memory\n\n${memory.trim() || '(nothing saved yet)'}`,
    `# Conversation (oldest first)\n\n${entries.join('\n\n')}`,
    `# Your turn\n\nMessage #${trigger.id} from ${from} is addressed to you. Reply to it now, as ${agent.name}.`,
  ].join('\n\n---\n\n');
}
