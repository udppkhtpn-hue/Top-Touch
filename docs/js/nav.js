/* Top-ribbon navigation — progressive enhancement.
   Without JS the links render as a stacked list under the ribbon (still usable).
   With JS they collapse behind a hamburger on phones. */
(function () {
  'use strict';
  var mh = document.querySelector('.masthead');
  if (!mh) return;
  var btn = mh.querySelector('.nav-toggle');
  var nav = mh.querySelector('.site-nav');
  if (!btn || !nav) return;

  mh.classList.add('nav-ready');

  function setOpen(open) {
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    setOpen(btn.getAttribute('aria-expanded') !== 'true');
  });

  // Close after tapping a real link.
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) setOpen(false);
  });

  // Close on outside tap or Escape.
  document.addEventListener('click', function (e) {
    if (nav.classList.contains('open') && !mh.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setOpen(false);
  });
})();
