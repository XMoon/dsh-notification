import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { apply, Config, desktopNotify, name } from '../index.js'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Stub the global fetch and collect the webhook payloads it receives. */
function captureWebhook(t) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) })
    return Promise.resolve({ ok: true })
  }
  t.after(() => { globalThis.fetch = original })
  return calls
}

/** Config with the silent channels off, so webhook payloads are the only observable. */
function webhookConfig(overrides = {}) {
  return new Config({
    desktop: false,
    webhookUrl: 'https://example.invalid/hook',
    minTurnDurationMs: 0,
    settleDelayMs: 0,
    ...overrides,
  })
}

function sessionIdOf(agent) {
  return String(agent?.session?.id ?? agent?.id ?? '')
}

/**
 * Live fixture over the real Cordis runtime. The `agents` registry mirrors the
 * production store — an entry disappears BEFORE `agent/disposed` — and every
 * dispatch uses a real scope carrier, so `carrierKeyOf(this)` behaves exactly
 * as it does in the Host.
 */
async function fixture(t, { overrides = {}, subagents, jobs } = {}) {
  const calls = captureWebhook(t)
  const app = new Context()
  const entries = []
  const registry = {
    add(agent, owner) { entries.push({ agent, owner }) },
    remove(agent) {
      const index = entries.findIndex(entry => entry.agent === agent)
      if (index >= 0) entries.splice(index, 1)
    },
    roots() { return entries.filter(entry => entry.owner === undefined).map(entry => entry.agent) },
    get(id) { return entries.find(entry => sessionIdOf(entry.agent) === id)?.agent },
  }
  class AgentsService extends Service {
    constructor(ctx) { super(ctx, 'agents', true) }
    roots() { return registry.roots() }
    get(id) { return registry.get(id) }
  }
  await app.plugin({ name: 'fixture-agents', apply: (ctx) => { new AgentsService(ctx) } })
  if (subagents) {
    class SubagentsService extends Service {
      constructor(ctx) { super(ctx, 'subagents', true) }
      listDescendants(rootId) { return subagents.listDescendants(rootId) }
    }
    await app.plugin({ name: 'fixture-subagents', apply: (ctx) => { new SubagentsService(ctx) } })
  }
  if (jobs) {
    class JobsService extends Service {
      constructor(ctx) { super(ctx, 'jobs', true) }
      get events() { return jobs.events }
    }
    await app.plugin({ name: 'fixture-jobs', apply: (ctx) => { new JobsService(ctx) } })
  }
  const fiber = await app.plugin({
    name: 'fixture-notification',
    apply: (ctx) => { apply(ctx, webhookConfig(overrides)) },
  })
  t.after(() => fiber.dispose())

  const root = (id = 'root') => {
    const agent = { id, status: 'idle', session: { id, header: { id } } }
    registry.add(agent)
    return agent
  }
  const child = (id, parentId = 'root') => {
    const agent = { id, status: 'idle', session: { id, header: { id, parentSession: parentId, origin: 'subagent' } } }
    registry.add(agent, registry.get(parentId) ?? {})
    return agent
  }
  /** Dispatch as the Host does: the subject carrier first, then the event name. */
  const emit = (subject, event, ...args) => app.emit(scopeTarget(subject, subject), event, ...args)
  const waterfall = (subject, event, ...args) => app.waterfall(scopeTarget(subject, subject), event, ...args)
  const status = (agent, next) => {
    agent.status = next
    emit(agent, 'agent/status', { agent, status: next })
  }
  const reply = (agent, message) => {
    emit(agent, 'session/event', agent.session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: message }] } },
    })
  }
  return { app, calls, registry, root, child, emit, waterfall, status, reply, jobs }
}

test('exports a named plugin with a validating schema', () => {
  assert.equal(name, 'dsh-notification')
  const config = new Config({})
  assert.equal(config.notifyOnIdle, true)
  assert.equal(config.notifyOnQuestion, true)
  assert.equal(config.minTurnDurationMs, 5000)
  assert.equal(config.maxBodyChars, 200)
  assert.equal(config.waitForSubagents, true)
  assert.equal(config.settleDelayMs, 1000)
  assert.equal(config.browser, true)
})

