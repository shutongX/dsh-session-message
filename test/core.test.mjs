import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkspaceIndex,
  filterRows,
  findTitleMatches,
  formatSendResult,
  formatSessionList,
  frameAgentMessage,
  MAX_MESSAGE_CHARS,
  normalizeLimit,
  normalizeMessageInput,
  pathKey,
  toSessionRow,
} from '../lib/core.js';

const workspaces = [
  { title: 'alpha', path: 'C:\\work\\alpha' },
  { title: 'beta', path: 'D:/work/beta/' },
];
const index = buildWorkspaceIndex(workspaces);

function item(sessionId, cwd, title, extra = {}) {
  return {
    sessionId,
    cwd,
    projections: title === undefined ? undefined : { kind: 'cached', values: { title } },
    updatedAt: extra.updatedAt ?? 0,
    ...extra,
  };
}

function row(id, cwd, title, extra = {}) {
  return toSessionRow(item(id, cwd, title, extra), index);
}

test('pathKey folds separators, trailing slashes and case', () => {
  assert.equal(pathKey('C:/Work/Alpha/'), pathKey('c:\\work\\alpha'));
  assert.equal(pathKey(''), '');
  assert.equal(pathKey(undefined), '');
});

test('buildWorkspaceIndex maps both slash styles to titles', () => {
  assert.equal(index.get(pathKey('C:/work/ALPHA')), 'alpha');
  assert.equal(index.get(pathKey('d:\\work\\beta')), 'beta');
  assert.equal(index.get(pathKey('C:\\elsewhere')), undefined);
});

test('toSessionRow resolves title, workspace, state and activity', () => {
  const session = row('session-1', 'C:\\work\\alpha', 'Fix parser', {
    updatedAt: 42,
    running: true,
    blank: false,
  });
  assert.deepEqual(session, {
    id: 'session-1',
    title: 'Fix parser',
    cwd: 'C:\\work\\alpha',
    workspace: 'alpha',
    origin: '',
    running: true,
    blank: false,
    updatedAt: 42,
  });
});

test('toSessionRow tolerates missing projections and malformed fields', () => {
  const session = toSessionRow({ sessionId: 7, cwd: null, updatedAt: 'yesterday' }, index);
  assert.equal(session.id, '');
  assert.equal(session.title, '');
  assert.equal(session.workspace, '');
  assert.equal(session.updatedAt, 0);
});

test('filterRows hides self, archived, subagent and cwd-less sessions', () => {
  const rows = [
    row('a', 'C:\\work\\alpha', 'A'),
    row('b', 'C:\\work\\alpha', 'B', { origin: 'subagent' }),
    row('d', 'C:\\work\\alpha', 'D', { cwd: '' }),
    row('e', 'C:\\work\\alpha', 'E'),
    row('self', 'C:\\work\\alpha', 'Me'),
  ];
  const visible = filterRows(rows, { selfId: 'self', archivedIds: new Set(['e']) });
  assert.deepEqual(visible.map((session) => session.id), ['a']);
});

test('filterRows keeps forks: a parentSession without origin is ordinary', () => {
  const rows = [
    row('fork', 'C:\\work\\alpha', 'Fork', { parentSessionId: 'parent' }),
    row('child', 'C:\\work\\alpha', 'Child', { parentSessionId: 'parent', origin: 'subagent' }),
  ];
  assert.deepEqual(filterRows(rows, {}).map((session) => session.id), ['fork']);
});

