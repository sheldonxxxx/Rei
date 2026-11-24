// What the service worker does with a push and with a click on a notification. A plain script (loaded by sw.js with
// importScripts) that puts its functions on `reiPush`, so the tests can load it and hand it a fake worker scope.
// A notification only ever opens the app at a place; nothing can be decided from it.
((root) => {
  var FALLBACK_TITLE = "Rei";

  /** The payload a push carries: { event, sessionId, messageId?, title, body } (and a deprecated `path`). Anything else still shows something. */
  function parsePayload(event) {
    var data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch (_) {
      try {
        data = { body: event.data.text() };
      } catch (__) {
        data = {};
      }
    }
    return data && typeof data === "object" ? data : {};
  }

  function str(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  /**
   * The app route a payload points at, built from its ids: "/s/<sessionId>?m=<messageId>", or "/" with no session. A
   * payload from an older server with only a hash `path` ("#/s/<id>") gets that path's route form.
   */
  function routeOf(p) {
    var sessionId = str(p.sessionId, 100);
    var messageId = str(p.messageId, 200);
    if (sessionId)
      return "/s/" + encodeURIComponent(sessionId) + (messageId ? "?m=" + encodeURIComponent(messageId) : "");
    var path = str(p.path, 200);
    return path.indexOf("#/") === 0 ? path.slice(1) : "/";
  }

  /** Shows the notification. One per chat: a newer one for the same session replaces the older and alerts again. */
  function onPush(event, sw) {
    var p = parsePayload(event);
    var tag = str(p.sessionId, 100) ? "session:" + str(p.sessionId, 100) : undefined;
    var options = { body: str(p.body, 300), data: { path: routeOf(p) } };
    if (tag) {
      options.tag = tag;
      options.renotify = true;
    }
    // A push that shows nothing would make the browser warn the user, so something is always shown.
    event.waitUntil(sw.registration.showNotification(str(p.title, 100) || FALLBACK_TITLE, options));
  }

  /** Focuses a window of the app and moves it to the notification's place, or opens one. */
  function onNotificationClick(event, sw) {
    event.notification.close();
    var raw =
      event.notification.data && typeof event.notification.data.path === "string" ? event.notification.data.path : "/";
    // A notification shown by an older worker holds a hash route ("#/s/<id>").
    var path = raw.indexOf("#/") === 0 ? raw.slice(1) : raw.charAt(0) === "/" && raw.charAt(1) !== "/" ? raw : "/";
    var target = sw.location.origin + path;
    event.waitUntil(
      sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
        var mine = windows.filter((w) => w.url.indexOf(sw.location.origin + "/") === 0);
        var client = mine.filter((w) => w.focused)[0] || mine[0];
        if (!client) return sw.clients.openWindow(target);
        return Promise.resolve(client.focus()).then((focused) => {
          var win = focused || client;
          if (typeof win.navigate === "function") return win.navigate(target);
          win.postMessage({ type: "navigate", path: path });
        });
      }),
    );
  }

  root.reiPush = {
    onPush: onPush,
    onNotificationClick: onNotificationClick,
    parsePayload: parsePayload,
    routeOf: routeOf,
  };
})(typeof self !== "undefined" ? self : globalThis);
