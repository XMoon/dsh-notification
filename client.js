/* dsh-notification — client bundle (hand-written, matches the official
 * tsdown output shape, so no build step is needed).
 *
 * Browser-side half of dsh-notification: watches the client session list
 * (ctx.sessions.list from @deepseek-ai/dsh-client-runtime) and fires browser
 * Notification popups on the machine VIEWING the Web UI — which is what you
 * want when the dsh server runs on a remote box and the host-side desktop
 * notifications would fire where nobody sees them.
 *
 *   - a session finishes (running true→false with nothing pending)  → "Agent finished"
 *   - a session starts waiting on you (pendingInteraction appears)  → "Waiting for you"
 *
 * The list also carries subagent rows (`origin: 'subagent'`, `parentId`), so a
 * main session going idle while its delegation tree still runs is NOT a
 * completion — the host half defers those, and this half must agree or the
 * browser shows the intermediate pings the host just suppressed.
 *
 * Configuration: the Web boot manifest carries no per-plugin config
 * (client/modules manifest rows are id/url/rev/inject/immediately/external), so
 * `apply` is called without one and every option below resolves to its default.
 * The reads stay so a config channel, if the platform ever adds one, takes
 * effect without touching this file.
 *
 * Permission is requested on the first user gesture (browsers reject
 * programmatic prompts without one). By default popups show only while the
 * tab is hidden — a visible tab already has your attention.
 */
window.__ModuleLoader__.load({
  id: "dsh-notification",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var inject = ["sessions"];

    function canNotify() {
      return typeof Notification !== "undefined";
    }

    function ensurePermission() {
      // Prompt once, on the first gesture; never block on the result.
      if (!canNotify() || Notification.permission !== "default") return;
      function ask() {
        window.removeEventListener("pointerdown", ask, true);
        window.removeEventListener("keydown", ask, true);
        try { Notification.requestPermission().catch(function () {}); } catch (e) {}
      }
      window.addEventListener("pointerdown", ask, true);
      window.addEventListener("keydown", ask, true);
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + "ms";
      var s = Math.round(ms / 1000);
      if (s < 60) return s + "s";
      return Math.floor(s / 60) + "m " + (s % 60) + "s";
    }

    function apply(ctx, config) {
      var cfg = config || {};
      if (cfg.browser === false) return;
      var title = typeof cfg.title === "string" && cfg.title ? cfg.title : "DeepSeek Harness";
      var notifyOnIdle = cfg.notifyOnIdle !== false;
      var notifyOnApproval = cfg.notifyOnApproval !== false;
      var onlyWhenHidden = cfg.browserOnlyWhenHidden !== false;
      var minTurnMs = typeof cfg.minTurnDurationMs === "number" ? cfg.minTurnDurationMs : 5000;

      if (!canNotify()) return;
      ensurePermission();

      function show(body) {
        if (Notification.permission !== "granted") return;
        if (onlyWhenHidden && document.visibilityState === "visible") return;
        try {
          var n = new Notification(title, { body: body, tag: "dsh-notification" });
          n.onclick = function () {
            try { window.focus(); } catch (e) {}
            n.close();
          };
        } catch (e) {}
      }

      var sessions = ctx.get("sessions");
      if (!sessions || !sessions.list) return;
      var list = sessions.list;

      // sessionId -> { pending, running, runningSince, awaitingTree }
      var prev = new Map();
      function snapshotRow(row) {
        return { pending: row.pendingInteraction, running: !!row.running, runningSince: 0, awaitingTree: false };
      }
      function seed() {
        prev.clear();
        var snap = list.getSnapshot();
        var ids = snap.ids || [];
        for (var i = 0; i < ids.length; i++) {
          var row = snap.byId[ids[i]];
          if (row) prev.set(ids[i], snapshotRow(row));
        }
      }
      seed();

      /**
       * Walk each row's parentId chain up to its main session and collect the
       * main sessions that still have a running descendant. Subagent rows live
       * in `byId` only (`ids` is host-list membership), so this walks the whole
       * map. A main session going idle while this set names it is delegating,
       * not finished.
       */
      function busyRoots(snap) {
        var busy = {};
        var byId = snap.byId || {};
        for (var childId in byId) {
          if (!Object.prototype.hasOwnProperty.call(byId, childId)) continue;
          var row = byId[childId];
          if (!row || !row.running) continue;
          var cursor = row;
          var guard = 0;
          while (cursor && cursor.parentId !== undefined && guard++ < 64) {
            var next = byId[cursor.parentId];
            if (!next) break;
            cursor = next;
          }
          if (cursor && cursor.parentId === undefined && cursor.id !== undefined) busy[cursor.id] = true;
        }
        return busy;
      }

      function completionBody(runningSince) {
        var elapsed = runningSince ? Date.now() - runningSince : null;
        if (elapsed === null) return "Agent finished";
        return "Agent finished — " + formatDuration(elapsed);
      }

      var unsub = list.subscribe(function () {
        var snap = list.getSnapshot();
        var ids = snap.ids || [];
        var busy = busyRoots(snap);
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          var row = snap.byId[id];
          if (!row) continue;
          if (row.origin === "subagent") continue;
          var p = prev.get(id);
          if (!p) {
            prev.set(id, snapshotRow(row));
            continue;
          }
          // Track when a run started so short turns stay quiet, mirroring
          // the host side's minTurnDurationMs gate.
          if (!p.running && row.running) {
            p.runningSince = Date.now();
            p.awaitingTree = false;
          }
          // Waiting on the user. NOTE: `pendingInteraction` is not a field of
          // the client session-list row — it lives on ctx.uiSession.sessionStatus
          // (`SessionStatus`). This branch therefore never fires today; wiring it
          // up needs the uiSession service, which this bundle does not inject.
          if (notifyOnApproval && p.pending === undefined && row.pendingInteraction !== undefined) {
            var kind = typeof row.pendingInteraction === "string" ? row.pendingInteraction : "input";
            show("Waiting for you — " + kind);
          }
          // Turn finished: running flipped off with nothing pending. A main
          // session that goes idle while its tree still works is delegating —
          // remember it and report once the last descendant settles, so the
          // pings the host suppressed are not silently dropped either.
          if (notifyOnIdle && p.running && !row.running && row.pendingInteraction === undefined) {
            p.awaitingTree = true;
          }
          if (notifyOnIdle && p.awaitingTree && !row.running && !busy[id]
            && row.pendingInteraction === undefined) {
            var elapsed = p.runningSince ? Date.now() - p.runningSince : null;
            if (elapsed === null || elapsed >= minTurnMs) {
              show(completionBody(p.runningSince));
            }
            p.awaitingTree = false;
            p.runningSince = 0;
          }
          p.pending = row.pendingInteraction;
          p.running = !!row.running;
          prev.set(id, p);
        }
      });

      ctx.effect(function () {
        return function () { unsub(); };
      }, "dsh-notification: session watch");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
