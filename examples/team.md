# Example team

A small team for building a web app. A new group can start with Lea, Ada, Rex and Sam already hired (the **Team** choice when you create it); add Gio in the Team panel. Or hire all five yourself, in this order.

| Name | Role     | Provider    | Model                     | Specialty                              |
| ---- | -------- | ----------- | ------------------------- | -------------------------------------- |
| Lea  | Lead     | Claude Code | `sonnet`                  |                                        |
| Ada  | Worker   | Claude Code | `sonnet`                  | Frontend: React, CSS and accessibility |
| Gio  | Worker   | Antigravity | `gemini-3.8-flash-medium` | Backend: APIs, data and validation     |
| Rex  | Reviewer | Claude Code | `sonnet`                  | Catches bugs and missing edge cases    |
| Sam  | Scribe   | Claude Code | `haiku`                   |                                        |

No Antigravity? Hire Gio on Claude Code as well. Want to spend nothing while you learn the interface? Hire everyone on **Mock**.

## First message

Send this without mentioning anyone, so it goes to the lead:

> We're building a small to-do app: a single page where I can add tasks, tick them off and delete them, saved in the browser's local storage. Plain HTML, CSS and JavaScript, no build step. Please propose a plan and split it between Ada and Gio. Ask Rex to review each change before you tell me it's ready.

## What to expect

1. Lea replies with a plan and the tasks for Ada and Gio. Symposium holds the message back and shows a card under it.
2. You click **Approve plan**. Ada and Gio get their tasks.
3. Ada and Gio work at the same time, each in their own worktree. Their cards show what they are doing, and the **Code** tab shows their changes live. You can keep messaging anyone while they work.
4. If a worker wants to run a command, a card asks you first. Click **Allow once**, **Always allow** or **Deny**.
5. Their changes appear in the chat as diffs.
6. Rex reviews the diffs and either approves or asks for fixes.
7. Lea tells you when work is ready. You click **Merge into main**.
8. Once the team has been idle for 30 seconds, Sam updates `project.md` with the decisions and status.

If a thread stops with "Round limit reached", read where things stand and reply to carry on.

To skip step 2, switch off **Approve the lead's plan first** under **Settings** in the header: Lea's tasks then reach the workers at once.

To be asked less often, click **Edit** on a worker and set **Terminal commands** to **Allow-list** with the commands you trust, such as `npm test`.

## Starting smaller

For a first try, one lead and one worker are enough:

| Name | Role   | Provider    | Model   |
| ---- | ------ | ----------- | ------- |
| Lea  | Lead   | Claude Code | `haiku` |
| Ada  | Worker | Claude Code | `haiku` |

> Build a single index.html page that says "Hello from Symposium" with a little CSS. It's tiny, so skip plan approval and assign it to Ada right away.
