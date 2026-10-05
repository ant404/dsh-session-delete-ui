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

function isLive(ctx, id) {
  const sessions = ctx.get('sessions');
  if (!sessions || typeof sessions.get !== 'function') return false;
  try {
    return sessions.get(id) !== undefined;
  } catch {
    return false;
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

/** Drop every workspace-side trace of a session that no longer exists on disk.
 * Display bookkeeping only, so failures are logged and never fatal. */
async function forgetRecord(registry, id) {
  if (!registry) return;
  try {
    const archived = registry.archivedSessionIds;
    if (Array.isArray(archived) && archived.includes(id)) await registry.unarchiveSession(id);
  } catch {
    /* already absent, or the registry refuses an unknown session */
  }
  try {
    const pinned = registry.pinnedSessionIds;
    if (Array.isArray(pinned) && pinned.includes(id)) await registry.unpinSession(id);
  } catch {
    /* already absent */
  }
  try {
    for (const workspace of registry.list()) {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)) {
        await workspace.detachSession(id);
        break;
      }
    }
  } catch (error) {
    log('workspace accounting not updated:', id, msgOf(error));
  }
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
        planRows.push({
          id,
          dir,
          missing: dir === undefined,
          live: isLive(ctx, id),
          sizeBytes: dir === undefined ? 0 : directorySize(dir),
        });
      }
      return { planRows, descendants };
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
        live: target.live,
        missing: target.missing,
        dir: target.dir ?? null,
        sizeBytes: target.sizeBytes,
        deletable: !target.missing && !target.live,
        descendants: planned.planRows.slice(1).map((row) => ({
          id: row.id,
          sizeBytes: row.sizeBytes,
          missing: row.missing,
          live: row.live,
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

      let planned;
      try {
        planned = await plan(body.sessionId);
      } catch (error) {
        apiJson(res, 500, { ok: false, code: 'plan-failed', detail: msgOf(error) });
        return;
      }

      const target = planned.planRows[0];
      if (target.live) {
        apiJson(res, 409, { ok: false, code: 'live', detail: '该会话正在运行或已打开' });
        return;
      }
      if (target.missing) {
        apiJson(res, 404, { ok: false, code: 'missing', detail: '本地已无该会话的记录' });
        return;
      }

      const report = { deleted: [], skippedLive: [], missing: [], failed: [] };
      const rows = includeDescendants ? planned.planRows : [target];

      // Validate every target before removing anything: a refusal leaves the
      // whole request untouched.
      const removals = [];
      for (const row of rows) {
        if (row.missing) {
          report.missing.push(row.id);
          continue;
        }
        if (row.live) {
          report.skippedLive.push(row.id);
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
      // while its log is still present.
      for (const id of report.deleted) removeProjectionCache(home, id);
      const registry = ctx.get('workspaceRegistry');
      for (const id of report.deleted) await forgetRecord(registry, id);

      const ok = report.deleted.length > 0 && report.failed.length === 0;
      apiJson(res, ok ? 200 : 500, {
        ok,
        sessionId: body.sessionId,
        deleted: report.deleted,
        skippedLive: report.skippedLive,
        missing: report.missing,
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
