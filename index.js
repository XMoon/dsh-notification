/**
 * Lightweight Host notifier for DeepSeek Harness / dsh-pi-tui.
 * Adapted from nishit130/dsh-notification index.js (v0.1.2, MIT).
 *
 * Additions:
 *  - truncated last MAIN agent reply in completion webhooks
 *  - no subagent notifications
 *  - defer completion until all descendant subagent runs settle and the main
 *    agent stays idle through a short quiet period
 *  - immediate user-questions/request alerts (without intercepting answers)
 *
 * Uses the Host's @deepseek-ai/dsh-scope to identify the parent of both local
 * and external subagent lifecycle events. It is a peer dependency: the carrier
 * WeakMap is module state, so a second copy of the package would read every
 * carrier as unkeyed and silently disable subagent tracking.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import Schema from '@deepseek-ai/schemastery'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'

export const name = 'dsh-notification'

export const Config = Schema.object({
  notifyOnIdle: Schema.boolean().default(true)
    .description('Notify when the main agent and its subagent tree become idle.'),
  notifyOnError: Schema.boolean().default(true)
    .description('Notify when the main agent errors.'),
  notifyOnApproval: Schema.boolean().default(true)
    .description('Notify when the main agent requests tool approval.'),
  notifyOnQuestion: Schema.boolean().default(true)
    .description('Notify when the main agent asks the user a question.'),
  minTurnDurationMs: Schema.number().default(5000)
    .description('Minimum total main task duration, including background subagents.'),
  maxBodyChars: Schema.number().default(200)
    .description('Maximum number of Unicode characters in notification bodies.'),
  waitForSubagents: Schema.boolean().default(true)
    .description('Suppress intermediate completion until subagent executions have settled.'),
  settleDelayMs: Schema.number().default(1000)
    .description('Time the entire agent tree must remain idle before notification.'),
  desktop: Schema.boolean().default(true)
    .description('Show native desktop notifications on the DSH host.'),
  browser: Schema.boolean().default(true)
    .description('Show browser notifications in the DSH Web UI.'),
  browserOnlyWhenHidden: Schema.boolean().default(true)
    .description('Only show browser notifications while its tab is hidden.'),
  webhookUrl: Schema.string().default('')
    .description('Optional URL to POST a Slack-compatible JSON notification to.'),
  title: Schema.string().default('DeepSeek Harness')
    .description('Title for native desktop notifications.'),
})

// Original dependency-free native notification sender. All spawn failures are
// handled asynchronously so missing notify-send cannot crash a headless host.
export function desktopNotify(title, body, { spawn = nodeSpawn } = {}) {
  try {
    if (process.platform === 'darwin') {
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`],
        { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, body], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    } else if (process.platform === 'win32') {
      const esc = (s) => String(s).replace(/'/g, "''")
      const ps = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
        '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
        `$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) | Out-Null;`,
        `$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) | Out-Null;`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${esc(title)}').Show([Windows.UI.Notifications.ToastNotification]::new($t));`,
      ].join(' ')
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    }
  } catch {}
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function boundText(input, length = 200) {
  const max = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 200
  const text = String(input ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(text) // don't split surrogate pairs / emoji
  if (chars.length <= max) return text
  if (max === 0) return ''
  return `${chars.slice(0, max - 1).join('')}…`
}

function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

export function apply(ctx, config) {
  const settings = config ?? {}
  const service = (key) => {
    try { return typeof ctx.get === 'function' ? ctx.get(key, false) : undefined }
    catch { return undefined }
  }

  // There may be many Sessions on one Host. Track main tasks and subagent
  // runs by root session, never by a global 'is anything running?' flag.
  const roots = new Map()   // root SessionId -> task state
  const runs = new Map()    // SubagentRunId -> root SessionId
  const active = new Map()  // root SessionId -> Set<SubagentRunId>
  const questionsSeen = new WeakSet()

  function agentId(agent) { return String(agent?.session?.id ?? agent?.id ?? '') }

  // Runtime root membership matters: a previously delegated session resumed
  // independently can be a root even if its durable origin is 'subagent'.
  function isMainAgent(agent) {
    if (!agent) return false
    const agents = service('agents')
    if (typeof agents?.roots === 'function') {
      try { return agents.roots().includes(agent) }
      catch { return false }
    }
    return agent.session?.header?.origin !== 'subagent'
  }

  function rootIdForAgent(agent) {
    if (!agent) return null
    const agents = service('agents')
    if (isMainAgent(agent)) return agentId(agent)
    const sessions = service('sessions')
    const seen = new Set()
    let session = agent.session
    while (session) {
      const parentId = session.header?.parentSession
      if (parentId == null || seen.has(String(parentId))) return null
      const id = String(parentId)
      seen.add(id)
      const parentAgent = agents?.get?.(parentId)
      if (parentAgent) {
        if (isMainAgent(parentAgent)) return agentId(parentAgent)
        session = parentAgent.session
      } else {
        // A completed intermediate child can still have a persisted Session.
        session = sessions?.get?.(parentId)
        if (session && session.header?.parentSession == null) return id
      }
    }
    return null
  }

  function stateFor(agent) {
    const id = agentId(agent)
    let state = roots.get(id)
    if (!state) {
      state = {
        agent,
        beganAt: null,
        reply: '',
        timer: null,
        generation: 0,
      }
      roots.set(id, state)
    }
    state.agent = agent
    return state
  }

  function stopTimer(state) {
    state.generation++
    if (state.timer != null) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  // A pending settle timer is a plugin-owned resource: unloading or
  // hot-reloading must not leave it able to notify after the listeners are gone.
  ctx.effect(() => () => {
    for (const state of roots.values()) stopTimer(state)
    roots.clear()
    runs.clear()
    active.clear()
    liveJobs.clear()
    jobRoot.clear()
  }, 'dsh-notification: settle timers')

  function notify(summary, body, level) {
    const text = body ? `${summary} — ${body}` : summary
    if (settings.desktop !== false) desktopNotify(settings.title ?? 'DeepSeek Harness', text)
    if (settings.webhookUrl) {
      // Preserve the original plugin's Slack-compatible payload contract.
      try {
        void fetch(settings.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, summary, body, level, ts: new Date().toISOString() }),
        }).catch(() => {})
      } catch {}
    }
  }

  function runningRuns(rootId) {
    return (active.get(rootId)?.size ?? 0) > 0
  }

  // Background jobs outlive the turn that started them: the main agent goes
  // idle as soon as `run_in_background` returns, so job activity is a second
  // reason a task group is still running. The registry's own projection is the
  // authority; `settled` is the only edge that ends a job.
  const liveJobs = new Map() // root SessionId -> Set<JobId>
  // A job's owner is its DIRECT session, which may be a subagent. Resolution
  // needs the live agent, and that agent can be disposed before its job
  // settles — so the root decided at registration is remembered, and the
  // settlement uses it instead of re-resolving against a dead registry entry.
  const jobRoot = new Map() // JobId -> root SessionId

  function runningJobs(rootId) {
    return (liveJobs.get(rootId)?.size ?? 0) > 0
  }

  function trackJob(rootId, jobId, running) {
    if (rootId == null || jobId == null) return
    const id = String(jobId)
    let group = liveJobs.get(rootId)
    if (!running) {
      group?.delete(id)
      if (group?.size === 0) liveJobs.delete(rootId)
      return
    }
    if (!group) liveJobs.set(rootId, group = new Set())
    group.add(id)
  }

  function treeBusy(rootId) {
    return runningRuns(rootId) || runningJobs(rootId)
  }

  /** Check descendant *live* Agents as well as the start/end run ledger.
   *  listDescendants is a fallback when this plugin attaches mid-execution;
   *  lifecycle start/end is the authority for external subagents and idle
   *  continuable activations that still have not ended.
   */
  async function descendantsBusy(rootId) {
    if (runningRuns(rootId)) return true
    const subagents = service('subagents')
    const agents = service('agents')
    if (typeof subagents?.listDescendants !== 'function' || typeof agents?.get !== 'function') return false
    try {
      const descendants = await subagents.listDescendants(rootId)
      for (const child of descendants) {
        if (child.kind && child.kind !== 'child') continue
        if (agents.get(child.id)?.status === 'running') return true
      }
    } catch {
      // Older compositions may lack sessionQuery; the live run ledger remains.
    }
    return false
  }

  // Background jobs end without a status edge on the main agent, so the job
  // ledger needs its own trigger to re-check a waiting completion.
  function afterJobSettled(rootId) {
    const state = roots.get(rootId)
    if (state) stopTimer(state)
    scheduleCompletion(rootId)
  }

  function scheduleCompletion(rootId) {
    if (settings.notifyOnIdle === false) return
    const state = roots.get(rootId)
    if (!state || state.beganAt == null || state.agent?.status !== 'idle') return
    stopTimer(state)
    if (settings.waitForSubagents !== false && treeBusy(rootId)) return

    const delay = Math.max(0, Number(settings.settleDelayMs ?? 1000) || 0)
    const generation = state.generation
    state.timer = setTimeout(() => {
      state.timer = null
      void (async () => {
        if (roots.get(rootId) !== state || state.generation !== generation) return
        if (state.agent.status !== 'idle') return
        if (settings.waitForSubagents !== false && await descendantsBusy(rootId)) return
        if (roots.get(rootId) !== state || state.generation !== generation) return
        if (state.agent.status !== 'idle') return
        if (settings.waitForSubagents !== false && treeBusy(rootId)) return

        const elapsed = Date.now() - state.beganAt
        if (elapsed >= (settings.minTurnDurationMs ?? 5000)) {
          const max = settings.maxBodyChars ?? 200
          // The fallback is a body like any other: maxBodyChars bounds it too.
          const content = boundText(state.reply, max) || boundText(`done in ${formatDuration(elapsed)}`, max)
          notify('Agent finished', content, 'info')
        }
        state.beganAt = null // only one notification per task group
        state.reply = ''
        stopTimer(state)
      })().catch(() => {})
    }, delay)
  }

  // Observe the durable message stream, not private Session.events storage.
  ctx.on('session/event', (session, event) => {
    const agent = service('agents')?.get?.(session.id)
    if (!agent || !isMainAgent(agent)) return
    const state = stateFor(agent)
    if (event.type === 'turn/start') {
      // New main turn supersedes an older, not-yet-delivered final reply.
      state.reply = ''
      stopTimer(state)
    } else if (event.type === 'assistant/message') {
      const reply = messageText(event.data?.message?.content)
      if (reply) state.reply = reply
    }
  })

  // Parent attribution comes from the scoped lifecycle event carrier. This
  // captures local, nested, and external provider executions alike.
  ctx.on('subagent/start', function (info) {
    const parent = carrierKeyOf(this)
    const rootId = rootIdForAgent(parent)
    if (!rootId) return
    const runId = String(info.runId)
    runs.set(runId, rootId)
    let group = active.get(rootId)
    if (!group) active.set(rootId, group = new Set())
    group.add(runId)
    const state = roots.get(rootId)
    if (state) stopTimer(state)
  })

  ctx.on('subagent/end', function (info) {
    const runId = String(info.runId)
    // The start edge already captured the parent; the child has been disposed
    // by the time subagent/end is emitted, so don't resolve it from info.id.
    const rootId = runs.get(runId)
    if (rootId == null) return
    runs.delete(runId)
    const group = active.get(rootId)
    group?.delete(runId)
    if (group?.size === 0) active.delete(rootId)
    scheduleCompletion(rootId)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (!isMainAgent(agent)) {
      // If the plugin attached while a child was already active, its start
      // edge may have been missed. Re-check a waiting root when it goes idle.
      if (status === 'idle') {
        const rootId = rootIdForAgent(agent)
        if (rootId) scheduleCompletion(rootId)
      }
      return
    }
    const id = agentId(agent)
    const state = stateFor(agent)
    if (status === 'running') {
      stopTimer(state)
      if (state.beganAt == null) state.beganAt = Date.now()
      return
    }
    if (status === 'idle') scheduleCompletion(id)
  })

  ctx.on('agent/error', ({ agent, error, turn, step }) => {
    if (settings.notifyOnError === false || (agent && !isMainAgent(agent))) return
    // The whole body is bounded, not just the error text: the maxBodyChars
    // contract covers every notification this plugin sends.
    const detail = error?.message ?? error ?? 'unknown error'
    notify('Agent error', boundText(`turn ${turn ?? '?'}, step ${step ?? '?'}: ${detail}`,
      settings.maxBodyChars ?? 200), 'error')
  })

  // Both are waterfall events: this is observe-only. Always delegate to the
  // actual TUI responder; never claim, delay, or modify the answer.
  ctx.on('approval/request', (req, next) => {
    if (settings.notifyOnApproval !== false && req.agent && isMainAgent(req.agent)) {
      const detail = req.reason ? `${req.toolName} — ${req.reason}` : req.toolName
      notify('Approval needed', boundText(detail, settings.maxBodyChars ?? 200), 'warn')
    }
    return next()
  }, { prepend: true })

  ctx.on('user-questions/request', (req, next) => {
    if (settings.notifyOnQuestion !== false && req.agent && isMainAgent(req.agent)) {
      if (req && typeof req === 'object' && !questionsSeen.has(req)) {
        questionsSeen.add(req)
        const content = (req.questions ?? []).map(q => q.question).filter(Boolean).join(' / ')
        notify('Question asked', boundText(content || 'Waiting for your answer', settings.maxBodyChars ?? 200), 'warn')
      }
    }
    return next()
  }, { prepend: true })

  ctx.on('agent/disposed', ({ agent }) => {
    // The registry drops the entry BEFORE this edge, so `isMainAgent()` can no
    // longer recognise the main agent here. Ownership of a tracked state is the
    // durable answer: only a main agent ever gets one.
    const id = agentId(agent)
    const state = roots.get(id)
    if (!state || state.agent !== agent) {
      const rootId = rootIdForAgent(agent)
      if (rootId) scheduleCompletion(rootId)
      return
    }
    stopTimer(state)
    roots.delete(id)
    // A closed root can no longer deliver a completion, so its ledgers must
    // not answer a late `subagent/end` with a notification for a dead session.
    for (const [runId, runRootId] of runs) {
      if (runRootId === id) runs.delete(runId)
    }
    active.delete(id)
    liveJobs.delete(id)
    for (const [jobId, jobRootId] of jobRoot) {
      if (jobRootId === id) jobRoot.delete(jobId)
    }
  })

  // Background jobs are their own authority: a settled job re-checks the
  // waiting completion, because settling wakes no `agent/status` edge.
  // Subscribed from an injected child fiber so the registration unwinds with
  // this plugin; the `live` flag additionally stops an in-flight callback.
  let live = true
  ctx.effect(() => () => { live = false }, 'dsh-notification: job ledger')
  ctx.inject(['jobs'], (jobCtx) => {
    const unsubscribe = jobCtx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
      if (!live) return
      const job = event.job
      const owner = job?.owner
      if (owner == null) return
      const jobId = String(job.id)
      if (event.type === 'settled') {
        // Registration is the only edge where the owner is guaranteed live, so
        // that edge decides the root and this one reuses the decision. Re-deriving
        // here would mis-attribute (or drop) a job whose child agent has already
        // been disposed, leaving the parent silently un-notified forever.
        const rootId = jobRoot.get(jobId) ?? String(owner)
        jobRoot.delete(jobId)
        trackJob(rootId, job.id, false)
        if (event.cause === 'teardown') return
        afterJobSettled(rootId)
        return
      }
      if (event.type === 'registered') {
        // A subagent inherits the parent's toolset, so it can start a background
        // job of its own. That job's owner is the CHILD session: attribute it to
        // the same root the subagent run ledger uses, or the parent completes
        // while its delegated work still runs.
        const rootId = rootIdForAgent(service('agents')?.get?.(owner)) ?? String(owner)
        jobRoot.set(jobId, rootId)
        trackJob(rootId, job.id, true)
        const state = roots.get(rootId)
        if (state) stopTimer(state)
      }
    })
    jobCtx.effect(() => unsubscribe, 'dsh-notification: job events')
  })
}
