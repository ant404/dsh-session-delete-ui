/**
 * dsh-session-delete-ui — Web client half.
 *
 * Contributes one entry to the sidebar session row menu
 * (`sidebar.workspaces.session.menu.item`, order 500 — after the shipped
 * Archive row at 400) and one confirmation dialog in `shell.overlay`.
 *
 * The dialog is the safety boundary: it names the session, states that the
 * deletion is permanent, and — through the Host's preview route — refuses a
 * session that is still live and lists the subagent sessions a cascade would
 * take with it.
 *
 * Only the second half of the flow is destructive, and only after an explicit
 * click: nothing on this page deletes without the dialog's confirmation.
 *
 * Styles are copied from the shipped primitives (Menu item, Modal, Button) and
 * renamed under the `dsd_` prefix. Only `--dsw-alias-*` theme tokens are
 * referenced, so light and dark themes both apply.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-delete-ui',
  factory(require) {
    var React = require('react');
    var h = React.createElement;

    var NS = 'dsh-session-delete-ui';
    var API = '/session-delete/api';
    var LIST_SLOT = 'sidebar.workspaces.session.menu.item';
    var OVERLAY_SLOT = 'shell.overlay';

    var zh = {
      'menu.delete': '删除会话',
      'dialog.title': '删除会话',
      'dialog.body': '确定要永久删除会话「{title}」吗？',
      'dialog.warning': '此操作不可恢复：将删除该会话的本地日志、投影缓存与工作区记录。',
      'dialog.children': '同时会删除 {n} 个子代理会话。',
      'dialog.size': '将释放约 {size}。',
      'dialog.running': '该会话正在运行或已打开，请先停止它再删除。',
      'dialog.missing': '本地已无该会话的记录，无需删除。',
      'dialog.checking': '正在检查…',
      'dialog.previewError': '无法读取该会话的存储信息；仍可尝试删除，失败时会给出原因。',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.deleting': '正在删除…',
      'dialog.close': '关闭',
      'notice.deleted': '已删除会话「{title}」',
      'notice.failed': '删除失败：{reason}',
      'error.live': '该会话正在运行或已打开',
      'error.missing': '本地已无该会话的记录',
      'error.generic': '删除失败',
    };

    var en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete session',
      'dialog.body': 'Permanently delete the session "{title}"?',
      'dialog.warning': 'This cannot be undone: the session log, its projection cache and its workspace records are removed.',
      'dialog.children': 'It also deletes {n} subagent session(s).',
      'dialog.size': 'Frees about {size}.',
      'dialog.running': 'This session is running or open. Stop it first, then delete.',
      'dialog.missing': 'No local record of this session remains; nothing to delete.',
      'dialog.checking': 'Checking…',
      'dialog.previewError': 'Could not read this session storage; deletion may still be attempted and will report its own failure.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.deleting': 'Deleting…',
      'dialog.close': 'Close',
      'notice.deleted': 'Deleted session "{title}"',
      'notice.failed': 'Delete failed: {reason}',
      'error.live': 'This session is running or open',
      'error.missing': 'No local record of this session remains',
      'error.generic': 'Delete failed',
    };

    var CSS = [
      '.dsd_menuSeparator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}',
      '.dsd_menuItem{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}',
      '.dsd_menuItem:hover{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}',
      '.dsd_menuItem:focus-visible{background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));outline:none}',
      '.dsd_menuIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-state-error-primary)}',
      '.dsd_menuLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary)}',
      '.dsd_root{pointer-events:auto;position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dsd_mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4))}',
      '.dsd_dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(400px,100%);max-height:100%;overflow:auto;border:0;border-radius:var(--dsw-radius-panel,var(--dsw-radius-lg));background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
      '.dsd_header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}',
      '.dsd_title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsd_close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1}',
      '.dsd_close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsd_close:disabled{opacity:.4;cursor:not-allowed}',
      '.dsd_description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.dsd_body{display:flex;flex-direction:column;gap:6px;margin-top:20px;padding:0 24px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsd_line{overflow-wrap:anywhere}',
      '.dsd_warn{color:var(--dsw-alias-state-error-primary)}',
      '.dsd_footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
      '.dsd_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}',
      '.dsd_btn:disabled{cursor:not-allowed;opacity:.4}',
      '.dsd_outline{border:.5px solid var(--dsw-alias-border-l3)}',
      '.dsd_outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsd_danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
      '.dsd_toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1200;max-width:min(520px,90vw);box-sizing:border-box;padding:10px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.dsd_toastError{color:var(--dsw-alias-state-error-primary)}',
      '@media (prefers-reduced-motion: no-preference){.dsd_dialog{animation:dsd_enter var(--ds-transition-duration,.18s) var(--ds-ease-in-out,ease)}}',
      '@keyframes dsd_enter{from{opacity:0}to{opacity:1}}',
    ].join('');

    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': true,
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4.2 4.5l.6 8.1c0 .5.4.9.9.9h4.6c.5 0 .9-.4.9-.9l.6-8.1' }),
        h('path', { d: 'M6.8 7.3v4.1M9.2 7.3v4.1' }),
      );
    }

    function StyleTag() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
    }

    /** Minimal observable store: the menu entry opens the dialog, the dialog
     * (which lives in a different slot subtree) reads it. */
    function createStore(initial) {
      var value = initial;
      var listeners = new Set();
      return {
        get: function () { return value; },
        set: function (next) {
          value = next;
          var current = Array.from(listeners);
          for (var i = 0; i < current.length; i += 1) {
            try { current[i](); } catch (error) { /* one listener must not break the rest */ }
          }
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
      };
    }

    function useStoreValue(store) {
      var pair = React.useState(store.get);
      var value = pair[0];
      var setValue = pair[1];
      React.useEffect(function () {
        return store.subscribe(function () { setValue(store.get()); });
      }, [store]);
      return value;
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '0 B';
      var units = ['B', 'KB', 'MB', 'GB'];
      var index = 0;
      var value = bytes;
      while (value >= 1024 && index < units.length - 1) { value = value / 1024; index += 1; }
      return (index === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[index];
    }

    /** A slot entry that throws blanks its row, so never assume the locale seat exists. */
    function translator(props) {
      return typeof props.t === 'function' ? props.t : function (key) { return key; };
    }

    /** Sidebar row-menu entry: destructive, in its own group after Archive. */
    function DeleteSessionMenuItem(props) {
      var t = translator(props);
      var requestDelete = props.requestDelete;
      var useMenuOpenState = props.useMenuOpenState;
      var menu = typeof useMenuOpenState === 'function' ? useMenuOpenState() : [false, function () {}];
      var setMenuOpen = menu[1];
      return h(React.Fragment, null,
        h(StyleTag, null),
        h('div', { className: 'dsd_menuSeparator', 'aria-hidden': true }),
        h('button', {
          type: 'button',
          role: 'menuitem',
          className: 'dsd_menuItem',
          onClick: function (event) {
            event.preventDefault();
            event.stopPropagation();
            try { setMenuOpen(false); } catch (error) { /* the menu may already be closing */ }
            requestDelete(props.sessionId, props.displayTitle);
          },
        },
          h('span', { className: 'dsd_menuIcon' }, h(TrashIcon, null)),
          h('span', { className: 'dsd_menuLabel' }, t('menu.delete')),
        ),
      );
    }

    /** The confirmation dialog and the result toast, both rendered in the frame's
     * overlay slot so they outlive the row menu that opened them. */
    function DeleteOverlay(props) {
      var t = translator(props);
      var store = props.store;
      var close = props.close;
      var confirm = props.confirm;
      var state = useStoreValue(store);
      var cancelRef = React.useRef(null);
      var open = state !== null && state.kind === 'dialog';
      var busy = open && state.busy === true;

      React.useEffect(function () {
        if (!open) return undefined;
        var onKeyDown = function (event) {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            close();
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return function () { window.removeEventListener('keydown', onKeyDown); };
      }, [open, busy, close]);

      React.useEffect(function () {
        if (open && !busy && cancelRef.current && typeof cancelRef.current.focus === 'function') {
          cancelRef.current.focus();
        }
      }, [open, busy]);

      if (state === null) return null;

      if (state.kind === 'notice') {
        return h(React.Fragment, null,
          h(StyleTag, null),
          h('div', {
            className: state.tone === 'error' ? 'dsd_toast dsd_toastError' : 'dsd_toast',
            role: 'status',
          }, state.textKey === 'notice.deleted'
            ? t('notice.deleted', { title: state.title })
            : t('notice.failed', { reason: state.reason })),
        );
      }

      var preview = state.preview;
      var previewError = state.previewError;
      var checking = preview === null && previewError === null;
      var live = preview !== null && preview.live === true;
      var missing = preview !== null && preview.missing === true;
      var descendants = preview !== null && Array.isArray(preview.descendants) ? preview.descendants.length : 0;
      var canDelete = !busy && !checking && !live && !missing;

      var lines = [h('div', { key: 'warn', className: 'dsd_line dsd_warn' }, t('dialog.warning'))];
      if (checking) lines.push(h('div', { key: 'checking', className: 'dsd_line' }, t('dialog.checking')));
      if (previewError !== null) lines.push(h('div', { key: 'preview-error', className: 'dsd_line' }, t('dialog.previewError')));
      if (live) lines.push(h('div', { key: 'live', className: 'dsd_line dsd_warn' }, t('dialog.running')));
      if (missing) lines.push(h('div', { key: 'missing', className: 'dsd_line' }, t('dialog.missing')));
      if (descendants > 0) lines.push(h('div', { key: 'children', className: 'dsd_line' }, t('dialog.children', { n: descendants })));
      if (preview !== null && !live && !missing) {
        var bytes = (typeof preview.sizeBytes === 'number' ? preview.sizeBytes : 0)
          + (Array.isArray(preview.descendants) ? preview.descendants.reduce(function (sum, entry) {
            return sum + (entry && typeof entry.sizeBytes === 'number' ? entry.sizeBytes : 0);
          }, 0) : 0);
        if (bytes > 0) lines.push(h('div', { key: 'size', className: 'dsd_line' }, t('dialog.size', { size: formatBytes(bytes) })));
      }
      if (state.errorCode !== null || state.errorDetail !== null) {
        var reason = state.errorCode === 'live' ? t('error.live')
          : state.errorCode === 'missing' ? t('error.missing')
            : (state.errorDetail !== null && state.errorDetail !== '' ? state.errorDetail : t('error.generic'));
        lines.push(h('div', { key: 'error', className: 'dsd_line dsd_warn' }, reason));
      }

      return h(React.Fragment, null,
        h(StyleTag, null),
        h('div', { className: 'dsd_root' },
          h('div', { className: 'dsd_mask', onClick: function () { if (!busy) close(); } }),
          h('div', {
            className: 'dsd_dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsd-dialog-title',
            'aria-describedby': 'dsd-dialog-body',
          },
            h('div', { className: 'dsd_content' },
              h('div', { className: 'dsd_header' },
                h('h2', { className: 'dsd_title', id: 'dsd-dialog-title' }, t('dialog.title')),
                h('button', {
                  type: 'button', className: 'dsd_close', disabled: busy,
                  'aria-label': t('dialog.close'), onClick: close,
                }, '\u00d7'),
              ),
              h('p', { className: 'dsd_description', id: 'dsd-dialog-body' },
                t('dialog.body', { title: state.displayTitle || state.sessionId })),
              h('div', { className: 'dsd_body' }, lines),
            ),
            h('div', { className: 'dsd_footer' },
              h('button', {
                type: 'button', className: 'dsd_btn dsd_outline', disabled: busy,
                ref: cancelRef, onClick: close,
              }, t('dialog.cancel')),
              h('button', {
                type: 'button', className: 'dsd_btn dsd_outline dsd_danger',
                disabled: !canDelete, onClick: confirm,
              }, busy ? t('dialog.deleting') : t('dialog.confirm')),
            ),
          ),
        ),
      );
    }

    function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      var locale = ctx.get('locale');

      var store = createStore(null);
      var noticeTimer = null;

      function setNotice(tone, payload) {
        store.set(Object.assign({ kind: 'notice', tone: tone }, payload));
        if (noticeTimer !== null) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(function () {
          noticeTimer = null;
          var current = store.get();
          if (current !== null && current.kind === 'notice') store.set(null);
        }, 5000);
      }

      function callApi(action, payload) {
        return fetch(API + '/' + action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (response) {
          return response.json().catch(function () { return null; }).then(function (data) {
            if (response.ok && data !== null && data.ok === true) return data;
            var code = data !== null && typeof data.code === 'string' ? data.code : null;
            var detail = data !== null && typeof data.detail === 'string' && data.detail !== '' ? data.detail : null;
            var error = new Error(detail || (code === null ? 'HTTP ' + String(response.status) : code));
            error.code = code;
            error.detail = detail;
            throw error;
          });
        });
      }

      /** Load the session from the Host without changing anything. */
      function requestDelete(sessionId, displayTitle) {
        store.set({
          kind: 'dialog',
          sessionId: sessionId,
          displayTitle: typeof displayTitle === 'string' && displayTitle !== '' ? displayTitle : sessionId,
          preview: null,
          previewError: null,
          busy: false,
          errorCode: null,
          errorDetail: null,
        });
        callApi('preview', { sessionId: sessionId }).then(function (preview) {
          var current = store.get();
          if (current !== null && current.kind === 'dialog' && current.sessionId === sessionId) {
            store.set(Object.assign({}, current, { preview: preview }));
          }
        }).catch(function (error) {
          var current = store.get();
          if (current !== null && current.kind === 'dialog' && current.sessionId === sessionId) {
            store.set(Object.assign({}, current, { previewError: String(error && error.message ? error.message : error) }));
          }
        });
      }

      function close() {
        var current = store.get();
        if (current !== null && current.kind === 'dialog' && current.busy === true) return;
        store.set(null);
      }

      function confirm() {
        var current = store.get();
        if (current === null || current.kind !== 'dialog' || current.busy === true) return;
        store.set(Object.assign({}, current, { busy: true, errorCode: null, errorDetail: null }));
        callApi('delete', { sessionId: current.sessionId, includeDescendants: true }).then(function (result) {
          setNotice('ok', { textKey: 'notice.deleted', title: current.displayTitle, action: { kind: 'deleted', sessionId: current.sessionId, deleted: result.deleted } });
          refreshCatalog(ctx);
        }).catch(function (error) {
          var latest = store.get();
          if (latest === null || latest.kind !== 'dialog') return;
          store.set(Object.assign({}, latest, {
            busy: false,
            errorCode: error && typeof error.code === 'string' ? error.code : null,
            errorDetail: error && typeof error.message === 'string' ? error.message : String(error),
          }));
        });
      }

      ctx.effect(function () {
        return function () { if (noticeTimer !== null) clearTimeout(noticeTimer); };
      }, 'session-delete: notice timer');

      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, 'session-delete: dictionaries');
      }

      slots.inject(LIST_SLOT, function () {
        return slots.register({
          name: LIST_SLOT,
          id: 'session-delete',
          order: 500,
          locale: NS,
          inject: function () { return { requestDelete: requestDelete }; },
        }, DeleteSessionMenuItem);
      });

      slots.inject(OVERLAY_SLOT, function () {
        return slots.register({
          name: OVERLAY_SLOT,
          id: 'session-delete-dialog',
          locale: NS,
          inject: function () { return { store: store, close: close, confirm: confirm }; },
        }, DeleteOverlay);
      });
    }

    /** Reload the browser's session catalog so the removed row leaves the
     * sidebar without a page reload. The Host already dropped it from
     * persistence, so this only re-reads the authoritative list. */
    function refreshCatalog(ctx) {
      var sessions = ctx.get('sessions');
      if (sessions && typeof sessions.refresh === 'function') {
        try {
          var result = sessions.refresh();
          if (result && typeof result.catch === 'function') result.catch(function () { /* the next poll reconciles */ });
        } catch (error) { /* keep the toast; the row clears on the next refresh */ }
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    };
  },
});
