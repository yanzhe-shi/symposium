import type { AgentAccess } from '@symposium/adapters';
import { describeCheck } from '../checks.js';
import type { Agent, AgentSettings, Group, Message, ReviewResult, RoleInfo } from '../protocol.js';
import { applyPlanApproval, roleAccess } from '../roles.js';

/** Upper bound on the conversation part of a prompt, in characters. Oldest messages go first. */
export const MAX_TRANSCRIPT_CHARS = 60_000;
/** How many recent messages the lead sees. */
export const LEAD_HISTORY = 60;
/** How many relevant messages other agents see. */
export const MEMBER_HISTORY = 25;
const MAX_DIFF_IN_PROMPT = 30_000;
const MAX_CHECK_OUTPUT_IN_PROMPT = 4000;

export interface PromptInput {
  group: Group;
  agent: Agent;
  /** Active team, including the agent itself. */
  team: Agent[];
  /** All agents that ever wrote in the group, to name authors of old messages. */
  everyone: Agent[];
  roleText: string;
  /** Every role there is, to name teammates' custom roles and to tell the lead what it can hire. */
  roles?: readonly RoleInfo[];
  access: AgentAccess;
  /** The agent's terminal: its command mode and allow-list. Left out, it has none. */
  terminal?: Pick<AgentSettings, 'commands' | 'allowlist'>;
  /** Whether the agent's process runs in Symposium's sandbox. */
  sandboxed?: boolean;
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
  /**
   * Set when the engine itself asks a reviewer to judge a worker's change. The triggers then
   * are what the worker was asked, its report and the diff.
   */
  review?: { worker: Agent; card: Message };
}

/** An agent's role in words: "lead" for a built-in role, "Designer" for a custom one. */
function roleName(agent: Agent, roles: readonly RoleInfo[] = []): string {
  const role = roles.find((candidate) => candidate.id === agent.roleId);
  return role && !role.builtIn ? role.title : agent.role;
}

function describeAgent(agent: Agent, roles?: readonly RoleInfo[]): string {
  const specialty = agent.instructions ? `: ${agent.instructions.split('\n')[0]}` : '';
  return `${agent.name}: ${roleName(agent, roles)}${specialty}`;
}

/** What the agent is told about its terminal. The engine enforces all of it. */
function terminalRules(terminal: PromptInput['terminal'], access: AgentAccess): string[] {
  if (!terminal || terminal.commands === 'off') {
    return [
      access === 'edit'
        ? '- You cannot run shell commands, install packages or use git.'
        : '- You cannot run shell commands.',
    ];
  }
  const listed = terminal.allowlist.map((pattern) => `\`${pattern}\``).join(', ');
  const how =
    access !== 'edit'
      ? `You can run only these terminal commands, in the project folder: ${listed || '(none yet)'}.`
      : terminal.commands === 'auto'
        ? 'You can run terminal commands in your folder. A few always wait for the CEO: `git push`, `sudo`, deleting branches, and anything that reaches outside your folder.'
        : terminal.commands === 'allowlist'
          ? `You can run terminal commands in your folder. These run at once: ${listed || '(none yet)'}. The CEO approves any other command first, which can take a while.`
          : 'You can run terminal commands in your folder, but the CEO approves each one first, which can take a while. Run only what the task needs.';
  return [
    `- ${how}`,
    '- If a command is refused, do not retry it or try another way around. Carry on without it and say what you could not check.',
    '- Leave git to Symposium: do not commit, push or switch branches.',
  ];
}

/** What a sandboxed agent is told, so that it does not fight what the kernel refuses. */
function sandboxRules(access: AgentAccess): string[] {
  return [
    access === 'edit'
      ? '- You work in a sandbox. Your tools and commands can change files only in your folder; package managers can still fill their caches. Anywhere else a write fails with "Read-only file system", and some folders outside the project look empty. That is intended: do not look for a way around it. Say what you could not do.'
      : '- You work in a sandbox. Nothing you run can change a file, and some folders outside the project look empty. That is intended: do not look for a way around it.',
    '- `/tmp` is yours alone and is emptied after every turn.',
  ];
}

function accessRules(
  access: AgentAccess,
  branch: string | undefined,
  terminal: PromptInput['terminal'],
  checkCommand: string,
  sandboxed: boolean,
): string {
  const commands = [
    ...terminalRules(terminal, access),
    ...(sandboxed && access !== 'none' ? sandboxRules(access) : []),
  ];
  switch (access) {
    case 'edit':
      return [
        `- You work in your own git worktree${branch ? ` on branch \`${branch}\`` : ''}. Edit files there.`,
        '- After your turn Symposium commits your changes and shows the CEO a diff. Nothing reaches the main project until the CEO merges it.',
        ...(checkCommand
          ? [
              `- Symposium then runs the project's check, \`${checkCommand}\`, on your changes and puts the result on the diff. You need not run it yourself, and nobody else has to.`,
            ]
          : []),
        ...commands,
      ].join('\n');
    case 'read':
      return [
        '- You can read files in the project folder, but you cannot change them.',
        ...commands,
      ].join('\n');
    case 'none':
      return '- You have no tools. Work only from the text you are given.';
  }
}