test('apply registers a listener for every observed channel', async (t) => {
  const { app } = await fixture(t)
  const channels = Object.keys(app.events._hooks)
    .filter(event => !event.startsWith('internal/'))
    .sort()
  assert.deepEqual(channels, [
    'agent/disposed', 'agent/error', 'agent/status', 'approval/request',
    'session/event', 'subagent/end', 'subagent/start', 'user-questions/request',
  ])
})

test('turn finish posts the last main reply once the duration gate passes', async (t) => {
  const { calls, root, status, reply } = await fixture(t)
  const agent = root()
  status(agent, 'running')
  reply(agent, 'refactored the parser and ran the suite')
  status(agent, 'idle')
  await sleep(20)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.summary, 'Agent finished')
  assert.equal(calls[0].payload.level, 'info')
  assert.equal(calls[0].payload.body, 'refactored the parser and ran the suite')
  assert.equal(calls[0].payload.text, 'Agent finished — refactored the parser and ran the suite')
})

test('a turn below minTurnDurationMs stays quiet', async (t) => {
  const { calls, root, status } = await fixture(t, { overrides: { minTurnDurationMs: 60_000 } })
  const agent = root()
  status(agent, 'running')
  status(agent, 'idle')
  await sleep(20)

  assert.equal(calls.length, 0)
})

test('idle without a tracked start never notifies', async (t) => {
  const { calls, root, status } = await fixture(t)
  const agent = root()
  status(agent, 'idle')
  await sleep(20)

  assert.equal(calls.length, 0)
})

test('a new turn inside the settle window supersedes the pending completion', async (t) => {
  const { calls, root, status, reply } = await fixture(t, { overrides: { settleDelayMs: 40 } })
  const agent = root()
  status(agent, 'running')
  status(agent, 'idle')
  await sleep(5)
  status(agent, 'running')
  reply(agent, 'second turn work')
  status(agent, 'idle')
  await sleep(80)

  assert.equal(calls.length, 1, 'exactly one completion for the settled task')
  assert.equal(calls[0].payload.body, 'second turn work')
})

test('repeated idle edges inside the settle window produce one notification', async (t) => {
  const { calls, root, status } = await fixture(t, { overrides: { settleDelayMs: 30 } })
  const agent = root()
  status(agent, 'running')
  status(agent, 'idle')
  status(agent, 'idle')
  await sleep(70)

  assert.equal(calls.length, 1)
})

test('a subagent run defers the completion until it settles', async (t) => {
  const { calls, root, emit, status } = await fixture(t)
  const agent = root()
  status(agent, 'running')
  emit(agent, 'subagent/start', { runId: 'run-1', id: 'child', provider: 'p', local: true })
  status(agent, 'idle')
  await sleep(20)
  assert.equal(calls.length, 0, 'no intermediate completion while the child runs')

  emit(agent, 'subagent/end', { runId: 'run-1', id: 'child', provider: 'p', local: true, stopReason: 'completed' })
  await sleep(20)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.summary, 'Agent finished')
})

test('waitForSubagents:false completes as soon as the main agent is idle', async (t) => {
  const { calls, root, emit, status } = await fixture(t, { overrides: { waitForSubagents: false } })
  const agent = root()
  status(agent, 'running')
  emit(agent, 'subagent/start', { runId: 'run-1', id: 'child', provider: 'p', local: true })
  status(agent, 'idle')
  await sleep(20)

  assert.equal(calls.length, 1)
})

test('agent/disposed drops the task state and silences late subagent edges', async (t) => {
  const { calls, registry, root, emit, status } = await fixture(t, { overrides: { settleDelayMs: 40 } })
  const agent = root()
  status(agent, 'running')
  emit(agent, 'subagent/start', { runId: 'run-1', id: 'child', provider: 'p', local: true })
  status(agent, 'idle')
  // Production order: the registry entry leaves before the disposal edge.
  registry.remove(agent)
  emit(agent, 'agent/disposed', { agent })
  emit(agent, 'subagent/end', { runId: 'run-1', id: 'child', provider: 'p', local: true, stopReason: 'completed' })
  await sleep(80)

  assert.equal(calls.length, 0, 'a disposed main agent must not notify')
})

