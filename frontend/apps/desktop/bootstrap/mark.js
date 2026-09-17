/**
 * Play the Companion Memory mark in place of a spinner while the stack starts.
 *
 * Vendored lottie-web rather than a CDN on purpose: this page runs under the
 * app's own CSP (`script-src 'self'`), so a remote script would be blocked.
 * If anything about the animation fails to load, the element is simply left
 * empty and the status text below it still tells the user what is happening —
 * a loading screen must never be the thing that breaks.
 */
(function () {
  var host = document.getElementById('spinner');

  if (!host || !window.lottie) {
    return;
  }

  fetch('memory-mark.lottie.json')
    .then(function (response) {
      return response.ok ? response.json() : Promise.reject(new Error(String(response.status)));
    })
    .then(function (animationData) {
      window.lottie.loadAnimation({
        container: host,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: animationData,
      });
    })
    .catch(function () {
      /* no mark; the status line carries the message on its own */
    });
})();