/** How the lead proposes hires, with the roles there are to hire into. */
function hireHelp(roles: readonly RoleInfo[]): string {
  const hireable = roles.filter((role) => role.kind !== 'lead');
  const list = (hireable.length > 0 ? hireable : [])
    .map((role) => `  - ${role.builtIn ? role.kind : role.title}: ${role.summary}`)
    .join('\n');
  return `## Proposing hires

To propose a new teammate, add one block per person:

\`\`\`hire
{"name": "Max", "role": "worker", "provider": "claude-code", "model": "sonnet", "instructions": "Backend specialist: APIs and the database"}
\`\`\`

- role: one of these, by name. There is only one lead: you.
${list || '  - worker, reviewer or scribe'}
- provider: claude-code, antigravity, openai-compatible or mock. Prefer the providers your current team uses.
- The CEO approves or rejects each proposal. Don't assign work to someone until they have joined.

If no role fits the job, write a new role and hire into it in the same reply:

\`\`\`role
name: Designer
kind: worker
summary: Designs the screens and writes the CSS.

You design the product's screens. (The job description: how this teammate works and what "done" means for them.)
\`\`\`

- kind is how Symposium treats the role: \`worker\` edits files in its own git worktree, \`reviewer\` reads the project but does not change it.
- Use the role's name as the "role" of the hire. The role is added when the CEO approves that hire.`;
}

const START_NOW = `## Start right away

The CEO has turned off plan approval. When you get a goal, give a short plan and assign the first tasks in the same reply. Don't wait for a go-ahead: the CEO can redirect or stop the team at any time.`;

const PLAN_APPROVAL = `## Plan approval

The CEO approves a plan before work starts, and Symposium enforces it. When you @mention teammates to hand out work, your message is held back and the CEO gets a card to approve or decline it.

- So give the plan and the first assignments in one message. The CEO approves both with one click, and the message then reaches the teammates as you wrote it.
- Once a plan is approved, your later hand-offs in the same conversation go straight through.
- A message the CEO starts with \`/go\` is approved ahead: your hand-offs for it go straight through, with no card.
- If the CEO declines, nothing was started. Wait for what they want changed, then send a new plan with its assignments.
- Each plan card in the conversation shows its status: pending, approved or declined.`;

/** What the lead is told about the checks and reviews the engine does by itself. */
function qualityHelp(group: Group, team: Agent[]): string | undefined {
  const lines: string[] = [];
  if (group.checkCommand) {
    lines.push(
      `- Symposium runs the project's check, \`${group.checkCommand}\`, on every change, in its author's worktree. The result is on the diff. Trust it: nobody needs to run it again.`,
    );
  }
  if (group.autoReview && team.some((member) => member.role === 'reviewer')) {
    lines.push(
      "- Symposium has a reviewer judge every change, unless it fails the check. The review is in the chat and its verdict is on the diff. Don't ask for a review of a change yourself.",
    );
  }
  if (lines.length === 0) return undefined;
  return [
    '## Checks and reviews',
    '',
    "Symposium does these by itself, before a teammate's report reaches you:",
    '',
    ...lines,
    '- If the check failed or changes are needed, send the author back with what to fix. Otherwise tell the CEO it is ready to merge.',
  ].join('\n');
}

