/**
 * dsh-session-delete-ui — Host half.
 *
 * Adds the missing "delete session" capability to DSH. The shipped Harness has
 * no deletion or retention API ("pruning stored sessions is out-of-band backend
 * maintenance"), so this half performs that maintenance safely:
 *
 *   1. refuse a session that is live in this process (running or open),
 *   2. resolve its durable artifact through `ctx.sessionPersistence`,
 *   3. validate every path before touching it (inside the sessions root, exactly
 *      one project segment, directory name === session id, never a symlink),
 *   4. remove the log directory and the projection-cache row,
 *   5. only then drop the workspace accounting (membership, archive, pin); the
 *      browser half refreshes its catalog so the row disappears.
 *
 * Files first, bookkeeping second: a failure never leaves a row that is hidden
 * but still on disk.
 *
 * The browser half (client.js) contributes the sidebar menu entry and the
 * confirmation dialog; both call the JSON routes registered here.
 */

import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MODULE = '[dsh-session-delete-ui]';
const API_BASE = '/session-delete/api';
const CACHE_DIR = ['storages', 'session_projcache', 'sessions'];
const MAX_CASCADE_DEPTH = 6;

function log(...args) {
  console.error(MODULE, ...args);
}

function msgOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

/** Session ids compare with and without DSH's `session-` prefix: a subagent
 * header may name its parent in either form. */
function bareId(id) {
  return typeof id === 'string' && id.startsWith('session-') ? id.slice('session-'.length) : id;
}

function isSafeSessionId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= 200
    && id !== '.'
    && id !== '..'
    && !/[\\/\u0000-\u001f<>:"|?*]/.test(id)
    && !/[. ]$/.test(id);
}

function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return resolve(env);
  return join(homedir(), '.dsh');
}

/** The JSONL backend keeps `root`; fall back to the conventional layout. */
function sessionsRoot(ctx) {
  const persistence = ctx.get('sessionPersistence');
  const root = persistence && persistence.root;
  if (typeof root === 'string' && root.trim() !== '') return resolve(root);
  return join(dshHome(), 'sessions');
}

function headerOf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const header = snapshot.header;
  return header && typeof header === 'object' && typeof header.id === 'string' ? header : undefined;
}

/** Every stored session's immutable header, taken from persistence (never by
 * inflating a log body here). */
async function storedHeaders(persistence) {
  const snapshots = await persistence.list();
  const rows = [];
  for (const snapshot of snapshots) {
    const header = headerOf(snapshot);
    if (header !== undefined) rows.push({ header, snapshot });
  }
  return rows;
}

/** Absolute log path for one header, via the backend's own `locate`. */
function locatedPath(persistence, header) {
  if (typeof persistence.locate === 'function') {
    try {
      const location = persistence.locate(header);
      if (location && typeof location.path === 'string' && location.path !== '') return location.path;
    } catch {
      /* fall through to the directory scan */
    }
  }
  return undefined;
}

/** Last-resort location: the artifact directory is named after the session id. */
function findSessionDirByName(root, id) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, id);
    try {
      if (lstatSync(candidate).isDirectory()) return candidate;
    } catch {
      /* keep scanning */
    }
  }
  return undefined;
}

/**
 * A destructive target must be exactly `<sessionsRoot>/<project>/<id>`: two
 * segments below the root, the leaf named after the session, never a symlink or
 * junction, and still inside the real root after resolution.
 */
function assertRemovable(root, dir, id) {
  if (!isSafeSessionId(id)) throw new Error(`refusing to remove '${dir}': unsafe session id`);
  const rootAbs = resolve(root);
  const dirAbs = resolve(dir);
  const rel = relative(rootAbs, dirAbs);
  const parts = rel.split(sep).filter((part) => part !== '');
  if (rel === '' || isAbsolute(rel) || parts.length !== 2 || parts[1] !== id) {
    throw new Error(`refusing to remove '${dir}': not a session directory under ${rootAbs}`);
  }
  const info = lstatSync(dirAbs);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`refusing to remove '${dir}': not a real directory`);
  }
  const realRoot = realpathSync(rootAbs);
  const realDir = realpathSync(dirAbs);
  const realRel = relative(realRoot, realDir);
  if (realRel === '' || isAbsolute(realRel) || realRel.split(sep).includes('..')) {
    throw new Error(`refusing to remove '${dir}': resolves outside ${realRoot}`);
  }
  return dirAbs;
}

function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(path);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      /* a vanished entry contributes nothing */
    }
  }
  return total;
}

