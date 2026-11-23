/*
 * Token auth (server/token-auth.js): any same-origin /api/ call answered 401
 * means this browser has no valid login cookie — go to /login and come back.
 * Classic script loaded before every module so all fetch() callers are covered.
 */
(function () {
  var origFetch = window.fetch
  if (!origFetch) return
  var redirecting = false
  window.fetch = function () {
    return origFetch.apply(this, arguments).then(function (res) {
      if (res.status === 401 && !redirecting) {
        var u = new URL(res.url || '', location.href)
        if (u.origin === location.origin && u.pathname.indexOf('/api/') === 0) {
          redirecting = true
          location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash))
        }
      }
      return res
    })
  }
})()