test('unloading mid-settle cancels the pending completion', async (t) => {
  const { app, calls, root, status } = await fixture(t, { overrides: { settleDelayMs: 60 } })
  const agent = root()
  status(agent, 'running')
  status(agent, 'idle')
  await app.fiber.dispose()
  await sleep(120)

  assert.equal(calls.length, 0, 'plugin unload must not leave a live timer behind')
})

/** A job registry stand-in publishing the real JobEvent vocabulary. */
function jobRegistry() {
  const listeners = new Set()
  const view = (id, owner, status) => ({ id, kind: 'bash', label: 'sleep 60', owner, status, startedAt: Date.now() })
  return {
    events: {
      subscribe(_filter, listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    registered(id, owner = 'root') {
      for (const listener of [...listeners]) listener({ type: 'registered', job: view(id, owner, 'running') })
    },
    settled(id, owner = 'root', cause = 'producer') {
      for (const listener of [...listeners]) listener({ type: 'settled', job: view(id, owner, 'completed'), cause, awaited: false })
    },
    get count() { return listeners.size },
  }
}

test('a background job defers the completion until it settles', async (t) => {
  const jobs = jobRegistry()
  const { calls, root, status } = await fixture(t, { jobs })
  const agent = root()
  status(agent, 'running')
  // `run_in_background` registers the job, then the turn returns and the agent goes idle.
  jobs.registered('bash-1')
  status(agent, 'idle')
  await sleep(40)
  assert.equal(calls.length, 0, 'a running background job is still work')

  jobs.settled('bash-1')
  await sleep(40)
  assert.equal(calls.length, 1, 'settling the last job releases the completion')
})

test('a teardown settlement does not release a completion', async (t) => {
  const jobs = jobRegistry()
  const { calls, root, status } = await fixture(t, { jobs })
  const agent = root()
  status(agent, 'running')
  jobs.registered('bash-1')
  status(agent, 'idle')
  await sleep(20)
  jobs.settled('bash-1', 'root', 'teardown')
  await sleep(40)

  assert.equal(calls.length, 0, 'a job killed by teardown has no reader left')
})

test('a job owned by another session does not defer this one', async (t) => {
  const jobs = jobRegistry()
  const { calls, root, status } = await fixture(t, { jobs })
  const agent = root()
  status(agent, 'running')
  jobs.registered('bash-other', 'some-other-session')
  status(agent, 'idle')
  await sleep(40)

  assert.equal(calls.length, 1)
})

test('agent/error notifies with turn and step, and filters subagent errors', async (t) => {
  const { calls, root, child, emit } = await fixture(t)
  const agent = root()
  const sub = child('child')
  emit(sub, 'agent/error', { agent: sub, turn: 1, step: 1, error: new Error('child boom') })
  assert.equal(calls.length, 0, 'subagent errors are not the user-facing channel')

  emit(agent, 'agent/error', { agent, turn: 3, step: 2, error: new Error('boom') })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.level, 'error')
  assert.match(calls[0].payload.body, /turn 3, step 2: boom/)
})

test('the error body obeys maxBodyChars including the turn/step prefix', async (t) => {
  const { calls, root, emit } = await fixture(t, { overrides: { maxBodyChars: 20 } })
  const agent = root()
  emit(agent, 'agent/error', { agent, turn: 3, step: 2, error: new Error('x'.repeat(400)) })

  assert.equal(calls.length, 1)
  assert.equal(Array.from(calls[0].payload.body).length, 20,
    `body=${JSON.stringify(calls[0].payload.body)}`)
  assert.ok(calls[0].payload.body.startsWith('turn 3, step 2: '))
})

test('approval/request notifies the main agent AND always delegates to next()', async (t) => {
  const { calls, root, child, waterfall } = await fixture(t)
  const agent = root()
  const sub = child('child')
  let delegated = 0
  const answer = () => { delegated += 1; return Promise.resolve('allowed-once') }

  const outcome = await waterfall(agent, 'approval/request', { agent, toolName: 'bash', reason: 'rm -rf build' }, answer)
  assert.equal(outcome, 'allowed-once', 'must return the downstream outcome unchanged')
  assert.equal(delegated, 1, 'observe-only waterfall listener must call next()')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.summary, 'Approval needed')
  assert.match(calls[0].payload.body, /bash — rm -rf build/)

  await waterfall(sub, 'approval/request', { agent: sub, toolName: 'bash' }, answer)
  assert.equal(calls.length, 1, 'subagent approvals are filtered')
  assert.equal(delegated, 2)
})

