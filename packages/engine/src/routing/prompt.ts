import type { AgentAccess } from '@symposium/adapters';
import type { Agent, Group, Message } from '../protocol.js';
import { applyPlanApproval } from '../roles.js';

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
  /** The messages this turn answers, oldest first. More than one when they queued up. */
  triggers: Message[];
  /** True when the agent's previous turn was cut short to handle these messages (`/now`). */
  interrupted?: boolean;
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

const START_NOW = `## Start right away

The CEO has turned off plan approval. When you get a goal, give a short plan and assign the first tasks in the same reply. Don't wait for a go-ahead: the CEO can redirect or stop the team at any time.`;

export function buildSystemPrompt(input: PromptInput): string {
  const { group, agent, team, roleText, access, branch } = input;
  const roster = team
    .map((member) => `- ${describeAgent(member)}${member.id === agent.id ? ' (you)' : ''}`)
    .join('\n');

  const sections = [
    `You are ${agent.name}, the ${agent.role} of a software team that works together in a group chat called "${group.name}". The human running the project is the CEO: they approve plans, hires and merges.`,
    applyPlanApproval(roleText, group.leadAsksFirst),
  ];
  if (agent.instructions) sections.push(`## Your specialty\n\n${agent.instructions}`);
  sections.push(
    `## The team\n\n${roster}\n- The CEO (human)`,
    [
      '## How the chat works',
      '',
      '- To give a teammate work or ask them something, @mention them by name, like "@Ada please add the login form". Every mention gives that teammate a turn, so mention someone only when you need them to act.',
      '- If you mention nobody, your reply goes to the CEO and nobody else is asked to act.',
      '- Never mention yourself. The CEO needs no mention.',
      '- Teammates work at the same time, and the CEO can write at any moment without stopping anyone. Messages that arrive while you work reach you together in your next turn: answer them all in one reply.',
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
  if (agent.role === 'lead') {
    if (!group.leadAsksFirst) sections.push(START_NOW);
    sections.push(HIRE_HELP);
  }
  return sections.join('\n\n');
}

export function authorLabel(message: Message, everyone: Agent[]): string {
  if (message.authorKind === 'human') return 'CEO';
  if (message.authorKind === 'system') return 'Symposium';
  const author = everyone.find((agent) => agent.id === message.authorAgentId);
  return author ? `${author.name} (${author.role})` : 'Former agent';
}

/** One message as it appears in a prompt. Pending diffs are shown in full unless `fullDiffs` is off. */
export function formatMessage(message: Message, everyone: Agent[], fullDiffs = true): string {
  let body = message.body;
  if (message.meta?.type === 'diff') {
    const { stat, diff, truncated, status } = message.meta;
    body = `${message.body}\nStatus: ${status}\n${stat}`;
    // Pending diffs are shown in full so the lead and reviewers can judge them.
    if (fullDiffs && status === 'pending') {
      const shown = diff.length > MAX_DIFF_IN_PROMPT ? diff.slice(0, MAX_DIFF_IN_PROMPT) : diff;
      const cut = truncated || shown.length < diff.length ? '\n[diff truncated]' : '';
      body += `\n\`\`\`diff\n${shown}\n\`\`\`${cut}`;
    }
  }
  return `[#${message.id} · ${authorLabel(message, everyone)}]\n${body}`;
}

/** Messages this agent may see. The lead sees everything; others see what concerns them. */
export function visibleHistory(input: PromptInput): Message[] {
  const { agent, history, triggers } = input;
  const triggerIds = new Set(triggers.map((trigger) => trigger.id));
  let relevant = history;
  let limit = LEAD_HISTORY;
  if (agent.role !== 'lead') {
    const mentionPattern = new RegExp(`(^|[^A-Za-z0-9_@./-])@${agent.name}(?![A-Za-z0-9_])`, 'i');
    relevant = history.filter(
      (message) =>
        triggerIds.has(message.id) ||
        message.authorAgentId === agent.id ||
        mentionPattern.test(message.body) ||
        // Work waiting for review is relevant to everyone who might be asked about it.
        (message.meta?.type === 'diff' && message.meta.status === 'pending'),
    );
    limit = MEMBER_HISTORY;
  }
  const recent = relevant.slice(-limit);
  // Teammates keep talking while a message waits in an inbox, so a trigger can be older than
  // the recent window. The agent must still see what it is answering.
  const oldest = recent[0]?.id ?? Infinity;
  const waited = triggers.filter((trigger) => trigger.id < oldest);
  return [...waited, ...recent];
}

export function buildPrompt(input: PromptInput): string {
  const { everyone, projectMd, memory } = input;
  const entries = visibleHistory(input).map((message) => formatMessage(message, everyone));

  // Drop the oldest entries until the conversation fits.
  let total = entries.reduce((sum, entry) => sum + entry.length + 2, 0);
  while (entries.length > 1 && total > MAX_TRANSCRIPT_CHARS) {
    total -= entries.shift()!.length + 2;
  }

  return [
    `# project.md\n\n${projectMd.trim() || '(empty)'}`,
    `# Your memory\n\n${memory.trim() || '(nothing saved yet)'}`,
    `# Conversation (oldest first)\n\n${entries.join('\n\n')}`,
    `# Your turn\n\n${turnInstructions(input)}`,
  ].join('\n\n---\n\n');
}

function turnInstructions(input: PromptInput): string {
  const { agent, everyone, triggers, interrupted } = input;
  const lines: string[] = [];
  if (interrupted) {
    lines.push(
      'The CEO interrupted your previous turn with an urgent message. Anything you had already changed is still in your working folder. Handle the urgent message first.',
      '',
    );
  }
  if (triggers.length === 1) {
    const trigger = triggers[0]!;
    lines.push(
      `Message #${trigger.id} from ${authorLabel(trigger, everyone)} is addressed to you. Reply to it now, as ${agent.name}.`,
    );
  } else {
    lines.push(
      'New messages since you started:',
      '',
      ...triggers.map((trigger) => `- #${trigger.id} from ${authorLabel(trigger, everyone)}`),
      '',
      `They are all addressed to you. Answer them together in one reply, as ${agent.name}.`,
    );
  }
  return lines.join('\n');
}
