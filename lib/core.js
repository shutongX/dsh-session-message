/**
 * Pure helpers for dsh-session-message.
 *
 * Deliberately free of @deepseek-ai/* imports so node:test can exercise them
 * outside the DSH host process.
 */

export const MAX_MESSAGE_CHARS = 20000;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;

/** Trimmed string, or '' for anything that is not a string. */
export function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Case- and separator-insensitive key for a workspace or session path. */
export function pathKey(value) {
  const text = textOf(value);
  if (text === '') return '';
  return text.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

/** Map workspace paths to their titles. */
export function buildWorkspaceIndex(workspaces) {
  const index = new Map();
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace === null || typeof workspace !== 'object') continue;
    const key = pathKey(workspace.path);
    if (key !== '' && !index.has(key)) index.set(key, textOf(workspace.title));
  }
  return index;
}

/** Normalize one sessionController.list() row for tools and message framing. */
export function toSessionRow(item, workspaceIndex) {
  const cwd = textOf(item?.cwd);
  return {
    id: textOf(item?.sessionId),
    title: typeof item?.projections?.values?.title === 'string' ? item.projections.values.title : '',
    cwd,
    workspace: workspaceIndex.get(pathKey(cwd)) ?? '',
    origin: textOf(item?.origin),
    running: item?.running === true,
    blank: item?.blank === true,
    updatedAt: typeof item?.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
  };
}

/** Whether a row belongs to the workspace title or path named by the filter. */
export function matchesWorkspace(row, needle) {
  const filter = pathKey(needle);
  if (filter === '') return true;
  return row.workspace.toLowerCase().includes(filter) || pathKey(row.cwd).includes(filter);
}

/**
 * Sessions a cross-session send may address.
 *
 * Only origin 'subagent' is excluded. Forks are ordinary sessions: the host
 * fork() records a parentSession but never an origin, so keying on the parent
 * would hide them.
 */
export function filterRows(rows, options = {}) {
  const archivedIds = options.archivedIds instanceof Set ? options.archivedIds : new Set();
  const selfId = textOf(options.selfId);
  const includeBlank = options.includeBlank !== false;
  const query = textOf(options.query).toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (row.id === '' || archivedIds.has(row.id) || row.id === selfId) return false;
    if (row.cwd === '' || row.origin === 'subagent') return false;
    if (!includeBlank && row.blank) return false;
    if (!matchesWorkspace(row, options.workspace)) return false;
    if (query !== '' && !row.title.toLowerCase().includes(query) && !row.id.toLowerCase().includes(query)) return false;
    return true;
  });
}

/** Exact-title candidates among the given rows. */
export function findTitleMatches(rows, options = {}) {
  const title = textOf(options.title).toLowerCase();
  if (title === '') return [];
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    row.title !== ''
    && row.title.trim().toLowerCase() === title
    && matchesWorkspace(row, options.workspace)
  ));
}

/** Clamp a requested list size to the supported range. */
export function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIST_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(parsed)));
}

/** Validate and normalize outgoing message text. */
export function normalizeMessageInput(value) {
  if (typeof value !== 'string') return { error: 'message must be a string' };
  const text = value.trim();
  if (text === '') return { error: 'message must not be empty' };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { error: 'message is too long (' + text.length + ' characters; limit ' + MAX_MESSAGE_CHARS + ')' };
  }
  return { text };
}

/**
 * User-role blocks delivered to the target session.
 *
 * The attribution block is load-bearing: the receiver must know this did not
 * come from its own user, must learn the exact reply address, and must not
 * turn two idle sessions into an acknowledgement loop.
 */
export function frameAgentMessage(sender, text) {
  const title = sender.title === '' ? 'untitled' : sender.title;
  const workspace = sender.workspace === '' ? sender.cwd : sender.workspace;
  const header = 'Agent ' + sender.id + ' sent a message from another session (title: ' + JSON.stringify(title)
    + ', workspace: ' + JSON.stringify(workspace) + '). '
    + "This is not a message from this session's user. "
    + 'Reply only if you need an answer or an action from that session; never reply just to acknowledge. '
    + 'To reply, call session_send({ "session_id": ' + JSON.stringify(sender.id) + ', "message": "..." }).';
  return [
    { type: 'text', text: header },
    { type: 'text', text },
  ];
}

/** Render the session_list result as one line per session. */
export function formatSessionList(value) {
  const lines = ['Found ' + value.total + ' deliverable session' + (value.total === 1 ? '' : 's')
    + (value.returned < value.total ? '; showing ' + value.returned : '') + '.'];
  for (const session of value.sessions) {
    const flags = [session.running ? 'running' : 'idle'];
    if (session.blank) flags.push('blank');
    lines.push('- ' + session.session_id + ' | ' + (session.title === '' ? '(untitled)' : JSON.stringify(session.title))
      + ' | ' + (session.workspace === '' ? session.cwd : session.workspace) + ' | ' + flags.join(', '));
  }
  return lines.join('\n');
}

/** Render the session_send confirmation. */
export function formatSendResult(value) {
  const title = value.target_title === '' ? '(untitled)' : JSON.stringify(value.target_title);
  const workspace = value.target_workspace === '' ? value.target_cwd : value.target_workspace;
  const mode = value.delivery === 'steer'
    ? 'injected at its next step boundary'
    : 'queued for its next turn';
  const wake = value.woke_target ? ' The target was idle, so this wakes it now.' : '';
  return 'Delivered to session ' + value.target_session_id + ' (' + title + ', workspace: ' + JSON.stringify(workspace)
    + ') as a user message, ' + mode + '.' + wake + ' message id: ' + value.message_id + '.';
}