/** Subagent descendants owned by one session. Forks and ordinary sessions are
 * never cascaded: only `origin: 'subagent'` children follow their parent. */
function collectCascade(rows, id) {
  const bare = bareId(id);
  const childrenOf = new Map();
  for (const { header } of rows) {
    if (header.origin !== 'subagent') continue;
    const parent = header.parentSession;
    if (typeof parent !== 'string' || parent === '') continue;
    const key = bareId(parent);
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(header.id);
  }
  const seen = new Set([bare, id]);
  const queue = [{ id: bare, depth: 0 }];
  const found = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= MAX_CASCADE_DEPTH) continue;
    for (const child of childrenOf.get(current.id) ?? []) {
      const childBare = bareId(child);
      if (seen.has(childBare) || seen.has(child)) continue;
      seen.add(childBare);
      seen.add(child);
      found.push(child);
      queue.push({ id: childBare, depth: current.depth + 1 });
    }
  }
  return found;
}

/**
 * Resident means the session still has a live in-process instance. That is NOT
 * the same as running work: the store keeps a session after it was opened, so an
 * archived, completely idle session can still be resident. Never use this alone
 * to refuse a deletion.
 */
function isResident(ctx, id) {
  const sessions = ctx.get('sessions');
  if (!sessions || typeof sessions.get !== 'function') return false;
  try {
    return sessions.get(id) !== undefined;
  } catch {
    return false;
  }
}

function agentOf(ctx, id) {
  const agents = ctx.get('agents');
  if (!agents || typeof agents.get !== 'function') return undefined;
  try {
    return agents.get(id);
  } catch {
    return undefined;
  }
}

function normalizeActivity(entries) {
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = typeof entry.kind === 'string' && entry.kind !== '' ? entry.kind : 'other';
    const items = Array.isArray(entry.items)
      ? entry.items.map((item) => ({
        id: item && typeof item.id === 'string' ? item.id : undefined,
        label: item && typeof item.label === 'string' ? item.label : undefined,
      }))
      : [];
    out.push({ kind, items });
  }
  return out;
}

/**
 * The Host's own archive-admission question: which work families this session
 * still runs. Providers answer `turn`, `job`, `subagent` and `schedule`; an
 * empty answer means there is nothing to stop. The agent-status fallback keeps
 * the check honest if the waterfall is unavailable.
 */
async function activityOf(ctx, id) {
  if (typeof ctx.waterfall === 'function') {
    try {
      const entries = await ctx.waterfall.call(ctx, 'workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
      if (Array.isArray(entries)) return normalizeActivity(entries);
    } catch (error) {
      log('activity probe failed:', id, msgOf(error));
    }
  }
  const agent = agentOf(ctx, id);
  return agent !== undefined && agent.status === 'running' ? [{ kind: 'turn', items: [] }] : [];
}

/** Ask every provider to stop this session's work, exactly as the shipped
 * stop-and-archive path does. */
async function stopActivityOf(ctx, id) {
  if (typeof ctx.parallel !== 'function') return;
  try {
    await ctx.parallel.call(ctx, 'workspace/session-stop', { sessionId: id });
  } catch (error) {
    log('stop request failed:', id, msgOf(error));
  }
}

function removeProjectionCache(home, id) {
  if (home === undefined) return;
  const file = join(home, ...CACHE_DIR, `${id}.json`);
  try {
    if (existsSync(file)) rmSync(file, { force: true });
  } catch (error) {
    log('projection cache not removed:', id, msgOf(error));
  }
}

/** Drop every workspace-side trace of a session that no longer exists on disk:
 * the archive mark, the pin mark and workspace membership. Display bookkeeping
 * only, so failures are logged and never fatal.
 *
 * The archive mark is cleared even when the in-process instance is still
 * resident. Keeping it was tried and reverted: the id then lingered in
 * `archivedSessionIds` and kept a ghost row reachable for a session whose log
 * was already gone, which is exactly the state a user cannot clean up.
 *
 * @returns the kinds actually cleared, so the caller can report what changed.
 */
async function forgetRecord(registry, id) {
  const cleared = { archived: false, pinned: false, member: false };
  if (!registry) return cleared;
  try {
    const archived = registry.archivedSessionIds;
    if (Array.isArray(archived) && archived.includes(id)) {
      await registry.unarchiveSession(id);
      cleared.archived = true;
    }
  } catch (error) {
    log('archive mark not cleared:', id, msgOf(error));
  }
  try {
    const pinned = registry.pinnedSessionIds;
    if (Array.isArray(pinned) && pinned.includes(id)) {
      await registry.unpinSession(id);
      cleared.pinned = true;
    }
  } catch (error) {
    log('pin mark not cleared:', id, msgOf(error));
  }
  try {
    for (const workspace of registry.list()) {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)) {
        await workspace.detachSession(id);
        cleared.member = true;
        break;
      }
    }
  } catch (error) {
    log('workspace accounting not updated:', id, msgOf(error));
  }
  return cleared;
}

function apiJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The display accounting a deleted session can still linger in: the archive
 * set, the pin set, and workspace membership. Any of them can keep a ghost row
 * reachable after the log is gone, so the cleanup path must be able to clear
 * them without a log directory to delete. */
function accountingOf(registry, id) {
  const state = { archived: false, pinned: false, member: false, known: false };
  if (!registry) return state;
  try {
    const archived = registry.archivedSessionIds;
    state.archived = Array.isArray(archived) && archived.includes(id);
  } catch { /* registry unavailable */ }
  try {
    const pinned = registry.pinnedSessionIds;
    state.pinned = Array.isArray(pinned) && pinned.includes(id);
  } catch { /* registry unavailable */ }
  try {
    for (const workspace of registry.list()) {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)) {
        state.member = true;
        break;
      }
    }
  } catch { /* registry unavailable */ }
  state.known = state.archived || state.pinned || state.member;
  return state;
}

export default {
  name: 'dsh-session-delete-ui',
  inject: ['webServer', 'sessionPersistence'],
  apply(ctx) {
    const root = sessionsRoot(ctx);
    const home = dirname(root);

    /** Resolve the target session and every session a cascade would remove. */
    async function plan(sessionId) {
      const persistence = ctx.get('sessionPersistence');
      const rows = await storedHeaders(persistence);
      const byId = new Map();
      for (const row of rows) byId.set(row.header.id, row.header);

      const registry = ctx.get('workspaceRegistry');
      const descendants = collectCascade(rows, sessionId);
      const ids = [sessionId, ...descendants];

      const planRows = [];
      for (const id of ids) {
        const header = byId.get(id);
        let dir;
        if (header !== undefined) {
          const logPath = locatedPath(persistence, header);
          if (logPath !== undefined) dir = dirname(logPath);
        }
        if (dir === undefined || !existsSync(dir)) dir = findSessionDirByName(root, id);
        const activity = await activityOf(ctx, id);
        planRows.push({
          id,
          dir,
          missing: dir === undefined,
          resident: isResident(ctx, id),
          activity,
          active: activity.length > 0,
          accounting: accountingOf(registry, id),
          sizeBytes: dir === undefined ? 0 : directorySize(dir),
        });
      }
      return { planRows, descendants };
    }

    /** Stop the listed sessions' work and wait briefly for the providers to
     * settle, so a turn cancelling now does not fail an otherwise valid delete. */
    async function stopAndWait(rows) {
      const active = rows.filter((row) => row.active).map((row) => row.id);
      if (active.length === 0) return;
      for (const id of active) await stopActivityOf(ctx, id);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const stillActive = [];
        for (const id of active) if ((await activityOf(ctx, id)).length > 0) stillActive.push(id);
        if (stillActive.length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    async function handlePreview(req, res) {
      const body = await readJsonBody(req);
      if (body === null || !isSafeSessionId(body.sessionId)) {
        apiJson(res, 400, { ok: false, code: 'bad-args' });
        return;
      }
      let planned;
      try {
        planned = await plan(body.sessionId);
      } catch (error) {
        apiJson(res, 500, { ok: false, code: 'plan-failed', detail: msgOf(error) });
        return;
      }
      const target = planned.planRows[0];
      apiJson(res, 200, {
        ok: true,
        sessionId: body.sessionId,
        // `active` is the only refusal: work is running and must be stopped.
        // `resident` merely explains why the Host still holds the session.
        active: target.active,
        resident: target.resident,
        activity: target.activity,
        accounting: target.accounting,
        missing: target.missing,
        dir: target.dir ?? null,
        sizeBytes: target.sizeBytes,
        // Only running work blocks. A session whose log is already gone can
        // still be cleaned up, so it stays "deletable" and the dialog offers
        // the cleanup instead of a dead end.
        deletable: !target.active,
        cleanupOnly: target.missing,
        descendants: planned.planRows.slice(1).map((row) => ({
          id: row.id,
          sizeBytes: row.sizeBytes,
          missing: row.missing,
          resident: row.resident,
          active: row.active,
          activity: row.activity,
          accounting: row.accounting,
        })),
        sessionsRoot: root,
      });
    }

    async function handleDelete(req, res) {
      const body = await readJsonBody(req);
      if (body === null || !isSafeSessionId(body.sessionId)) {
        apiJson(res, 400, { ok: false, code: 'bad-args' });
        return;
      }
      const includeDescendants = body.includeDescendants !== false;
      const stopActivity = body.stopActivity === true;

      let planned;
      try {
        planned = await plan(body.sessionId);
      } catch (error) {
        apiJson(res, 500, { ok: false, code: 'plan-failed', detail: msgOf(error) });
        return;
      }

      const plannedRows = includeDescendants ? planned.planRows : [planned.planRows[0]];
      if (plannedRows.some((row) => row.active)) {
        if (!stopActivity) {
          apiJson(res, 409, {
            ok: false,
            code: 'active',
            detail: '该会话仍有正在运行的工作',
            activity: plannedRows.filter((row) => row.active).flatMap((row) => row.activity),
          });
          return;
        }
        await stopAndWait(plannedRows);
        planned = await plan(body.sessionId);
      }

      const target = planned.planRows[0];
      if (target.active) {
        apiJson(res, 409, {
          ok: false,
          code: 'still-active',
          detail: '停止后仍有工作在执行',
          activity: target.activity,
        });
        return;
      }

      const report = { deleted: [], cleaned: [], skippedActive: [], missing: [], failed: [] };
      const rows = includeDescendants ? planned.planRows : [target];

      // Validate every target before removing anything: a refusal leaves the
      // whole request untouched.
      const removals = [];
      for (const row of rows) {
        if (row.missing) {
          report.missing.push(row.id);
          continue;
        }
        if (row.active) {
          report.skippedActive.push(row.id);
          continue;
        }
        try {
          const dir = row.dir ?? findSessionDirByName(root, row.id);
          if (dir === undefined) {
            report.missing.push(row.id);
            continue;
          }
          removals.push({ id: row.id, dir: assertRemovable(root, dir, row.id) });
        } catch (error) {
          report.failed.push({ id: row.id, code: 'unsafe-path', detail: msgOf(error) });
        }
      }

      for (const removal of removals) {
        try {
          rmSync(removal.dir, { recursive: true, force: true });
          report.deleted.push(removal.id);
        } catch (error) {
          report.failed.push({ id: removal.id, code: 'rm-failed', detail: msgOf(error) });
        }
      }

      // Bookkeeping after the files are gone: the row must never be hidden
      // while its log is still present. Ids whose log was already gone are
      // included, so leftover archive / pin / membership accounting is cleaned
      // instead of dead-ending the request.
      const residentById = new Map(rows.map((row) => [row.id, row.resident === true]));
      for (const id of report.deleted) removeProjectionCache(home, id);
      const registry = ctx.get('workspaceRegistry');
      const cleanupTargets = [...new Set([...report.deleted, ...report.missing])];
      for (const id of cleanupTargets) {
        const cleared = await forgetRecord(registry, id);
        if (cleared.archived || cleared.pinned || cleared.member) {
          report.cleaned.push({ id, ...cleared });
        }
      }

      const ok = (report.deleted.length > 0 || report.cleaned.length > 0) && report.failed.length === 0;
      apiJson(res, ok ? 200 : 404, {
        ok,
        ...ok ? {} : { code: 'missing' },
        sessionId: body.sessionId,
        cleanupOnly: report.deleted.length === 0,
        deleted: report.deleted,
        cleaned: report.cleaned,
        skippedActive: report.skippedActive,
        missing: report.missing,
        resident: residentById.get(body.sessionId) === true,
        failed: report.failed,
      });
    }

    const routes = [
      { path: `${API_BASE}/preview`, handler: handlePreview },
      { path: `${API_BASE}/delete`, handler: handleDelete },
      {
        path: `${API_BASE}/health`,
        handler: async (req, res) => {
          const sessions = ctx.get('sessions');
          apiJson(res, 200, {
            ok: true,
            module: MODULE,
            sessionsRoot: root,
            dshHome: home,
            persistence: ctx.get('sessionPersistence') !== undefined,
            liveSessions: sessions && typeof sessions.list === 'function' ? sessions.list().length : null,
          });
        },
      },
    ];

    for (const route of routes) {
      ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }));
    }
    log(`host ready: POST ${API_BASE}/{preview,delete} · sessions root ${root}`);
  },
};
