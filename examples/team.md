# Example team

A small team for building a web app. Hire these in the Team panel, in this order.

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

1. Lea replies with a plan and asks you to approve it.
2. You reply "Approved". Lea assigns tasks with @mentions.
3. Ada and Gio each work in their own worktree. Their changes appear as diffs.
4. Rex reviews the diffs and either approves or asks for fixes.
5. Lea tells you when work is ready. You click **Merge into main**.
6. After each round, Sam updates `project.md` with the decisions and status.

If the team stops with "Round limit reached", read where things stand and reply to carry on.

## Starting smaller

For a first try, one lead and one worker are enough:

| Name | Role   | Provider    | Model   |
| ---- | ------ | ----------- | ------- |
| Lea  | Lead   | Claude Code | `haiku` |
| Ada  | Worker | Claude Code | `haiku` |

> Build a single index.html page that says "Hello from Symposium" with a little CSS. It's tiny, so skip plan approval and assign it to Ada right away.
