# Setup guide

This guide gets Symposium running on your machine and walks you through a first project.

## 1. Install the basics

| Tool | Version | Check with |
| --- | --- | --- |
| Node.js | 22 or newer | `node --version` |
| pnpm | 10 or newer | `pnpm --version` |
| git | 2.28 or newer | `git --version` |

Then, from the Symposium folder:

```sh
pnpm install
```

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

For a hosted API, set the base URL (for example `https://api.openai.com/v1`), and in **API key environment variable** enter the variable's *name*, such as `OPENAI_API_KEY`. Export that variable in the shell you start Symposium from. Symposium reads it when calling the API and never stores it.

API agents are text only: they plan and review well, but they cannot edit files or run commands. Use a CLI provider for workers.

### No provider: Mock

The **Mock** provider echoes messages back without any AI. Use it to learn the interface for free.

## 3. Start Symposium

```sh
pnpm dev
```

Open <http://localhost:5173>. The engine runs on port 4400; the UI forwards its requests there.

Stop both with `Ctrl+C`.

## 4. Your first project

1. **Create a group.** Give it a name. Symposium suggests a new folder named after it in `~/symposium-projects`. To use another folder, such as a project you already have, type its absolute path or click **Browse…**. If the folder doesn't exist, Symposium creates it. If it isn't a git repo, Symposium runs `git init` and makes a first commit of the folder's contents. It also adds a `project.md`.
2. **Hire a lead.** In the Team panel click **Hire an agent**, name it (the name is how you @mention it), choose the **Lead** role, a provider and a model.
3. **Hire a scribe** on a small model, so `project.md` stays current.
4. **Tell the lead your goal.** It replies with a plan and asks for approval. It may also propose hires; click **Hire** on the ones you want.
5. **Approve the plan.** The lead assigns tasks by @mentioning workers, who work at the same time. Each card in the Team panel shows Working, Idle or how many messages are queued.
6. **Answer command requests.** When a worker wants to run a command, a card in the chat shows the command and the folder. Click **Allow once**, **Always allow** (the command joins that worker's allow-list) or **Deny**. Only that worker waits for you.
7. **Review diffs.** After a worker's turn, its changes appear in the chat as a diff. Click **Show diff**, then **Merge into main** or **Discard**.

To make merging work, keep your project folder on its base branch (shown in the header). If you have uncommitted changes in the folder that touch the same files, git refuses the merge and Symposium tells you why. Nothing is changed in that case.

[examples/team.md](../examples/team.md) has a ready-made team and first message.

## Steering the team

- **Talk to anyone directly** with `@Name`. A message that mentions nobody goes to the lead.
- **Keep talking.** A new message never stops anyone. If the agent it is for is busy, the message shows "queued for Ada" and Ada reads it, with anything else that arrived, in her next turn.
- **Stop all** (next to "working…") cancels every turn and empties every inbox. **Stop** on an agent's card does the same for that agent only.
- **`/stop`** as a message stops everyone. `/stop @Ada` stops only Ada.
- **`/now @Ada …`** interrupts Ada's current turn and restarts her on that message.
- **Round limit** (**Settings** in the header): how many hand-offs between agents are allowed in one thread before it waits for you. Every message you send starts a new thread. Default 6.
- **Agents at once** (**Settings**): how many agents may work at the same time. Default 3.
- **Lead asks before starting work** (**Settings**): on by default. Switch it off and the lead assigns tasks straight away instead of waiting for you to approve a plan.
- **project.md updates** happen once the whole team has been idle for 30 seconds, not after every reply.
- **Edit** an agent from its card to change its model, role, effort, file access or terminal without firing it. The change applies from its next turn. Giving a lead or reviewer **Edit** file access gives it its own branch and worktree, like a worker.
- **Fire** an agent from the Team panel. Its branch, worktree and memory are kept. Hiring the same name again brings it back with its memory.
- **Terminal commands** (in **Edit**): **Off**, **Ask every time**, **Allow-list** or **Full auto**. The allow-list takes one command per line, and `*` matches anything: `pnpm test`, `npm run *`. Every part of a line like `a && b` must be on the list. `git push`, deleting a branch, `sudo` and anything outside the agent's folder ask in every mode.
- **Activity** on an agent's card lists what it did lately: files read and edited, commands and how they ended.
- **Code tab**: browse the project folder or an agent's worktree, see an agent's uncommitted changes under **Live changes**, and run your own commands under **Terminal**. Your commands run as they would in your own shell. Click **Post to chat** to show the team the result.
- **Open in VS Code** (header) opens the project and every agent's worktree side by side. **VS Code** on an agent's card opens just its worktree, and the Code tab can open the file you are reading. This needs VS Code's `code` command on your PATH.
- **project.md tab**: read or edit the shared project description.
- **Memory**: read or edit what each agent has chosen to remember.
- **Resize the side panel** by dragging the line between it and the chat. Double-click the line to reset it. The Code tab remembers its own width.
- **Light and dark.** Symposium follows your system's setting. The round button at the bottom of the sidebar switches between system, light and dark.

## Where your data is

- `~/.symposium/symposium.db`: groups, agents, messages and the audit log.
- `~/.symposium/agents/<agent id>/memory.md`: each agent's memory.
- `~/.symposium/worktrees/<group id>/<agent id>/`: each worker's git worktree.
- `~/.symposium/workspaces/`: one VS Code workspace file per group.
- `~/symposium-projects/`: where new projects go unless you choose another folder. Set `SYMPOSIUM_PROJECTS_DIR` to change it.
- Your project folder: your code, its git history and `project.md`. Worker branches are named `symposium/<name>`.

Set `SYMPOSIUM_HOME` to keep this data somewhere else.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Command not found: claude" or "agy" | Install the CLI, or give its full path in **CLI path** when hiring. |
| An agent "could not finish" | The message includes the provider's error. Often the CLI is logged out: run it once in a terminal. |
| "Your project folder has X checked out" | Check out the base branch in the project folder, then merge again. |
| "Merging … conflicts" | Nothing was changed. Ask the worker to rework the change, or discard it. |
| "… is inside the git repo at …" | Use the repo's top folder as the project folder. |
| The UI says "Reconnecting…" | The engine stopped. Check the terminal running `pnpm dev`. |
| An agent waits and nothing happens | Look for a command card waiting for your answer. After 10 minutes without one the command is refused. |
| An Antigravity agent says it "stopped without a reply" | You denied its command, and Antigravity ends its turn when that happens. Message it again to carry on. |
| "The `code` command was not found" | In VS Code, open the Command Palette and run "Shell Command: Install 'code' command in PATH". |
