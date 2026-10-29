import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const workspaces = [
  { title: 'alpha', path: 'C:\\work\\alpha' },
  { title: 'beta', path: 'D:\\work\\beta' },
];

function listItem(sessionId, cwd, title, extra = {}) {
  return {
    sessionId,
    cwd,
    projections: title === undefined ? undefined : { values: { title } },
    updatedAt: extra.updatedAt ?? 0,
    running: extra.running ?? false,
    blank: extra.blank ?? false,
    origin: extra.origin,
    parentSessionId: extra.parentSessionId,
  };
}

function observation(header, title) {
  return { header, projections: { values: { title } }, [Symbol.dispose]() {} };
}

function targetAgent(options = {}) {
  const calls = [];
  return {
    session: { id: options.id ?? 'session-target', header: { cwd: options.cwd ?? 'D:\\work\\beta' } },
    status: options.status ?? 'idle',
    followup(message) { calls.push({ kind: 'followup', message }); },
    steer(message) { calls.push({ kind: 'steer', message }); },
    calls,
  };
}

function senderAgent(options = {}) {
  return {
    session: {
      id: options.id ?? 'session-sender',
      header: { cwd: options.cwd ?? 'C:\\work\\alpha', origin: options.origin },
    },
    status: 'idle',
  };
}

function makeHarness(config = {}) {
  const tools = new Map();
  const resolved = [];
  let flushes = 0;
  const ctx = {
    effect: (callback) => callback(),
    get: (name) => (name === 'sessionProjections' ? { stateOf: () => config.senderTitle ?? 'Sender title' } : undefined),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    workspaceRegistry: { list: () => config.workspaces ?? workspaces, archivedSessionIds: config.archived ?? [] },
    sessionController: {
      list: async () => ({ items: config.items ?? [] }),
      resolveAgent: async (id) => {
        resolved.push(id);
        if (config.beforeResolve) config.beforeResolve(id);
        if (config.resolveAgentError) return { error: config.resolveAgentError };
        return { agent: config.targetAgent };
      },
    },
    sessionQuery: {
      observeSession: async (id) => {
        if (config.observeError) throw config.observeError;
        if (config.observe) return config.observe(id);
        throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
      },
    },
    sessions: {
      flush: async () => {
        flushes += 1;
        if (config.flushError) throw config.flushError;
        return config.flushResult ?? true;
      },
    },
  };
  apply(ctx);
  return { tools, resolved, flushes: () => flushes };
}

function exec(agent) {
  return { agent, signal: undefined };
}

test('apply registers both tools', () => {
  const { tools } = makeHarness();
  assert.deepEqual([...tools.keys()], ['session_list', 'session_send']);
});

test('session_list lists forks, hides archived/self/subagent rows, and survives null args', async () => {
  const { tools } = makeHarness({
    items: [
      listItem('session-alpha', 'C:\\work\\alpha', 'Alpha', { updatedAt: 2 }),
      listItem('session-fork', 'D:\\work\\beta', 'Fork', { parentSessionId: 'parent', updatedAt: 3 }),
      listItem('session-child', 'D:\\work\\beta', 'Child', { origin: 'subagent', parentSessionId: 'parent' }),
      listItem('session-archived', 'D:\\work\\beta', 'Archived'),
      listItem('session-sender', 'C:\\work\\alpha', 'Self'),
    ],
    archived: ['session-archived'],
  });
  const definition = tools.get('session_list');
  const value = await definition.execute(null, exec(senderAgent()));
  assert.equal(value.total, 2);
  assert.deepEqual(value.sessions.map((session) => session.session_id), ['session-fork', 'session-alpha']);
  assert.equal(value.sessions[0].title, 'Fork');
  assert.equal(definition.output.render({}, value)[0].type, 'text');
});

test('session_list rejects malformed filter types instead of silently ignoring them', async () => {
  const { tools } = makeHarness();
  const definition = tools.get('session_list');
  await assert.rejects(definition.execute({ workspace: 5 }, exec(senderAgent())), /workspace must be a string/);
  await assert.rejects(definition.execute({ query: {} }, exec(senderAgent())), /query must be a string/);
  await assert.rejects(definition.execute({ include_blank: 'false' }, exec(senderAgent())), /include_blank must be a boolean/);
  await assert.rejects(definition.execute({ limit: 'abc' }, exec(senderAgent())), /limit must be a number/);
});

test('session_send by id queues one user message with agent-message source', async () => {
  const target = targetAgent();
  const { tools, flushes } = makeHarness({
    targetAgent: target,
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta' }, 'Target title'),
  });
  const value = await tools.get('session_send').execute(
    { session_id: 'session-target', message: '  please review  ' },
    exec(senderAgent()),
  );
  assert.equal(value.delivered, true);
  assert.equal(value.target_session_id, 'session-target');
  assert.equal(value.target_title, 'Target title');
  assert.equal(value.target_workspace, 'beta');
  assert.equal(value.delivery, 'queue');
  assert.equal(value.woke_target, true);
  assert.equal(typeof value.message_id, 'string');
  assert.equal(flushes(), 1);
  assert.equal(target.calls.length, 1);
  const [call] = target.calls;
  assert.equal(call.kind, 'followup');
  assert.equal(call.message.role, 'user');
  assert.equal(call.message.id, value.message_id);
  assert.deepEqual(call.message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'session-sender' });
  assert.equal(call.message.content[1].text, 'please review');
  assert.match(call.message.content[0].text, /Agent session-sender/);
});

