# Symposium

Symposium is a group chat where you hire AI agents as a team and run a software project as its CEO.

Each group chat is one project folder. You add agents from any provider (Claude Code, Antigravity, or any OpenAI-compatible API such as a local Ollama), give each a name, a model and a role, and they plan, build and review the work together. You approve the hires, the plan and every merge.

> **Status:** working prototype. It runs locally on your machine. Expect rough edges.

## What it does

- **A chat per project.** Create a group linked to a folder: a new one that Symposium suggests, or a project you already have. Symposium makes it a git repo if it isn't one.
- **Hire a team.** A lead plans the work and assigns it, workers build it, a reviewer checks it, and a scribe keeps `project.md` current. A new group can start with such a team already hired.
- **Roles you can write.** Rewrite the built-in job descriptions or add your own roles, such as a designer or a tester. Your lead can write a role too and propose someone for it; you approve.
- **@mentions route the work.** Your message goes to the agents you mention, or to the lead. Agents hand work to each other the same way, and an answer finds its way back to whoever asked.
- **Agents work in parallel.** Every agent has an inbox and works through it one turn at a time, while its teammates do the same. You set how many may work at once (3 by default).
- **Talk at any time.** A new message never stops anyone. A busy agent gets it in its next turn; the chat shows it as "queued for Ada" until then.
- **Round limits.** Each message you send starts a thread. After 6 hand-offs between agents in a thread (you can change this), that thread waits for you. Other threads carry on.
- **Any model, any setup.** Pick each agent's model from the provider's own list or type any name, set its effort, file access and terminal, and change them later without firing anyone.
- **Git isolation.** Every worker edits in its own branch and worktree. Its changes show up in the chat as a diff. Nothing reaches your project until you click **Merge**.
- **See the work as it happens.** Each agent's card shows what it is doing: the files it reads and edits and the commands it runs. The **Code** tab shows the project or any worktree as a file tree, and an agent's changes live, before they are committed.
- **Every change is checked and reviewed before you look at it.** Give the project a check command, such as `npm test`. Symposium runs it in the worker's worktree after each change. Then a reviewer on your team, on another provider than the author when you have one, judges the change. The diff you get shows both: **Check passed**, **Rex approved**.
- **See what it costs.** The **Costs** tab adds up turns, working time and the cost each provider reports, per agent and per task.
- **Terminal commands, with your approval.** A worker asks before it runs a command: **Allow once**, **Always allow** or **Deny**, right in the chat. Only that agent waits. You can give an agent an allow-list or let it run freely in its own worktree. `git push`, `sudo` and anything that reaches outside its folder always ask.
- **A terminal and VS Code for you.** Run your own commands in the project or a worktree from the Code tab, and open the project with every worktree side by side in VS Code.
- **Memory that stays with the agent.** Each agent keeps its own memory file, and every agent reads `project.md` before working. Both belong to Symposium, not to the provider.
- **Teams you can take along.** Save a team with its settings, and its memory if you like, and hire it into your next project in one step. Or send one agent to another group with what it remembers.
- **You stay in charge.** Work starts only when you approve the lead's plan, and stops only when you say so: **Stop all**, **Stop** on one agent, `/stop`, or `/now @Ada …` to interrupt Ada with something urgent. Approve or decline the hires the lead proposes.

## Quick start

You need git. For real work you also need at least one agent provider: the `claude` CLI, the `agy` CLI, or an OpenAI-compatible API (Ollama works). Without one you can still look around with the **Mock** provider.

Install Symposium the way that fits your computer:

