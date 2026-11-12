# Symposium

Symposium is a group chat where you hire AI agents as a team and run a software project as its CEO.

Each group chat is one project folder. You add agents from any provider (Claude Code, Antigravity, or any OpenAI-compatible API such as a local Ollama), give each a name, a model and a role, and they plan, build and review the work together. You approve the hires, the plan and every merge.

> **Status:** working prototype (version 1). It runs locally on your machine. Expect rough edges.

## What it does

- **A chat per project.** Create a group linked to a folder. Symposium makes it a git repo if it isn't one.
- **Hire a team.** A lead plans the work and assigns it, workers build it, a reviewer checks it, and a scribe keeps `project.md` current.
- **@mentions route the work.** Your message goes to the agents you mention, or to the lead. Agents hand work to each other the same way.
- **Agents work in parallel.** Every agent has an inbox and works through it one turn at a time, while its teammates do the same. You set how many may work at once (3 by default).
- **Talk at any time.** A new message never stops anyone. A busy agent gets it in its next turn; the chat shows it as "queued for Ada" until then.
- **Round limits.** Each message you send starts a thread. After 6 hand-offs between agents in a thread (you can change this), that thread waits for you. Other threads carry on.
- **Git isolation.** Every worker edits in its own branch and worktree. Its changes show up in the chat as a diff. Nothing reaches your project until you click **Merge**.
- **Memory that stays with the agent.** Each agent keeps its own memory file, and every agent reads `project.md` before working. Both belong to Symposium, not to the provider.
- **You stay in charge.** Work stops only when you say so: **Stop all**, **Stop** on one agent, `/stop`, or `/now @Ada …` to interrupt Ada with something urgent. Approve or decline the hires the lead proposes.

## Quick start

You need Node.js 22 or newer, [pnpm](https://pnpm.io), git, and at least one agent provider: the `claude` CLI, the `agy` CLI, or an OpenAI-compatible API (Ollama works). To try it without any of these, hire agents with the **Mock** provider.

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:5173>:

1. Create a group: a name and an absolute folder path, for example `/home/you/projects/sock-shop`.
2. In the **Team** panel, hire a **lead** (for example Claude Code, `sonnet`), one or two **workers** and a **scribe** on a small model (`haiku`).
3. Tell the lead what you want to build. It replies with a plan; approve it, and the work begins.
4. Review each diff in the chat and click **Merge** or **Discard**.

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide, and [examples/team.md](examples/team.md) for a sample team and first message.

## How it works

The code owns the rules, the lead owns the decisions, and you own the approvals.

| Who           | Decides                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| Engine (code) | Turn order, round limits, who can edit what, every git operation, the audit log |
| Lead agent    | How to split the work, who does each task, when work is good enough             |
| You           | Hires, plans, merges, stopping the team                                         |

**Routing.** A message from you goes to the agents it @mentions, or to the lead if it mentions nobody. An agent's reply goes to the agents it @mentions. Each agent works through its own inbox one turn at a time, and different agents work in parallel, up to the group's cap. Messages that arrive while an agent is busy reach it together in its next turn. Each agent-to-agent hand-off is one round in the thread your message started, and the round limit stops runaway conversations.

**Context.** The lead sees the whole recent chat. Other agents see `project.md`, their own memory, and only the messages that mention them, plus diffs waiting for review. This keeps cost down as the team grows.

**Roles and access.**

| Role     | Works in                                           | Can edit files                                                |
| -------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Lead     | The project folder                                 | No, read only                                                 |
| Worker   | Its own git worktree, on branch `symposium/<name>` | Yes, in its worktree only                                     |
| Reviewer | The project folder                                 | No, read only                                                 |
| Scribe   | No tools                                           | No. It returns the new `project.md`, and the engine writes it |

Built-in role descriptions live in [`roles/`](roles). Add a specialty when you hire an agent to make it, say, a frontend or database specialist.

**Memory.** An agent saves notes by adding a ` ```memory ` block to its reply. Symposium removes the block from the chat, appends it to the agent's memory file and includes it in every later turn. You can read and edit any agent's memory from the Team panel.

**Hire proposals.** The lead can propose a teammate with a ` ```hire ` block. It appears in the chat with **Hire** and **Decline** buttons.

## Safety

Agents run on your machine with your logins, so the safe choice is the default.

- Workers can edit files only inside their own worktree. The lead and reviewers can only read.
- No agent can run shell commands. Claude Code runs in restricted mode with only file tools. Antigravity runs in its sandbox.
- Nothing is merged without your click. Symposium never pushes, force-pushes or deletes branches.
- Every message, agent turn, hire, commit and merge is logged with who did it.
- Symposium calls only each provider's official CLI or API, with your own login or key. It never reads or stores your tokens. For API keys, you give the _name_ of an environment variable, never the key itself.
- The engine listens on `127.0.0.1` only and rejects requests from other websites.

**Do not send confidential code, such as your employer's, to external AI providers through Symposium.** Use a local model if the code must not leave your machine.

## Where things live

| What                              | Where                       | Change with      |
| --------------------------------- | --------------------------- | ---------------- |
| Database, agent memory, worktrees | `~/.symposium/`             | `SYMPOSIUM_HOME` |
| Database file                     | `~/.symposium/symposium.db` | `SYMPOSIUM_DB`   |
| Engine port                       | `4400`                      | `SYMPOSIUM_PORT` |
| Your project and `project.md`     | The folder you chose        |                  |

## Development

```sh
pnpm dev        # engine on :4400 and UI on :5173, with reload
pnpm test       # all tests (Vitest). They use the mock adapter and never call a real provider
pnpm lint
pnpm typecheck
pnpm format     # Prettier
```

```
packages/
  engine/     Fastify server, SQLite storage, routing, git manager, scribe
  adapters/   The AgentAdapter interface and one adapter per provider
  ui/         React chat app (Vite)
roles/        Built-in role descriptions
docs/         Plan and setup guide
```

To add a provider, implement `AgentAdapter` in `packages/adapters` and register it in `registry.ts`. The engine never calls a provider directly.

## License

Not chosen yet. Until a license is added, all rights are reserved.
