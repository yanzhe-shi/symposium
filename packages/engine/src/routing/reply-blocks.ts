export interface ParsedReply {
  /** The reply with special blocks removed. This is what the chat shows. */
  text: string;
  /** Notes the agent asked to remember, from ```memory blocks. */
  memoryNotes: string[];
  /** Raw JSON from ```hire blocks. Checked by the caller. */
  hireProposals: unknown[];
  /** The text of ```role blocks: roles the agent wrote. Checked by the caller. */
  roleDrafts: string[];
  /** A reviewer's judgement of a change, from a ```verdict block. The last one counts. */
  verdict?: 'approved' | 'changes';
  /** Blocks that could not be read, with the reason. */
  problems: string[];
}

const BLOCK_PATTERN = /```(memory|hire|role|verdict)[^\S\n]*\n([\s\S]*?)```[^\S\n]*(?:\n|$)/g;

/** Pulls ```memory, ```hire, ```role and ```verdict blocks out of an agent's reply. */
export function parseReplyBlocks(reply: string): ParsedReply {
  const memoryNotes: string[] = [];
  const hireProposals: unknown[] = [];
  const roleDrafts: string[] = [];
  const problems: string[] = [];
  let verdict: ParsedReply['verdict'];

  const text = reply.replace(BLOCK_PATTERN, (_match, kind: string, body: string) => {
    const content = body.trim();
    if (kind === 'memory') {
      if (content) memoryNotes.push(content);
    } else if (kind === 'role') {
      if (content) roleDrafts.push(content);
    } else if (kind === 'verdict') {
      if (/^approve/i.test(content)) verdict = 'approved';
      else if (/^(changes|request)/i.test(content)) verdict = 'changes';
    } else {
      try {
        hireProposals.push(JSON.parse(content));
      } catch {
        problems.push('A hire proposal was not valid JSON and was ignored.');
      }
    }
    return '\n';
  });

  return {
    text: text
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      // Small models open with "@CEO:" although the human needs no mention. It reads oddly.
      .replace(/^@(?:CEO|You)(?:[:,]\s*|\s+|$)/i, ''),
    memoryNotes,
    hireProposals,
    roleDrafts,
    ...(verdict ? { verdict } : {}),
    problems,
  };
}
