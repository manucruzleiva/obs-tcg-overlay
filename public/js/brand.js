/**
 * The logo in the corner of the control panel and the sign-in page. A picture that does not arrive (an old copy kept by the
 * browser, a hiccup of the connection while the app starts) stays broken for as long as the page is open, so this tries once more
 * under a new address, and after that draws a mark of its own: the corner never shows the broken-picture icon.
 */
(function () {
  const MARK = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#98a5ff"/><stop offset="1" stop-color="#5b6bd8"/></linearGradient></defs>'
    + '<rect x="8" y="3" width="48" height="58" rx="9" fill="url(#g)"/>'
    + '<circle cx="32" cy="32" r="13" fill="none" stroke="#fff" stroke-width="5"/>'
    + '<circle cx="32" cy="32" r="4" fill="#fff"/></svg>'
  )}`;

  // A picture that fails sends "error" to itself only (it does not bubble), so listen for it on the way down
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains('brand-logo')) return;
    if (!image.dataset.tried) {
      image.dataset.tried = '1';
      image.src = `/logo.gif?retry=${Date.now()}`;
    } else if (!image.dataset.drawn) {
      image.dataset.drawn = '1';
      image.src = MARK;
    }
  }, true);
}());