test('session_send by title resolves through the session list', async () => {
  const target = targetAgent();
  const { tools, resolved } = makeHarness({
    targetAgent: target,
    items: [listItem('session-target', 'D:\\work\\beta', 'My target', { updatedAt: 1 })],
  });
  const value = await tools.get('session_send').execute(
    { title: 'my TARGET', workspace: 'beta', message: 'hi' },
    exec(senderAgent()),
  );
  assert.equal(value.target_session_id, 'session-target');
  assert.deepEqual(resolved, ['session-target']);
});

test('session_send by title can target a fork', async () => {
  const target = targetAgent({ id: 'session-fork' });
  const { tools, resolved } = makeHarness({
    targetAgent: target,
    items: [listItem('session-fork', 'D:\\work\\beta', 'Fork session', { parentSessionId: 'parent', updatedAt: 1 })],
  });
  const value = await tools.get('session_send').execute(
    { title: 'Fork session', message: 'hi' },
    exec(senderAgent()),
  );
  assert.equal(value.target_session_id, 'session-fork');
  assert.deepEqual(resolved, ['session-fork']);
});

test('session_send steer uses the next-step lane', async () => {
  const target = targetAgent({ status: 'running' });
  const { tools } = makeHarness({
    targetAgent: target,
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta' }, ''),
  });
  const value = await tools.get('session_send').execute(
    { session_id: 'session-target', message: 'hi', delivery: 'steer' },
    exec(senderAgent()),
  );
  assert.equal(value.delivery, 'steer');
  assert.equal(value.woke_target, false);
  assert.equal(target.calls[0].kind, 'steer');
});

test('session_send rejects self, archived, subagent targets and unknown ids', async () => {
  const selfHarness = makeHarness({
    observe: () => observation({ id: 'session-sender', cwd: 'C:\\work\\alpha' }, ''),
  });
  await assert.rejects(
    selfHarness.tools.get('session_send').execute({ session_id: 'session-sender', message: 'hi' }, exec(senderAgent())),
    /cannot send a message to itself/,
  );

  const archivedHarness = makeHarness({
    archived: ['session-target'],
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta' }, ''),
  });
  await assert.rejects(
    archivedHarness.tools.get('session_send').execute({ session_id: 'session-target', message: 'hi' }, exec(senderAgent())),
    /is archived/,
  );

  const subagentHarness = makeHarness({
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta', origin: 'subagent' }, ''),
  });
  await assert.rejects(
    subagentHarness.tools.get('session_send').execute({ session_id: 'session-target', message: 'hi' }, exec(senderAgent())),
    /belongs to a subagent/,
  );

  const missingHarness = makeHarness({});
  await assert.rejects(
    missingHarness.tools.get('session_send').execute({ session_id: 'session-missing', message: 'hi' }, exec(senderAgent())),
    /was not found/,
  );
});

test('session_send re-checks archive state after activating the target', async () => {
  const archived = [];
  const target = targetAgent();
  const { tools } = makeHarness({
    archived,
    targetAgent: target,
    beforeResolve: () => archived.push('session-target'),
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta' }, ''),
  });
  await assert.rejects(
    tools.get('session_send').execute({ session_id: 'session-target', message: 'hi' }, exec(senderAgent())),
    /is archived/,
  );
  assert.equal(target.calls.length, 0);
});

test('session_send rejects subagent callers and unusable input', async () => {
  const { tools } = makeHarness();
  const definition = tools.get('session_send');
  await assert.rejects(
    definition.execute({ session_id: 'x', message: 'hi' }, exec(senderAgent({ origin: 'subagent' }))),
    /subagent sessions cannot send/,
  );
  await assert.rejects(definition.execute({ session_id: 'x', message: '   ' }, exec(senderAgent())), /must not be empty/);
  await assert.rejects(definition.execute(null, exec(senderAgent())), /message must be a string/);
  await assert.rejects(definition.execute({ session_id: 5, message: 'hi' }, exec(senderAgent())), /session_id must be a string/);
  await assert.rejects(
    definition.execute({ session_id: 'x', message: 'hi', delivery: 'later' }, exec(senderAgent())),
    /delivery must be "queue" or "steer"/,
  );
  await assert.rejects(definition.execute({ message: 'hi' }, exec(senderAgent())), /pass session_id/);
  await assert.rejects(definition.execute({ title: 'nope', message: 'hi' }, exec(senderAgent())), /no session titled/);
});

test('session_send surfaces resolve failures and persistence failures instead of claiming success', async () => {
  const resolveFailure = makeHarness({
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta' }, ''),
    resolveAgentError: { message: 'writer held by another session' },
  });
  await assert.rejects(
    resolveFailure.tools.get('session_send').execute({ session_id: 'session-target', message: 'hi' }, exec(senderAgent())),
    /writer held by another session/,
  );

  const flushFalse = makeHarness({
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta' }, ''),
    targetAgent: targetAgent(),
    flushResult: false,
  });
  await assert.rejects(
    flushFalse.tools.get('session_send').execute({ session_id: 'session-target', message: 'hi' }, exec(senderAgent())),
    /the message \([0-9a-f-]{36}\) was queued for session "session-target" but its log did not confirm persistence; the target may already have received it/,
  );

  const flushThrow = makeHarness({
    observe: () => observation({ id: 'session-target', cwd: 'D:\\work\\beta' }, ''),
    targetAgent: targetAgent(),
    flushError: new Error('disk full'),
  });
  await assert.rejects(
    flushThrow.tools.get('session_send').execute({ session_id: 'session-target', message: 'hi' }, exec(senderAgent())),
    /the message \([0-9a-f-]{36}\) was queued for session "session-target" but persistence failed: disk full; the target may already have received it/,
  );
});