test('approval/request delegates even with notifications off', async (t) => {
  const { calls, root, waterfall } = await fixture(t, { overrides: { notifyOnApproval: false } })
  const agent = root()
  let delegated = false
  const outcome = await waterfall(agent, 'approval/request', { agent, toolName: 'bash' },
    () => { delegated = true; return Promise.resolve('rejected') })

  assert.equal(delegated, true)
  assert.equal(outcome, 'rejected')
  assert.equal(calls.length, 0)
})

test('user-questions/request notifies once and leaves the answer untouched', async (t) => {
  const { calls, root, child, waterfall } = await fixture(t)
  const agent = root()
  const sub = child('child')
  const request = { agent, questions: [{ id: 'q1', question: 'Which branch?' }, { id: 'q2', question: 'Force push?' }] }
  const answer = () => Promise.resolve({ answers: [{ id: 'q1', selected: ['main'] }] })

  const outcome = await waterfall(agent, 'user-questions/request', request, answer)
  assert.deepEqual(outcome, { answers: [{ id: 'q1', selected: ['main'] }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.summary, 'Question asked')
  assert.equal(calls[0].payload.body, 'Which branch? / Force push?')

  // The same request object re-dispatched must not alert twice.
  await waterfall(agent, 'user-questions/request', request, answer)
  assert.equal(calls.length, 1)

  await waterfall(sub, 'user-questions/request', { agent: sub, questions: [{ id: 'q', question: 'nested?' }] }, answer)
  assert.equal(calls.length, 1, 'subagent questions are filtered')
})

test('per-event toggles silence their channel', async (t) => {
  const { calls, root, child, emit, status, waterfall } = await fixture(t, {
    overrides: { notifyOnIdle: false, notifyOnError: false, notifyOnQuestion: false },
  })
  const agent = root()
  status(agent, 'running')
  status(agent, 'idle')
  emit(agent, 'agent/error', { agent, turn: 1, step: 1, error: 'x' })
  await waterfall(agent, 'user-questions/request', { agent, questions: [{ id: 'q', question: 'quiet?' }] },
    () => Promise.resolve({ answers: [] }))
  await sleep(20)

  void child
  assert.equal(calls.length, 0)
})

test('maxBodyChars bounds the reply to the configured number of characters', async (t) => {
  const { calls, root, status, reply } = await fixture(t, { overrides: { maxBodyChars: 5 } })
  const agent = root()
  status(agent, 'running')
  reply(agent, 'abcdefghij')
  status(agent, 'idle')
  await sleep(20)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.body, 'abcd…')
  assert.equal(Array.from(calls[0].payload.body).length, 5)
})

test('reply capture keeps the emoji intact when truncating', async (t) => {
  const { calls, root, status, reply } = await fixture(t, { overrides: { maxBodyChars: 3 } })
  const agent = root()
  status(agent, 'running')
  reply(agent, '🙂🙂🙂🙂')
  status(agent, 'idle')
  await sleep(20)

  assert.equal(calls[0].payload.body, '🙂🙂…')
})

/**
 * Regression test for issue #1: on headless Linux without `notify-send`,
 * `spawn()` returns synchronously and the OS failure (ENOENT) arrives later
 * as an `'error'` event on the ChildProcess. A missing `'error'` listener
 * makes Node rethrow it as uncaughtException and kill the whole dsh process.
 * The fix attaches a no-op `'error'` listener synchronously on every branch
 * so the async error is swallowed and the notifier stays best-effort.
 *
 * `node:child_process` is a frozen built-in module namespace in ESM, so we
 * inject the spawn function through `desktopNotify`'s `deps` parameter
 * instead of mutating the global — removing that parameter would silently
 * un-guard the headless-Linux crash path this test exists to cover.
 */
test('desktop notification swallows an async spawn ENOENT (regression for issue #1)', async (t) => {
  const fakeChild = new EventEmitter()
  fakeChild.unref = () => {}
  const enoent = Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' })
  setImmediate(() => fakeChild.emit('error', enoent))

  const spawnCalls = []
  const mockSpawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts })
    return fakeChild
  }

  const unhandled = []
  const onUncaught = (err) => { unhandled.push(err) }
  process.on('uncaughtException', onUncaught)
  t.after(() => { process.off('uncaughtException', onUncaught) })

  desktopNotify('DeepSeek Harness', 'Agent finished — done in 1m 31s', { spawn: mockSpawn })

  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  assert.equal(spawnCalls.length, 1, 'exactly one spawn per desktop notification')
  assert.deepEqual(spawnCalls[0].opts, { stdio: 'ignore', detached: true })
  assert.equal(unhandled.length, 0,
    `spawn 'error' must NOT bubble to uncaughtException (got: ${unhandled.map((e) => e.message).join(', ')})`)
})

