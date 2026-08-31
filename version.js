// Single source of truth for the app's version — bump this string on every
// deploy-worthy change to js/*, data/*, index.html, css/*, or sw.js itself.
// Two things read it:
//   1. The footer in index.html displays it, so you can check whether the
//      copy you're looking at is actually current (see js/app.js).
//   2. sw.js derives its cache name from it (`importScripts('version.js')`),
//      so bumping this is also what forces the installed PWA to fetch fresh
//      copies of everything instead of serving an old cached version
//      forever — a version bump *is* the cache-bust, they can't drift apart
//      into "the version number changed but the cache didn't" or vice versa.
// A plain script (not a module) so it loads identically via <script src>
// on the page and via importScripts() inside the service worker — `self`
// is the shared global in both contexts.
self.APP_VERSION = '2026.08.31.1';
