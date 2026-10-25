# dsh-notification

> Desktop, browser + webhook notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> on **macOS · Linux · Windows**: know when your agent **finishes its whole task** — subagent
> trees included, background jobs too if you opt in — **hits an error**, is **waiting for your
> approval**, or asks you a **question**.

Long agent turns are the norm: you kick off a task, switch away, and come back to find the agent
finished five minutes ago — or worse, stuck on an approval prompt the whole time. `dsh-notification`
listens to the harness's own lifecycle events and pings you when your attention is actually needed,
not once per intermediate step.

## What it does

| Event | Trigger | Default |
|---|---|---|
| **Agent finished** | the main agent, its descendant subagent runs, and (with `waitForBackgroundJobs`) its background jobs have all settled, and the task ran ≥ `minTurnDurationMs` | on |
| **Agent error** | `agent/error` for the main agent (steps/turns of subagents are filtered) | on |
| **Approval needed** | `approval/request` waterfall for the main agent (observe-only; always delegates with `next()`) | on |
| **Question asked** | `user-questions/request` waterfall for the main agent (observe-only; never answers) | on |

Each notification's summary carries the session title — `[Agent Finished] 面板设置优化实施流程` — so
several running sessions stay distinguishable at a glance.

Only the **main agent** is reported. Subagent activity never produces its own notification; with
`waitForSubagents` (default on) it delays the main completion until the whole delegation tree has
settled. **Background jobs** (`run_in_background`) are a separate, opt-in wait: with
`waitForBackgroundJobs: true` a job that is still running keeps the completion pending until its
`settled` edge, while with the default `false` the main agent's idle edge notifies right away and
later job activity never renotifies. The completion body is the last main-agent reply, flattened and
truncated to `maxBodyChars` characters — the notifier makes no extra model call.

Each event can go to:
- **Desktop notification** — zero dependencies: `osascript` (macOS), `notify-send` (Linux),
  PowerShell toast (Windows).
- **Webhook** — a JSON `POST` with a Slack-compatible `text` field, so a Slack/Discord/generic
  incoming-webhook URL works out of the box.

### Why completions are delayed

`agent/status → idle` alone fires between steps of one task: a delegating agent goes idle while its
children still work, and a `run_in_background` job has already returned its id while it keeps
running. The notifier therefore tracks up to two ledgers per root session — `subagent/start` …
`subagent/end` pairs and, with `waitForBackgroundJobs`, `ctx.jobs` `registered` … `settled` edges —
then requires the tracked work to finish and the tree to stay idle for `settleDelayMs`. A teardown
settlement (`cause: 'teardown'`) has no reader left and does not release a completion. A task group
notifies **once**; a new turn cancels a pending completion instead of queueing a second ping.

Both waits are independent switches:

| `waitForSubagents` | `waitForBackgroundJobs` | Completion fires when |
|---|---|---|
| `true` (default) | `false` (default) | the last descendant subagent run ends |
| `true` | `true` | both the runs and the jobs have settled |
| `false` | `false` | the main agent first goes idle |
| `false` | `true` | the jobs have settled (running subagents do not hold it) |

Set `waitForSubagents: false` to ignore delegation, and `waitForBackgroundJobs: false` (the
default) to ping as soon as the main turn returns even when a background job is still running.

## Install

```sh
dsh plugin --profile web add dsh-notification
# or straight from git:
dsh plugin --profile web add github:nishit130/dsh-notification
```

The package ships plain ESM JavaScript — no build step, so a git install needs no
`allowBuilds` entry.

## Where notifications appear

Three channels, three places:

| Channel | Fires on | Best for |
|---|---|---|
| Desktop (`desktop`) | the machine **running the `dsh` server** | `dsh web` on your own machine |
| Browser (`browser`) | the machine **viewing the Web UI** | a remote server, or any Web UI use |
| Webhook (`webhookUrl`) | wherever the URL points | phones, Slack, unattended runs |

Browser notifications use the standard `Notification` API: the Web UI asks for permission on
your first click or keypress, and by default popups appear **only while the tab is hidden** —
a visible tab already has your attention.

Both halves apply the same completion rule: the browser half reads the client session list, walks
each running row's `parentId` chain, and defers while a descendant subagent of that session is still
running — reporting once the tree settles. The browser half has no access to the last main reply
(the host keeps that), so its body is a duration summary rather than the reply text.

> **Limit of the browser channel's configuration.** The Host ships the client half through the Web
> boot manifest, whose entry rows carry only `id`/`url`/`rev`/`inject`/`immediately`/`external` —
> there is no per-plugin config channel. The browser half therefore always runs with its built-in
> defaults: `browser` and `browserOnlyWhenHidden` are read but resolve to `true`, and
> `minTurnDurationMs` is the default. Use `desktop: false` on the Host to silence the host popup,
> and the browser's own site-permission prompt to silence the Web UI popup.