/**
 * The browser half is a separate bundle loaded by the Web UI's module loader.
 * It runs in a VM so the test can supply the real client list shape: `ids` is
 * host-list membership (main sessions), while `byId` also carries subagent rows
 * keyed by `parentId`. A main session going idle while a descendant still runs
 * is delegation — the host half defers that case, so the browser half must too,
 * otherwise the default `browser: true` shows the pings the host suppressed.
 */
function loadClientHalf() {
  let registered
  const notifications = []
  class FakeNotification {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, options) {
      notifications.push({ title, body: options.body })
      this.close = () => {}
    }
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (mod) => { registered = mod } },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
    },
    document: { visibilityState: 'hidden' },
    Notification: FakeNotification,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
  return { exports: registered.factory(() => ({})), notifications }
}

/** Client list store stand-in exposing the same getSnapshot/subscribe/set API. */
function clientList(initial) {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(next) { state = next; for (const listener of listeners) listener() },
  }
}

function clientSnapshot({ rootRunning, childRunning, grandchildRunning }) {
  const byId = {
    root: { id: 'root', running: rootRunning, retainedBy: { mainView: 1 } },
  }
  if (childRunning !== undefined) {
    byId.kid = { id: 'kid', running: childRunning, parentId: 'root', origin: 'subagent', retainedBy: { mainView: 0 } }
  }
  if (grandchildRunning !== undefined) {
    byId.grand = { id: 'grand', running: grandchildRunning, parentId: 'kid', origin: 'subagent', retainedBy: { mainView: 0 } }
  }
  return { ids: ['root'], byId, phase: 'ready' }
}

function applyClientHalf(list) {
  const { exports: module, notifications } = loadClientHalf()
  module.apply({
    get: (service) => (service === 'sessions' ? { list } : undefined),
    effect: (register) => register(),
  }, { minTurnDurationMs: 0, browserOnlyWhenHidden: false })
  return notifications
}

test('browser half stays quiet while a subagent of the main session still runs', () => {
  const list = clientList(clientSnapshot({ rootRunning: true, childRunning: true }))
  const notifications = applyClientHalf(list)
  list.set(clientSnapshot({ rootRunning: false, childRunning: true }))

  assert.equal(notifications.length, 0, 'a delegating main session is not finished')
})

test('browser half reports once after the delegated tree settles', () => {
  const list = clientList(clientSnapshot({ rootRunning: true, childRunning: true }))
  const notifications = applyClientHalf(list)
  list.set(clientSnapshot({ rootRunning: false, childRunning: true }))
  assert.equal(notifications.length, 0)
  list.set(clientSnapshot({ rootRunning: false, childRunning: false }))

  assert.equal(notifications.length, 1, 'the deferred completion must still arrive')
  assert.match(notifications[0].body, /^Agent finished/)
})

