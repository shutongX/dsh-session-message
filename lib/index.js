/**
 * dsh-session-message — cross-session messaging for DeepSeek Harness.
 *
 * Registers two global tools:
 *   session_list  enumerate deliverable sessions in every workspace of this host
 *   session_send  deliver a user-role agent-message into another session
 *
 * The plugin intentionally imports no @deepseek-ai package: injected plugin
 * sources live outside the profile's module-resolution roots, so host packages
 * are not importable from here. Tool definitions therefore use the raw JSON
 * Schema subset directly, and messages are plain user messages.
 *
 * Delivery reuses the same host path as scheduled reminders: resolve the target
 * Agent through sessionController, queue a user Message on its inbox, then flush
 * the target session so the message is durable before reporting success.
 */
import { randomUUID } from 'node:crypto';
import {
  buildWorkspaceIndex,
  filterRows,
  findTitleMatches,
  formatSendResult,
  formatSessionList,
  frameAgentMessage,
  normalizeLimit,
  normalizeMessageInput,
  pathKey,
  textOf,
  toSessionRow,
} from './core.js';

export const name = 'dsh-session-message';
export const inject = ['tools', 'sessions', 'sessionController', 'sessionQuery', 'workspaceRegistry'];

// Raw definitions bypass defineTool, so the dispatcher does not validate input
// types. These three keep bad model arguments actionable instead of silently
// ignored; they never coerce.
function argString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(name + ' must be a string');
  return value;
}

function argBoolean(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(name + ' must be a boolean');
  return value;
}

function argLimit(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(parsed)) throw new Error('limit must be a number');
  return parsed;
}

class SessionMessenger {
  constructor(ctx) {
    this.ctx = ctx;
  }

  workspaceIndex() {
    return buildWorkspaceIndex(this.ctx.workspaceRegistry.list());
  }

  archivedIds() {
    return new Set(this.ctx.workspaceRegistry.archivedSessionIds);
  }

  async listRows(signal) {
    const { items = [] } = await this.ctx.sessionController.list({}, signal);
    const index = this.workspaceIndex();
    return items.map((item) => toSessionRow(item, index));
  }

  sessionTitle(session) {
    try {
      // ctx.get() instead of property access: the projection service is optional
      // and must not throw out of message framing.
      return this.ctx.get('sessionProjections')?.stateOf(session, 'title') ?? '';
    } catch {
      return '';
    }
  }

  senderOf(agent) {
    const session = agent.session;
    const cwd = textOf(session.header?.cwd);
    return {
      id: textOf(session.id),
      title: this.sessionTitle(session),
      cwd,
      workspace: this.workspaceIndex().get(pathKey(cwd)) ?? '',
    };
  }

  /** Read one target through a point observation: no full list, no Agent activation. */
  async describeTarget(sessionId, signal) {
    let observation;
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'all' });
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') throw new Error('session ' + JSON.stringify(sessionId) + ' was not found');
      throw error;
    }
    try {
      const header = observation.header ?? {};
      const cwd = textOf(header.cwd);
      return {
        id: textOf(header.id) || sessionId,
        title: typeof observation.projections?.values?.title === 'string' ? observation.projections.values.title : '',
        cwd,
        workspace: this.workspaceIndex().get(pathKey(cwd)) ?? '',
        origin: textOf(header.origin),
      };
    } finally {
      observation[Symbol.dispose]?.();
    }
  }

  assertDeliverable(row) {
    if (row.id === '') throw new Error('target session id is empty');
    if (row.origin === 'subagent') {
      throw new Error('session ' + JSON.stringify(row.id) + ' belongs to a subagent; message an ordinary session instead');
    }
  }

  async resolveTarget(args, signal) {
    const sessionId = textOf(args.session_id);
    if (sessionId !== '') {
      const row = await this.describeTarget(sessionId, signal);
      if (this.archivedIds().has(row.id)) throw new Error('session ' + JSON.stringify(row.id) + ' is archived; unarchive it before messaging');
      this.assertDeliverable(row);
      return row;
    }
    const title = textOf(args.title);
    if (title === '') throw new Error('pass session_id, or title to select a session by its title');
    const rows = filterRows(await this.listRows(signal), { archivedIds: this.archivedIds() });
    const candidates = findTitleMatches(rows, { title, workspace: args.workspace });
    if (candidates.length === 0) {
      throw new Error('no session titled ' + JSON.stringify(title) + ' was found; call session_list to find the session id');
    }
    if (candidates.length > 1) {
      const listed = candidates.slice(0, 5).map((row) => row.id + ' (' + (row.workspace || row.cwd) + ')').join(', ');
      throw new Error('title ' + JSON.stringify(title) + ' matches ' + candidates.length + ' sessions: ' + listed + '; pass session_id instead');
    }
    return candidates[0];
  }

  async list(rawArgs, exec) {
    const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
    const workspace = argString(args.workspace, 'workspace');
    const query = argString(args.query, 'query');
    const includeBlank = argBoolean(args.include_blank, 'include_blank') ?? true;
    const rows = await this.listRows(exec.signal);
    const selfId = exec.agent === undefined ? '' : textOf(exec.agent.session.id);
    const filtered = filterRows(rows, { archivedIds: this.archivedIds(), selfId, workspace, query, includeBlank });
    filtered.sort((left, right) => right.updatedAt - left.updatedAt);
    const sessions = filtered.slice(0, normalizeLimit(argLimit(args.limit))).map((row) => ({
      session_id: row.id,
      title: row.title,
      workspace: row.workspace,
      cwd: row.cwd,
      running: row.running,
      blank: row.blank,
    }));
    return { total: filtered.length, returned: sessions.length, sessions };
  }

  async send(rawArgs, exec) {
    const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {};
    const agent = exec.agent;
    if (agent === undefined) throw new Error('session_send requires a calling agent');
    if (agent.session?.header?.origin === 'subagent') {
      throw new Error('subagent sessions cannot send cross-session messages; ask the parent session to send it');
    }
    const normalized = normalizeMessageInput(args.message);
    if (normalized.error !== undefined) throw new Error(normalized.error);
    argString(args.session_id, 'session_id');
    argString(args.title, 'title');
    argString(args.workspace, 'workspace');
    const delivery = args.delivery ?? 'queue';
    if (delivery !== 'queue' && delivery !== 'steer') throw new Error('delivery must be "queue" or "steer"');
    const target = await this.resolveTarget(args, exec.signal);
    const sender = this.senderOf(agent);
    if (target.id === sender.id) throw new Error('a session cannot send a message to itself');
    const found = await this.ctx.sessionController.resolveAgent(target.id);
    if ('error' in found) {
      throw new Error('cannot deliver to session ' + JSON.stringify(target.id) + ': ' + (found.error?.message ?? String(found.error)));
    }
    // Re-check archive state after activation: the ArchivedSessionGate would
    // otherwise claim and discard the queued input while we report success.
    if (this.archivedIds().has(target.id)) {
      throw new Error('session ' + JSON.stringify(target.id) + ' is archived; unarchive it before messaging');
    }
    const live = found.agent;
    const message = {
      id: randomUUID(),
      role: 'user',
      content: frameAgentMessage(sender, normalized.text),
      source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
    };
    const wokeTarget = live.status !== 'running';
    if (delivery === 'steer') live.steer(message);
    else live.followup(message);
    let persisted;
    try {
      persisted = await this.ctx.sessions.flush(live.session);
    } catch (error) {
      throw new Error('the message (' + message.id + ') was queued for session ' + JSON.stringify(target.id)
        + ' but persistence failed: ' + (error?.message ?? String(error))
        + '; the target may already have received it, so verify before resending');
    }
    if (persisted !== true) {
      throw new Error('the message (' + message.id + ') was queued for session ' + JSON.stringify(target.id)
        + ' but its log did not confirm persistence; the target may already have received it, so verify before resending');
    }
    return {
      delivered: true,
      target_session_id: target.id,
      target_title: target.title,
      target_workspace: target.workspace,
      target_cwd: target.cwd,
      delivery,
      message_id: message.id,
      woke_target: wokeTarget,
    };
  }
}

const sessionListParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspace: { type: 'string', description: 'Filter by workspace title or path (substring, case-insensitive).' },
    query: { type: 'string', description: 'Filter by session title or id (substring, case-insensitive).' },
    include_blank: { type: 'boolean', description: 'Include sessions that have not started a conversation yet. Defaults to true.' },
    limit: { type: 'integer', description: 'Maximum rows to return, 1-50. Defaults to 20.' },
  },
};

const sessionSendParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    session_id: { type: 'string', description: 'Exact target session id from session_list. Required unless title is given; wins when both are present.' },
    title: { type: 'string', description: 'Exact target session title, used only when session_id is omitted. Must match exactly one session.' },
    workspace: { type: 'string', description: 'Workspace title or path substring that narrows a title lookup. Ignored with session_id.' },
    message: { type: 'string', description: 'Message text delivered to the target session as a user message.' },
    delivery: {
      type: 'string',
      enum: ['queue', 'steer'],
      description: 'queue (default) waits for the target next turn; steer injects at the next step of a running turn.',
    },
  },
};

// Output schemas stay complete: PTC-mode deployments render them into the run_code
// SDK as field hints, and the dispatcher validates the returned object against them.
const sessionListOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['total', 'returned', 'sessions'],
  properties: {
    total: { type: 'integer' },
    returned: { type: 'integer' },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id', 'title', 'workspace', 'cwd', 'running', 'blank'],
        properties: {
          session_id: { type: 'string' },
          title: { type: 'string' },
          workspace: { type: 'string' },
          cwd: { type: 'string' },
          running: { type: 'boolean' },
          blank: { type: 'boolean' },
        },
      },
    },
  },
};

const sessionSendOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['delivered', 'target_session_id', 'target_title', 'target_workspace', 'target_cwd', 'delivery', 'message_id', 'woke_target'],
  properties: {
    delivered: { type: 'boolean' },
    target_session_id: { type: 'string' },
    target_title: { type: 'string' },
    target_workspace: { type: 'string' },
    target_cwd: { type: 'string' },
    delivery: { type: 'string', enum: ['queue', 'steer'] },
    message_id: { type: 'string' },
    woke_target: { type: 'boolean' },
  },
};

export function apply(ctx) {
  const messenger = new SessionMessenger(ctx);
  const register = (definition, label) => ctx.effect(() => ctx.tools.register(definition), label);

  register({
    name: 'session_list',
    description: 'List sessions across every workspace of this host so you can message another one. Archived and subagent sessions are excluded; forks are ordinary sessions. Returns id, title, workspace, and running/blank state.',
    parameters: sessionListParameters,
    output: {
      schema: sessionListOutput,
      render: (_args, value) => [{ type: 'text', text: formatSessionList(value) }],
    },
    execute: (args, exec) => messenger.list(args, exec),
  }, 'dsh-session-message: session_list');

  register({
    name: 'session_send',
    description: 'Send a message to another session in any workspace as a user message. The target agent is woken if idle and can reply with session_send; reply only when an answer or action is needed, never just to acknowledge. Use session_list to find the target session id or title.',
    parameters: sessionSendParameters,
    output: {
      schema: sessionSendOutput,
      render: (_args, value) => [{ type: 'text', text: formatSendResult(value) }],
    },
    execute: (args, exec) => messenger.send(args, exec),
  }, 'dsh-session-message: session_send');
}