test('filterRows honors blank, workspace and query', () => {
  const rows = [
    row('a', 'C:\\work\\alpha', 'Alpha task', { blank: true }),
    row('b', 'D:\\work\\beta', 'Beta task'),
    row('c', 'D:\\work\\beta', 'Other', { origin: 'subagent', parentSessionId: 'p' }),
  ];
  assert.deepEqual(filterRows(rows, {}).map((session) => session.id), ['a', 'b']);
  assert.deepEqual(filterRows(rows, { includeBlank: false }).map((session) => session.id), ['b']);
  assert.deepEqual(filterRows(rows, { workspace: 'beta' }).map((session) => session.id), ['b']);
  assert.deepEqual(filterRows(rows, { workspace: 'D:/WORK/BETA/' }).map((session) => session.id), ['b']);
  assert.deepEqual(filterRows(rows, { query: 'ALPHA' }).map((session) => session.id), ['a']);
  assert.deepEqual(filterRows(rows, { query: 'b' }).map((session) => session.id), ['b']);
});

test('findTitleMatches is exact, case-insensitive and workspace-narrowed', () => {
  const rows = [
    row('a', 'C:\\work\\alpha', 'Fix parser'),
    row('b', 'D:\\work\\beta', 'Fix parser'),
    row('c', 'C:\\work\\alpha', 'Fix parser please'),
  ];
  assert.equal(findTitleMatches(rows, { title: 'fix PARSER' }).length, 2);
  assert.deepEqual(findTitleMatches(rows, { title: 'Fix parser', workspace: 'alpha' }).map((r) => r.id), ['a']);
  assert.deepEqual(findTitleMatches(rows, { title: 'Fix pars' }), []);
  assert.deepEqual(findTitleMatches(rows, { title: '   ' }), []);
});

test('normalizeLimit clamps to 1..50 with a default', () => {
  assert.equal(normalizeLimit(undefined), 20);
  assert.equal(normalizeLimit('abc'), 20);
  assert.equal(normalizeLimit(0), 1);
  assert.equal(normalizeLimit(3.9), 3);
  assert.equal(normalizeLimit(500), 50);
});

test('normalizeMessageInput trims and validates', () => {
  assert.deepEqual(normalizeMessageInput('  hello  '), { text: 'hello' });
  assert.equal(normalizeMessageInput('   ').error, 'message must not be empty');
  assert.equal(normalizeMessageInput(42).error, 'message must be a string');
  assert.match(normalizeMessageInput('x'.repeat(MAX_MESSAGE_CHARS + 1)).error, /too long/);
});

test('frameAgentMessage carries attribution, reply address, loop guidance and body', () => {
  const blocks = frameAgentMessage(
    { id: 'session-sender', title: 'Sender "quoted"', cwd: 'C:\\work\\alpha', workspace: 'alpha' },
    'Please review the patch.',
  );
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].text, 'Please review the patch.');
  assert.match(blocks[0].text, /Agent session-sender sent a message from another session/);
  assert.match(blocks[0].text, /"Sender \\"quoted\\""/);
  assert.match(blocks[0].text, /"alpha"/);
  assert.match(blocks[0].text, /This is not a message from this session's user\./);
  assert.match(blocks[0].text, /Reply only if you need an answer or an action from that session; never reply just to acknowledge\./);
  assert.match(blocks[0].text, /session_id": "session-sender"/);
});

test('formatSessionList and formatSendResult stay readable', () => {
  const list = formatSessionList({
    total: 2,
    returned: 2,
    sessions: [
      { session_id: 'a', title: 'A', workspace: 'alpha', cwd: 'C:\\work\\alpha', running: true, blank: false },
      { session_id: 'b', title: '', workspace: '', cwd: 'D:\\loose', running: false, blank: true },
    ],
  });
  assert.match(list, /Found 2 deliverable sessions\./);
  assert.match(list, /- a \| "A" \| alpha \| running/);
  assert.match(list, /- b \| \(untitled\) \| D:\\loose \| idle, blank/);

  const sent = formatSendResult({
    target_session_id: 'a',
    target_title: 'A',
    target_workspace: 'alpha',
    target_cwd: 'C:\\work\\alpha',
    delivery: 'queue',
    message_id: 'm1',
    woke_target: true,
  });
  assert.match(sent, /Delivered to session a/);
  assert.match(sent, /queued for its next turn/);
  assert.match(sent, /wakes it now/);
  assert.match(sent, /message id: m1/);
});
