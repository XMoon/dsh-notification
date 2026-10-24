# Changelog

## Unreleased

### Added
- **Subagent-tree settlement**: a completion waits for every descendant subagent run
  (`subagent/start` … `subagent/end`) of the delegating root session, then for the tree to stay
  idle for `settleDelayMs` (default 1s). Intermediate completions between steps are suppressed and
  a task group notifies exactly once. Config: `waitForSubagents`, `settleDelayMs`.
- **Background-job settlement**: `ctx.jobs` `registered` … `settled` edges per owning session keep
  the completion pending while a `run_in_background` job runs. A teardown settlement does not
  release it. This closes the gap where the turn returned with a job id and the completion fired
  while the job was still working.
- **Reply bodies**: the completion body is the last main-agent reply, whitespace-collapsed and
  truncated to `maxBodyChars` Unicode characters (default 200, no extra model call). Falls back to
  `done in …` when the reply was empty.
- **Question alerts**: `user-questions/request` posts a webhook/desktop notification immediately
  (`notifyOnQuestion`, default on) without answering or delaying the request.
- **Main-agent filtering**: subagent errors, approvals, questions, and status changes never notify
  on their own; attribution uses the scoped `subagent/start` carrier (`@deepseek-ai/dsh-scope`).
- Test suite rewritten on the real Cordis runtime and real scope carriers, and restored as
  `npm test`; CI again runs it after `npm ci`.

### Fixed
- Desktop notifications no longer crash the dsh host process when the
  notifier binary is missing (e.g. headless Linux without `notify-send`).
  `spawn()` failures are delivered asynchronously as an `'error'` event on
  the returned ChildProcess, so the existing try/catch could not catch them
  and Node rethrew the event as `uncaughtException` on every turn end.
  Every platform branch now attaches a no-op `'error'` listener synchronously,
  keeping the notifier strictly best-effort. (closes #1)
- A disposed main agent now drops its task state, its subagent run ledger, and its job ledger. The
  host removes the agent from `agents` *before* emitting `agent/disposed`, so the previous
  runtime-membership check classified the disposal as a subagent edge: state was never cleared, a
  replacement agent for the same session inherited the stale reply, and a late `subagent/end` could
  notify a closed session.
- A background job started **by a subagent** is now attributed to the delegating root, so it defers
  that root's completion like the run ledger does. The job's `owner` is the child session id;
  using it directly as the root key left the parent's ledger empty and completed the task while
  delegated work was still running.
- The empty-reply fallback (`done in …`) is truncated like every other body, so `maxBodyChars` now
  bounds *every* notification body without exception.
- `waitForSubagents: false` is honoured in the settle callback; it previously remained suppressed by
  an unconditional run-ledger check.
- Plugin unload/hot-reload cancels pending settle timers, which previously could fire a notification
  after every listener had been disposed.
- `@deepseek-ai/dsh-scope` is declared as a peer dependency and the lockfile is regenerated:
  `npm ci` previously failed with `Missing: @deepseek-ai/dsh-scope … from lock file`. The peer must
  stay a single copy — the carrier lookup is keyed by a module-level `WeakMap`.
- The browser half now applies the same completion rule as the host half: it walks each running
  row's `parentId` chain in the client session list, defers while a descendant subagent is still
  running, and reports once that tree settles. Previously a delegating main session that went idle
  fired an intermediate "Agent finished" popup, which with the default `browser: true` defeated the
  host-side suppression.
- The error body is now truncated as a whole: `maxBodyChars` previously bounded only the error text,
  so the `turn N, step M: ` prefix pushed real bodies past the configured limit.

### Documentation
- The browser channel's configuration limit is now stated: the Web boot manifest carries no
  per-plugin config, so `browser`, `browserOnlyWhenHidden`, and `minTurnDurationMs` always resolve to
  their defaults in the client half. The README and the bundle header say so instead of promising
  that those host-side values switch the browser channel off. (Pre-existing platform limit, not
  introduced here.)

## 0.1.1 — 2026-08-21

### Added
- **Browser notification channel**: a web client half (`dsh.client`) that watches the
  session list and fires `Notification` popups on the machine viewing the Web UI —
  covering the remote-server topology where host desktop notifications fire out of sight.
  New config: `browser` (default `true`), `browserOnlyWhenHidden` (default `true`).
- Smoke-test suite (`npm test`) and CI on Node 20/22.

### Changed
- `@deepseek-ai/schemastery` moved from `dependencies` to `peerDependencies` — the
  runtime context supplies one shared copy.

## 0.1.0 — 2026-08-21

Initial release.

- Desktop notifications on the server host (macOS `osascript`, Linux `notify-send`,
  Windows PowerShell toast), zero dependencies.
- Optional webhook `POST` with a Slack-compatible `text` field.
- Events: turn finished (`agent/status`, gated by `minTurnDurationMs`), agent error
  (`agent/error`), approval pending (`approval/request`, observe-only).
- Effect-bound listeners: automatic cleanup on unload and hot reload.