test('browser half stays quiet while only a nested grandchild still runs', () => {
  const list = clientList(clientSnapshot({ rootRunning: true, childRunning: true, grandchildRunning: true }))
  const notifications = applyClientHalf(list)
  list.set(clientSnapshot({ rootRunning: false, childRunning: false, grandchildRunning: true }))
  assert.equal(notifications.length, 0)
  list.set(clientSnapshot({ rootRunning: false, childRunning: false, grandchildRunning: false }))

  assert.equal(notifications.length, 1)
})

test('browser half does not repeat a completion on further list updates', () => {
  const list = clientList(clientSnapshot({ rootRunning: true, childRunning: true }))
  const notifications = applyClientHalf(list)
  list.set(clientSnapshot({ rootRunning: false, childRunning: true }))
  list.set(clientSnapshot({ rootRunning: false, childRunning: false }))
  list.set(clientSnapshot({ rootRunning: false, childRunning: false }))

  assert.equal(notifications.length, 1)
})

test('browser half still notifies a plain main completion', () => {
  const list = clientList(clientSnapshot({ rootRunning: true }))
  const notifications = applyClientHalf(list)
  list.set(clientSnapshot({ rootRunning: false }))

  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].body, 'Agent finished')
})

test('two background jobs both defer the completion', async (t) => {
  const jobs = jobRegistry()
  const { calls, root, status } = await fixture(t, { jobs })
  const agent = root()
  status(agent, 'running')
  jobs.registered('bash-1')
  jobs.registered('bash-2')
  status(agent, 'idle')
  await sleep(30)
  assert.equal(calls.length, 0)

  jobs.settled('bash-1')
  await sleep(40)
  assert.equal(calls.length, 0, 'the second job still runs')

  jobs.settled('bash-2')
  await sleep(40)
  assert.equal(calls.length, 1)
})

test('a leftover job registered before the turn still releases the completion', async (t) => {
  const jobs = jobRegistry()
  const { calls, root, status } = await fixture(t, { jobs })
  const agent = root()
  jobs.registered('old-job')
  status(agent, 'running')
  status(agent, 'idle')
  await sleep(30)
  assert.equal(calls.length, 0)

  jobs.settled('old-job')
  await sleep(40)
  assert.equal(calls.length, 1)
})

test('a background job started by a subagent still defers the main completion', async (t) => {
  const jobs = jobRegistry()
  const { calls, root, child, status } = await fixture(t, { jobs })
  const agent = root()
  const sub = child('child')
  status(agent, 'running')
  // A child inherits the parent's toolset, so it can start its own background job.
  jobs.registered('child-job', sub.id)
  status(agent, 'idle')
  await sleep(30)
  assert.equal(calls.length, 0, 'delegated work still runs')

  jobs.settled('child-job', sub.id)
  await sleep(40)
  assert.equal(calls.length, 1, 'the root is released once the child job settles')
})

test('the empty-reply fallback obeys maxBodyChars', async (t) => {
  const { calls, root, status } = await fixture(t, { overrides: { maxBodyChars: 5 } })
  const agent = root()
  status(agent, 'running')
  // No assistant/message at all: the body falls back to the duration summary.
  status(agent, 'idle')
  await sleep(30)

  assert.equal(calls.length, 1)
  assert.equal(Array.from(calls[0].payload.body).length <= 5, true,
    `body=${JSON.stringify(calls[0].payload.body)}`)
})

test('a subagent job whose owner was disposed still releases the root completion', async (t) => {
  const jobs = jobRegistry()
  const { calls, registry, root, child, status } = await fixture(t, { jobs })
  const agent = root()
  const sub = child('child')
  status(agent, 'running')
  jobs.registered('child-job', sub.id)
  // The child settles and is disposed while its background job keeps running.
  registry.remove(sub)
  status(agent, 'idle')
  await sleep(30)
  assert.equal(calls.length, 0)

  jobs.settled('child-job', sub.id)
  await sleep(40)
  assert.equal(calls.length, 1, 'the remembered root releases even after the owner is gone')
})
