import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentSettings } from '../protocol.js';

/** What happens to a command an agent wants to run. */
export type Verdict = 'allow' | 'ask' | 'deny';

export interface PolicyDecision {
  verdict: Verdict;
  /** Why, in words for the approval card and for the agent. */
  reason: string;
}

/**
 * Splits a command line into the simple commands it runs: `a && b | c; d` gives four.
 * Returns undefined when that cannot be done reliably: an unclosed quote, or a command
 * hidden inside another (`$(...)`, backticks, `<(...)`).
 */
export function splitCommand(command: string): string[] | undefined {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      current += char;
      continue;
    }
    if (char === '\\' && next !== undefined) {
      current += char + next;
      i++;
      continue;
    }
    // These run another command, inside double quotes too.
    if (char === '`' || (char === '$' && next === '(')) return undefined;
    if (quote === '"') {
      if (char === '"') quote = undefined;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if ((char === '<' || char === '>') && next === '(') {
      return undefined;
    } else if (char === ';' || char === '\n' || char === '|' || char === '&') {
      // `&&` and `||` are one separator. `>&` and `&>` are redirections, not separators.
      const redirect = char === '&' && (next === '>' || /[<>]$/.test(current));
      if (redirect) {
        current += char;
        continue;
      }
      parts.push(current);
      current = '';
      if ((char === '|' || char === '&') && next === char) i++;
    } else {
      current += char;
    }
  }
  if (quote) return undefined;
  parts.push(current);
  return parts.map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/\s+/g, ' ')
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`);
}

/**
 * Whether the allow-list covers a command. Every simple command in it must match a pattern in
 * full, so `npm run *` does not cover `npm run build && rm -rf x`. In a pattern `*` stands for
 * anything; everything else is literal.
 */
export function matchesAllowlist(allowlist: readonly string[], command: string): boolean {
  const parts = splitCommand(command);
  if (!parts || parts.length === 0) return false;
  const patterns = allowlist.map(patternToRegExp);
  return parts.every((part) => patterns.some((pattern) => pattern.test(part)));
}

/** The patterns that "Always allow" adds for a command: one for each simple command in it. */
export function allowPatternsFor(command: string): string[] {
  return [...new Set(splitCommand(command) ?? [])];
}

const SAFE_ABSOLUTE = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/**
 * A reason this command needs the human whatever the agent's mode, or undefined. These checks
 * read the command as text. They are a tripwire for the obvious cases, not a sandbox: a
 * determined command can hide what it does.
 */
export function needsHuman(command: string, cwd: string): string | undefined {
  if (/(^|[\s;&|(])(sudo|doas|pkexec|su)(\s|$)/.test(command)) {
    return 'it runs as another user';
  }
  if (/\bgit\b[^;&|\n]*\bpush\b/.test(command)) return 'it pushes to a git remote';
  if (/\bgit\b[^;&|\n]*\bbranch\b[^;&|\n]*\s(-[a-zA-Z]*[dD][a-zA-Z]*|--delete)\b/.test(command)) {
    return 'it deletes a git branch';
  }
  if (/\bgit\b[^;&|\n]*\s(-C|--git-dir|--work-tree)\b/.test(command)) {
    return 'it runs git on another folder';
  }
  if (/\bgit\b[^;&|\n]*\bworktree\b[^;&|\n]*\b(remove|prune|move)\b/.test(command)) {
    return "it changes git's worktrees";
  }

  if (/(^|[\s=<>"'(:])~/.test(command) || /\$\{?HOME\b/.test(command)) {
    return 'it reaches into your home folder';
  }
  if (/(^|[\s=<>"'(/])\.\.($|[\s/"');|&])/.test(command)) {
    return 'it leaves its folder with ".."';
  }
  for (const match of command.matchAll(/(?:^|[\s=<>"'(])(\/[^\s"'<>|;&)]*)/g)) {
    const path = match[1]!;
    if (SAFE_ABSOLUTE.has(path)) continue;
    const inside = relative(resolve(cwd), resolve(path));
    if (inside.startsWith('..') || isAbsolute(inside)) {
      return `it names a path outside its folder (${path})`;
    }
  }
  return undefined;
}

/**
 * Decides one command. This is the rule; no model is asked.
 *
 * - `off`: no commands.
 * - Anything `needsHuman` flags waits for the human, in every other mode.
 * - An agent without edit access works in the project folder itself, not in a worktree of its
 *   own, so it may run only what its allow-list covers.
 * - `ask`: the human decides each command. `allowlist`: commands the list covers run, the rest
 *   wait for the human. `auto`: commands run.
 */
export function decide(settings: AgentSettings, command: string, cwd: string): PolicyDecision {
  if (settings.commands === 'off') {
    return { verdict: 'deny', reason: 'Terminal commands are switched off for you.' };
  }
  if (command.trim() === '') return { verdict: 'deny', reason: 'The command was empty.' };

  const listed = matchesAllowlist(settings.allowlist, command);
  if (settings.files !== 'edit' && !listed) {
    return {
      verdict: 'deny',
      reason:
        'You work in the shared project folder, so you may only run commands on your allow-list.',
    };
  }
  const risk = needsHuman(command, cwd);
  if (risk) return { verdict: 'ask', reason: `Always asks: ${risk}.` };

  if (settings.commands === 'auto') return { verdict: 'allow', reason: 'Commands run freely.' };
  if (settings.commands === 'allowlist' && listed) {
    return { verdict: 'allow', reason: 'On the allow-list.' };
  }
  return {
    verdict: 'ask',
    reason: settings.commands === 'ask' ? 'Asks before every command.' : 'Not on the allow-list.',
  };
}