Running everything on one machine with the tab hidden? You'd get both a desktop and a browser
popup for the same event — turn off the host channel with `desktop: false` if the pair bothers you.

## Configuration

Override the row in your profile's `cordis.patch.yml` (or via the Settings UI):

```yaml
- insert:
    - id: notify
      name: dsh-notification
      config:
        minTurnDurationMs: 10000        # only notify for turns ≥ 10s
        waitForSubagents: true          # wait for descendant subagent runs
        waitForBackgroundJobs: false    # do not wait for background jobs
        settleDelayMs: 1000
        webhookUrl: 'https://hooks.slack.com/services/XXX/YYY/ZZZ'
        notifyOnApproval: true
        desktop: true
        title: 'DSH'
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `notifyOnIdle` | boolean | `true` | Notify when the main agent and its subagent tree finish |
| `notifyOnError` | boolean | `true` | Notify on main-agent `agent/error` |
| `notifyOnApproval` | boolean | `true` | Notify when the main agent awaits tool approval |
| `notifyOnQuestion` | boolean | `true` | Notify when the main agent asks you a question |
| `minTurnDurationMs` | number | `5000` | Skip tasks shorter than this, background subagent time included |
| `maxBodyChars` | number | `200` | Maximum Unicode characters in a notification body |
| `waitForSubagents` | boolean | `true` | Hold the completion until descendant subagent runs settle |
| `waitForBackgroundJobs` | boolean | `false` | Hold the completion until background jobs settle; off means job activity never delays or resets it |
| `settleDelayMs` | number | `1000` | How long the whole tree must stay idle before notifying |
| `desktop` | boolean | `true` | Native desktop notification on the server host |
| `browser` | boolean | `true` | Browser `Notification` popups in the Web UI — **host-side value only; the browser half always uses `true`** (see the limit note above) |
| `browserOnlyWhenHidden` | boolean | `true` | Suppress browser popups while the tab is visible — **same limit: the browser half always uses `true`** |
| `webhookUrl` | string | `''` | Optional POST target (Slack-compatible payload) |
| `title` | string | `'DeepSeek Harness'` | Desktop notification title |

### Webhook payload

```json
{
  "text": "[Agent Finished] 面板设置优化实施流程 — Refactored the parser and ran the full suite; all tests pass.",
  "summary": "[Agent Finished] 面板设置优化实施流程",
  "body": "Refactored the parser and ran the full suite; all tests pass.",
  "level": "info",
  "ts": "2026-08-21T12:34:56.000Z"
}
```

`summary` is `[<label>] <session title>`, read from the Host's own `ctx.sessionTitle.get(session)`
— the latest durable title, whether auto-generated or user-renamed. When the session has no title
yet (or the Host does not mount `session-title`), the summary degrades to the bare `[<label>]`.
The same format applies to `Agent error`, `Approval Needed`, and `Question Asked`.
`body` is the last main-agent reply (whitespace collapsed, truncated to `maxBodyChars`), or
`done in …` when that reply was empty. `text` stays `summary — body` for Slack-style consumers.

## Design notes

- **Everything registered through `ctx` is an effect** — listeners, the job-event subscription,
  *and* pending settle timers are removed on unload/hot-reload, so an unloaded plugin can never fire
  a late notification.
- **The two settlement sources are independent.** `subagent/start … end` drives
  `waitForSubagents`; `ctx.jobs registered … settled` drives `waitForBackgroundJobs`. Each switch
  only gates its own ledger, so a long background job never delays a completion the user asked not
  to wait for, and job edges never reset the settle timer when the job wait is off. The task group
  still notifies once: after the completion fires, `beganAt` is cleared, so a late job or run edge
  cannot produce a second ping.
- **`approval/request` and `user-questions/request` are waterfalls.** This plugin only observes
  them, so each listener always calls `next()` — returning without it would claim the decision or
  the answer and swallow the real responders.
- **Main-agent attribution is per root session.** `agents.roots()` decides what is a main agent;
  subagent runs are attributed through the scoped `subagent/start` carrier and tracked per root, so
  concurrent sessions never share state. Because the host removes an agent from the registry *before*
  emitting `agent/disposed`, disposal is recognised by the state this plugin already tracks for that
  exact agent, not by a fresh registry lookup. A disposed main agent drops its state, its run ledger,
  and its job ledger.
- **Never break the loop.** Desktop spawns are detached and fire-and-forget; webhook failures are
  swallowed. A notifier must never surface an error into the agent's turn.

## Local development

Copy `dev.patch.example.yml` to `dev.patch.yml` (gitignored), point it at your checkout's
absolute path, then from a harness source checkout:

```sh
pnpm dsh web --patch ./path/to/dsh-notification/dev.patch.yml
```

Edits to `index.js` hot-reload without a restart. Run the tests with `npm test`.

## License

MIT