| Your computer                     | Install with                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Fedora, RHEL, openSUSE            | the `.rpm` package: `sudo dnf install ./symposium-<version>-1.x86_64.rpm`                             |
| Debian, Ubuntu                    | the `.deb` package: `sudo apt install ./symposium_<version>_amd64.deb`                                |
| Windows                           | [WSL](https://learn.microsoft.com/windows/wsl/install) with Ubuntu, then the `.deb` package inside it |
| macOS, ARM computers, other Linux | from this folder: `scripts/install.sh` (needs Node.js 22 or newer)                                    |

The packages bring their own Node.js, so nothing else has to be installed first. If you are not sure which one is yours, put `install.sh` next to the packages and run `sh install.sh`: it says which package fits and installs it. `scripts/package.sh` builds both packages and that script into `dist/packages`.

Then start it:

```sh
symposium
```

Symposium opens in your browser at <http://localhost:4400>, and it is in your applications menu too. Everything runs on your own machine. `symposium stop` stops it.

Then:

1. Create a group: give it a name. Symposium suggests a new folder in `~/symposium-projects`; type or **Browse…** to use another, such as a project you already have.
2. Keep the suggested **team** (a lead, a worker, a reviewer and a scribe on the agent program found on your computer), or start empty and hire in the **Team** panel.
3. Tell the lead what you want to build. It replies with a plan. Nobody starts until you click **Approve plan**.
4. When a worker asks to run a command, such as the tests, allow or deny it in the chat.
5. Review each diff in the chat and click **Merge** or **Discard**.

See [SETUP.md](SETUP.md) for the full setup guide, and [examples/team.md](examples/team.md) for a sample team and first message.

## How it works

The code owns the rules, the lead owns the decisions, and you own the approvals.

| Who           | Decides                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Engine (code) | Turn order, round limits, who can edit what, which commands may run, every git operation, the audit log |
| Lead agent    | How to split the work, who does each task, when work is good enough                                     |
| You           | Hires, plans, merges, commands, stopping the team                                                       |

**Routing.** A message from you goes to the agents it @mentions, or to the lead if it mentions nobody. An agent's reply goes to the agents it @mentions. A reply that mentions nobody goes back to the teammate who asked for it, so one agent can call another and get the answer. The lead's unaddressed replies are for you. Each agent works through its own inbox one turn at a time, and different agents work in parallel, up to the group's cap. Messages that arrive while an agent is busy reach it together in its next turn. Each agent-to-agent hand-off is one round in the thread your message started, and the round limit stops runaway conversations.

**Context.** The lead sees the whole recent chat. Other agents see `project.md`, their own memory, and only the messages that mention them, plus diffs waiting for review. This keeps cost down as the team grows.

**Roles and access.** Each role starts with the access below. You can change an agent's file access and terminal when you hire it or later with **Edit**; anyone given edit access gets their own worktree, and their changes still wait for your merge.

| Role     | Works in                                           | Can edit files                                                | Terminal         |
| -------- | -------------------------------------------------- | ------------------------------------------------------------- | ---------------- |
| Lead     | The project folder                                 | No, read only                                                 | Off              |
| Worker   | Its own git worktree, on branch `symposium/<name>` | Yes, in its worktree only                                     | Asks before each |
| Reviewer | The project folder                                 | No, read only                                                 | Off              |
| Scribe   | No tools                                           | No. It returns the new `project.md`, and the engine writes it | Never            |

Built-in role descriptions live in [`roles/`](roles). **Roles** in the Team panel lets you rewrite them and add roles of your own. A custom role works like one of the four above, which sets what the engine lets its agents do; the job description is yours. Roles you write or change are kept in `~/.symposium/roles`. Add a specialty when you hire an agent to make it, say, a frontend or database specialist.

**Terminal commands.** Each agent has one of four modes. The engine decides every command; no model does.

| Mode           | What happens                                                                     |
| -------------- | -------------------------------------------------------------------------------- |
| Off            | The agent has no terminal                                                        |
| Ask every time | Every command waits in the chat for **Allow once**, **Always allow** or **Deny** |
| Allow-list     | Commands on the agent's list run at once. Any other command asks                 |
| Full auto      | Commands run without asking, in the agent's own worktree                         |

In every mode these always ask: `git push`, deleting a branch, `sudo`, and anything that reaches outside the agent's folder. A command nobody answers within 10 minutes is refused. An agent that works in the shared project folder (a lead or reviewer given a terminal) can run only what its allow-list covers. Terminals need Claude Code or Antigravity; API agents have none.

**Live view.** While an agent works, its card lists what it does, and every tool call and command goes into the audit log. The **Code** tab shows files read-only, an agent's uncommitted changes as a live diff, and a **Terminal** for your own commands. Agents see your terminal's output only if you click **Post to chat**.

**Memory.** An agent saves notes by adding a ` ```memory ` block to its reply. Symposium removes the block from the chat, appends it to the agent's memory file and includes it in every later turn. You can read and edit any agent's memory from the Team panel. Because the memory is Symposium's, it goes along when you send an agent to another group or save the team with its memory, whatever provider or model the agent runs on.

**Hire proposals.** The lead can propose a teammate with a ` ```hire ` block. It appears in the chat with **Hire** and **Decline** buttons.

## Safety

Agents run on your machine with your logins, so the safe choice is the default.

- Workers can edit files only inside their own worktree. The lead and reviewers can only read.
- An agent runs a terminal command only if the engine allows it. By default only workers have a terminal, and each of their commands waits for you. Some commands always wait for you, whatever the mode: `git push`, deleting a branch, `sudo`, and anything that reaches outside the agent's folder.
- The check command is yours: you type it in **Settings**, and Symposium runs it, never an agent. It runs on the worker's changes without asking each time, so it executes code an agent wrote. Leave it empty if you do not want that.
- These command checks read the command as text. They catch the obvious cases; they are not a sandbox. Give **Full auto** only to agents and projects you would trust with your own terminal.
- Claude Code runs in restricted mode and Antigravity in its sandbox. If an agent still changes a file outside its folder, Symposium says so in the chat.
- The lead's plan waits for your approval, and the engine enforces it: until you click **Approve plan**, the lead's assignments reach nobody.
- Nothing is merged without your click. Symposium never pushes, force-pushes or deletes branches.
- Every message, agent turn, tool call, command and its approval, hire, commit and merge is logged with who did it.
- Symposium calls only each provider's official CLI or API, with your own login or key. It never reads or stores your tokens. For API keys, you give the _name_ of an environment variable, never the key itself.
- The engine listens on `127.0.0.1` only and rejects requests from other websites.

**Do not send confidential code, such as your employer's, to external AI providers through Symposium.** Use a local model if the code must not leave your machine.

## Where things live

| What                              | Where                       | Change with              |
| --------------------------------- | --------------------------- | ------------------------ |
| Database, agent memory, worktrees | `~/.symposium/`             | `SYMPOSIUM_HOME`         |
| Database file                     | `~/.symposium/symposium.db` | `SYMPOSIUM_DB`           |
| Engine port                       | `4400`                      | `SYMPOSIUM_PORT`         |
| New projects, unless you choose   | `~/symposium-projects/`     | `SYMPOSIUM_PROJECTS_DIR` |
| VS Code workspace for each group  | `~/.symposium/workspaces/`  | `SYMPOSIUM_HOME`         |
| Your project and `project.md`     | The folder you chose        |                          |

## Development

```sh
pnpm dev        # engine on :4400 and UI on :5173, with reload
pnpm build      # builds the chat page, which `symposium` then serves on :4400
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
bin/          The `symposium` command
scripts/      install.sh
```

To add a provider, implement `AgentAdapter` in `packages/adapters` and register it in `registry.ts`. The engine never calls a provider directly.

## License

[MIT](LICENSE). You can use, change and share Symposium freely, as long as the copyright notice stays.