export function buildSystemPrompt(input: PromptInput): string {
  const { group, agent, team, roleText, roles, access, branch, terminal } = input;
  const roster = team
    .map((member) => `- ${describeAgent(member, roles)}${member.id === agent.id ? ' (you)' : ''}`)
    .join('\n');

  const sections = [
    `You are ${agent.name}, the ${roleName(agent, roles)} of a software team that works together in a group chat called "${group.name}". The human running the project is the CEO: they approve plans, hires and merges.`,
    applyPlanApproval(roleText, group.leadAsksFirst),
  ];
  if (agent.instructions) sections.push(`## Your specialty\n\n${agent.instructions}`);
  sections.push(
    `## The team\n\n${roster}\n- The CEO (human)`,
    [
      '## How the chat works',
      '',
      '- To give a teammate work or ask them something, @mention them by name, like "@Ada please add the login form". Every mention gives that teammate a turn, so mention someone only when you need them to act.',
      agent.role === 'lead'
        ? '- If you mention nobody, your reply is for the CEO and nobody else is asked to act. To answer a teammate, @mention them.'
        : '- If you mention nobody, your reply goes back to whoever asked you: the teammate whose message you are answering, or the CEO. You never need to mention the one who asked.',
      '- Never mention yourself. Never write "@CEO": the CEO reads every message, so just say what you have to say.',
      '- Teammates work at the same time, and the CEO can write at any moment without stopping anyone. Messages that arrive while you work reach you together in your next turn: answer them all in one reply.',
      '- Keep replies short and concrete. No greetings or sign-offs.',
      accessRules(access, branch, terminal, group.checkCommand, input.sandboxed === true),
      // The role text describes the role's usual access. Say so when this agent's differs.
      ...(access === roleAccess(agent.role)
        ? []
        : [
            '- The CEO set this file access for you. It replaces anything your role description says about reading or editing files.',
          ]),
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
    sections.push(group.leadAsksFirst ? PLAN_APPROVAL : START_NOW);
    const quality = qualityHelp(group, team);
    if (quality) sections.push(quality);
    sections.push(hireHelp(roles ?? []));
  }
  return sections.join('\n\n');
}

export function authorLabel(message: Message, everyone: Agent[]): string {
  if (message.authorKind === 'human') return 'CEO';
  if (message.authorKind === 'system') return 'Symposium';
  const author = everyone.find((agent) => agent.id === message.authorAgentId);
  return author ? `${author.name} (${author.role})` : 'Former agent';
}

/** A review's outcome in a few words, for a prompt. */
export function describeReview(review: ReviewResult): string {
  const where = review.messageId === undefined ? '' : ` (message #${review.messageId})`;
  switch (review.status) {
    case 'running':
      return 'in progress';
    case 'approved':
      return `approved${where}`;
    case 'changes':
      return `changes needed${where}`;
    case 'unclear':
      return `no clear verdict${where}`;
    case 'failed':
      return 'could not be done';
    case 'stopped':
      return 'was stopped';
  }
}

/** One message as it appears in a prompt. Pending diffs are shown in full unless `fullDiffs` is off. */
export function formatMessage(message: Message, everyone: Agent[], fullDiffs = true): string {
  let body = message.body;
  if (message.meta?.type === 'diff') {
    const { stat, diff, truncated, status } = message.meta;
    body = `${message.body}\nStatus: ${status}\n${stat}`;
    const { check, review } = message.meta;
    if (review) {
      const reviewer =
        everyone.find((agent) => agent.id === review.reviewerId)?.name ?? 'a reviewer';
      body += `\nReview by ${reviewer}: ${describeReview(review)}`;
    }
    if (check && status === 'pending') {
      body += `\nCheck \`${check.command}\`: ${describeCheck(check)}`;
      if (check.status !== 'passed' && check.status !== 'running' && check.output.trim()) {
        body += `\n\`\`\`\n${check.output.slice(-MAX_CHECK_OUTPUT_IN_PROMPT).trim()}\n\`\`\``;
      }
    }
    // Pending diffs are shown in full so the lead and reviewers can judge them.
    if (fullDiffs && status === 'pending') {
      const shown = diff.length > MAX_DIFF_IN_PROMPT ? diff.slice(0, MAX_DIFF_IN_PROMPT) : diff;
      const cut = truncated || shown.length < diff.length ? '\n[diff truncated]' : '';
      body += `\n\`\`\`diff\n${shown}\n\`\`\`${cut}`;
    }
  }
  if (message.meta?.type === 'plan') {
    body = `${message.body}\nPlan in message #${message.meta.replyMessageId}. Status: ${message.meta.status}`;
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
  const { agent, everyone, triggers, interrupted, review } = input;
  if (review) {
    const { worker, card } = review;
    return [
      `Symposium asks you to review ${worker.name}'s change in message #${card.id}, before the CEO decides about it. The messages before it say what was asked and what ${worker.name} reports.`,
      ...(input.access === 'none'
        ? []
        : [
            `The folder you are in is ${worker.name}'s worktree, so the files you read are the changed ones.`,
          ]),
      '',
      '- Judge whether the change does what was asked and is safe to merge. Name only real problems, each with the file and what to do about it. Leave out matters of taste.',
      '- Mention nobody. Symposium puts your verdict on the diff, and the lead or the CEO decides what happens next.',
      `- Reply now, as ${agent.name}, and end with your verdict in a block, \`approve\` or \`changes\`:`,
      '',
      '```verdict',
      'approve',
      '```',
    ].join('\n');
  }
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
