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

### Ollama or another OpenAI-compatible API

1. Install [Ollama](https://ollama.com) and pull a model, for example `ollama pull llama3.2`.
2. When hiring, choose **OpenAI-compatible API**, leave the base URL empty (it defaults to `http://localhost:11434/v1`) and enter the model name.

For a hosted API, set the base URL (for example `https://api.openai.com/v1`), and in **API key environment variable** enter the variable's *name*, such as `OPENAI_API_KEY`. Export that variable in the shell you start Symposium from. Symposium reads it when calling the API and never stores it.

API agents are text only: they plan and review well, but they cannot edit files. Use a CLI provider for workers.

### No provider: Mock

The **Mock** provider echoes messages back without any AI. Use it to learn the interface for free.

## 3. Start Symposium

```sh
pnpm dev
```

Open <http://localhost:5173>. The engine runs on port 4400; the UI forwards its requests there.

Stop both with `Ctrl+C`.

## 4. Your first project

1. **Create a group.** Give it a name and an absolute path. If the folder doesn't exist, Symposium creates it. If it isn't a git repo, Symposium runs `git init` and makes a first commit of the folder's contents. It also adds a `project.md`.
2. **Hire a lead.** In the Team panel click **Hire an agent**, name it (the name is how you @mention it), choose the **Lead** role, a provider and a model.
3. **Hire a scribe** on a small model, so `project.md` stays current.
4. **Tell the lead your goal.** It replies with a plan and asks for approval. It may also propose hires; click **Hire** on the ones you want.
5. **Approve the plan.** The lead assigns tasks by @mentioning workers. Watch the activity dots in the Team panel.
6. **Review diffs.** After a worker's turn, its changes appear in the chat as a diff. Click **Show diff**, then **Merge into main** or **Discard**.

To make merging work, keep your project folder on its base branch (shown in the header). If you have uncommitted changes in the folder that touch the same files, git refuses the merge and Symposium tells you why. Nothing is changed in that case.

[examples/team.md](../examples/team.md) has a ready-made team and first message.

## Steering the team

- **Talk to anyone directly** with `@Name`. A message that mentions nobody goes to the lead.
- **Stop** the team with the Stop button next to "working…". Sending a new message also stops the current work and starts again from your message.
- **Round limit** (header): how many hand-offs between agents are allowed before the team waits for you. Default 3.
- **Fire** an agent from the Team panel. Its branch, worktree and memory are kept. Hiring the same name again brings it back with its memory.
- **project.md tab**: read or edit the shared project description.
- **Memory**: read or edit what each agent has chosen to remember.

## Where your data is

- `~/.symposium/symposium.db`: groups, agents, messages and the audit log.
- `~/.symposium/agents/<agent id>/memory.md`: each agent's memory.
- `~/.symposium/worktrees/<group id>/<agent id>/`: each worker's git worktree.
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
