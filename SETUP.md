# Setup guide

This guide gets Symposium running on your machine and walks you through a first project.

## 1. Install the basics

| Tool    | Version       | Check with       |
| ------- | ------------- | ---------------- |
| Node.js | 22 or newer   | `node --version` |
| git     | 2.28 or newer | `git --version`  |

Then, from the Symposium folder:

```sh
scripts/install.sh
```

This fetches Symposium's packages, builds the chat page and adds a `symposium` command in `~/.local/bin`. On Linux it also adds Symposium to your applications menu. It needs no sudo, and it leaves your data and projects alone. It uses pnpm if you have it and fetches it through Node.js if you don't.

- `scripts/install.sh --system` puts the command in `/usr/local/bin` instead, for every user. It asks for sudo for that step only.
- `scripts/install.sh --uninstall` removes the command and the menu entry.
- Keep the Symposium folder where it is: the command runs Symposium from there. To update, pull the new code and run the script again.

**Windows.** Symposium runs under [WSL](https://learn.microsoft.com/windows/wsl/install) (the Linux system built into Windows). Install WSL, open its terminal, install Node.js and git there, then follow this guide inside it. The page opens in your Windows browser. There is no Windows program (`.exe`) yet: the engine starts the agent programs and git in ways that have only been built and tested on Linux and macOS.

pnpm blocks packages' install scripts unless they are approved. Symposium approves only `better-sqlite3` (the SQLite driver) and `esbuild` (used by Vite and tsx), in `pnpm-workspace.yaml`. If `pnpm install` still warns about ignored build scripts, run `pnpm approve-builds better-sqlite3 esbuild`.

## 2. Set up at least one agent provider

You can use any mix of providers in one team.

### Claude Code

1. Install the `claude` CLI and log in once by running `claude` in a terminal.
2. Check that print mode works: `echo "Say hi" | claude -p --model haiku`.

Models: `sonnet`, `opus`, `haiku`, or any full model name the CLI accepts.

### Antigravity

1. Install the `agy` CLI and log in.
2. Check that print mode works: `agy -p "Say hi" --model gemini-3.8-flash-low`.
3. Run `agy models` to list the models your account can use.

Some versions of `agy -p` print nothing when their output goes to a pipe instead of a terminal. Symposium notices this and runs the command again in a pseudo-terminal, using `python3` or, failing that, the `script` command. Make sure one of them is installed.

An Antigravity agent with a terminal is run through `agy acp` instead, because print mode cannot ask before it runs a command. Nothing extra needs installing.

### Ollama or another OpenAI-compatible API

1. Install [Ollama](https://ollama.com) and pull a model, for example `ollama pull llama3.2`.
2. When hiring, choose **OpenAI-compatible API**, leave the base URL empty (it defaults to `http://localhost:11434/v1`) and enter the model name.

For a hosted API, set the base URL (for example `https://api.openai.com/v1`), and in **API key environment variable** enter the variable's _name_, such as `OPENAI_API_KEY`. Export that variable in the shell you start Symposium from. Symposium reads it when calling the API and never stores it.

API agents are text only: they plan and review well, but they cannot edit files or run commands. Use a CLI provider for workers.

### No provider: Mock

The **Mock** provider echoes messages back without any AI. Use it to learn the interface for free.

## 3. Start Symposium

```sh
symposium
```

This starts Symposium on your machine and opens <http://localhost:4400> in your browser. Nothing is reachable from other computers. Stop it with `Ctrl+C`, or with `symposium stop` from another terminal.

| Command                 | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `symposium`             | Start and open the browser. If it is already running, just open the browser |
| `symposium --no-open`   | Start without opening the browser                                           |
| `symposium --port 5000` | Use another port                                                            |
| `symposium status`      | Say whether it is running                                                   |
| `symposium stop`        | Stop it                                                                     |

Started from the applications menu, Symposium runs in the background: use `symposium stop` to end it.

To work on Symposium's own code, run `pnpm dev` instead. It restarts the engine when a file changes and serves the page at <http://localhost:5173>.

## 4. Your first project

The first screen shows what Symposium found on your computer: git, the agent programs and VS Code, with a hint for anything missing.

1. **Create a group.** Give it a name. Symposium suggests a new folder named after it in `~/symposium-projects`. To use another folder, such as a project you already have, type its absolute path or click **Browse…**. If the folder doesn't exist, Symposium creates it. If it isn't a git repo, Symposium runs `git init` and makes a first commit of the folder's contents. It also adds a `project.md`.
2. **Choose a team.** By default the group starts with a lead (Lea), a worker (Ada), a reviewer (Rex) and a scribe (Sam) on the first agent program found. Pick another provider, or **No team yet** to hire everyone yourself.
3. **Hire more, or change anyone.** In the Team panel click **Hire an agent**, name it (the name is how you @mention it), choose a role, a provider and a model. **Edit** on a card changes an agent later.
4. **Tell the lead your goal.** It replies with a plan and asks for approval. It may also propose hires; click **Hire** on the ones you want.
5. **Approve the plan.** The lead assigns tasks by @mentioning workers, who work at the same time. Each card in the Team panel shows Working, Idle or how many messages are queued.
6. **Answer command requests.** When a worker wants to run a command, a card in the chat shows the command and the folder. Click **Allow once**, **Always allow** (the command joins that worker's allow-list) or **Deny**. Only that worker waits for you.
7. **Review diffs.** After a worker's turn, its changes appear in the chat as a diff. Click **Show diff**, then **Merge into main** or **Discard**.

To make merging work, keep your project folder on its base branch (shown in the header). If you have uncommitted changes in the folder that touch the same files, git refuses the merge and Symposium tells you why. Nothing is changed in that case.

[examples/team.md](examples/team.md) has a ready-made team and first message.

## Steering the team

- **Talk to anyone directly** with `@Name`. A message that mentions nobody goes to the lead.
- **Agents call each other** the same way. When an agent answers without mentioning anyone, the answer goes back to the teammate who asked. The lead's unaddressed replies are for you.
- **Keep talking.** A new message never stops anyone. If the agent it is for is busy, the message shows "queued for Ada" and Ada reads it, with anything else that arrived, in her next turn.
- **Stop all** (next to "working…") cancels every turn and empties every inbox. **Stop** on an agent's card does the same for that agent only.
- **`/stop`** as a message stops everyone. `/stop @Ada` stops only Ada.
- **`/now @Ada …`** interrupts Ada's current turn and restarts her on that message.
- **Round limit** (**Settings** in the header): how many hand-offs between agents are allowed in one thread before it waits for you. Every message you send starts a new thread. Default 6.
- **Agents at once** (**Settings**): how many agents may work at the same time. Default 3.
- **Lead asks before starting work** (**Settings**): on by default. Switch it off and the lead assigns tasks straight away instead of waiting for you to approve a plan.
- **project.md updates** happen once the whole team has been idle for 30 seconds, not after every reply.
- **Edit** an agent from its card to change its model, role, effort, file access or terminal without firing it. The change applies from its next turn. Giving a lead or reviewer **Edit** file access gives it its own branch and worktree, like a worker.
- **Roles** (Team panel): read and rewrite the job description of any role, including the built-in lead, worker, reviewer and scribe, or add your own. A new role "works like" one of those four, which sets what Symposium lets its agents do. An edit applies from each agent's next turn, in every group. **Reset to built-in** undoes your changes to a built-in role.
- **Ask the lead for a role.** Tell your lead what kind of teammate you need. It can write the role and propose a hire for it. The card shows the job description; hiring adds the role, declining adds nothing.
- **Agent files stay out of your git.** Claude Code, Antigravity and similar programs keep files of their own, such as `.claude/`, `CLAUDE.md` or `AGENTS.md`. Symposium has git ignore them in every project, through the repo's `.git/info/exclude`, so they never show up in a diff. Your `.gitignore` is not changed, and a file your project already tracks is still tracked.
- **Fire** an agent from the Team panel. Its branch, worktree and memory are kept. Hiring the same name again brings it back with its memory.
- **Terminal commands** (in **Edit**): **Off**, **Ask every time**, **Allow-list** or **Full auto**. The allow-list takes one command per line, and `*` matches anything: `pnpm test`, `npm run *`. Every part of a line like `a && b` must be on the list. `git push`, deleting a branch, `sudo` and anything outside the agent's folder ask in every mode.
- **Activity** on an agent's card lists what it did lately: files read and edited, commands and how they ended.
- **Code tab**: browse the project folder or an agent's worktree, see an agent's uncommitted changes under **Live changes**, and run your own commands under **Terminal**. Your commands run as they would in your own shell. Click **Post to chat** to show the team the result.
- **Open in VS Code** (header) opens the project and every agent's worktree side by side. **VS Code** on an agent's card opens just its worktree, and the Code tab can open the file you are reading. This needs VS Code's `code` command on your PATH.
- **project.md tab**: read or edit the shared project description.
- **Memory**: read or edit what each agent has chosen to remember.
- **Resize the side panel** by dragging the line between it and the chat. Double-click the line to reset it. The Code tab remembers its own width.
- **Rename or delete a group** under **Settings** in the header. Deleting removes the chat, the team, their memory and their worktrees. Your project folder stays, and so do its git branches, so unmerged work is still on `symposium/<name>`.
- **Light and dark.** Symposium follows your system's setting. The round button at the bottom of the sidebar switches between system, light and dark.

## Where your data is

- `~/.symposium/symposium.db`: groups, agents, messages and the audit log.
- `~/.symposium/agents/<agent id>/memory.md`: each agent's memory.
- `~/.symposium/worktrees/<group id>/<agent id>/`: each worker's git worktree.
- `~/.symposium/workspaces/`: one VS Code workspace file per group.
- `~/.symposium/roles/`: the roles you wrote or changed, one small Markdown file each.
- `~/symposium-projects/`: where new projects go unless you choose another folder. Set `SYMPOSIUM_PROJECTS_DIR` to change it.
- Your project folder: your code, its git history and `project.md`. Worker branches are named `symposium/<name>`.

Set `SYMPOSIUM_HOME` to keep this data somewhere else.

## Troubleshooting

| Problem                                                | What to do                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| "Command not found: claude" or "agy"                   | Install the CLI, or give its full path in **CLI path** when hiring.                                    |
| An agent "could not finish"                            | The message includes the provider's error. Often the CLI is logged out: run it once in a terminal.     |
| "Your project folder has X checked out"                | Check out the base branch in the project folder, then merge again.                                     |
| "Merging … conflicts"                                  | Nothing was changed. Ask the worker to rework the change, or discard it.                               |
| "… is inside the git repo at …"                        | Use the repo's top folder as the project folder.                                                       |
| The UI says "Reconnecting…"                            | The engine stopped. Run `symposium` again.                                                             |
| `symposium: command not found`                         | Add `~/.local/bin` to your PATH, or start it with its full path, which the install script prints.      |
| "The chat page has not been built yet"                 | Run `scripts/install.sh`, or `pnpm install && pnpm build`.                                             |
| "Port 4400 is used by another program"                 | Start with `symposium --port 4401`.                                                                    |
| An agent waits and nothing happens                     | Look for a command card waiting for your answer. After 10 minutes without one the command is refused.  |
| An Antigravity agent says it "stopped without a reply" | You denied its command, and Antigravity ends its turn when that happens. Message it again to carry on. |
| "The `code` command was not found"                     | In VS Code, open the Command Palette and run "Shell Command: Install 'code' command in PATH".          |
