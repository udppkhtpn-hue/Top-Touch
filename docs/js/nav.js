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

/* Brand ticker — a running marquee beneath the nav ribbon. Injected on every
   page that loads nav.js EXCEPT the Rujuk Kes referral form, which stays
   motion-free (its ~60-second critical path allows only the serology ring).
   Decorative, so the whole bar is aria-hidden. */
(function () {
  'use strict';
  if (/(^|\/)refer\.html($|[?#])/.test(location.pathname)) return;
  var mh = document.querySelector('.masthead');
  if (!mh || document.querySelector('.brand-ticker')) return;

  var caption = 'TISSUE & ORGAN PROCUREMENT TEAM   •   ' +
    'Hospital Tengku Permaisuri Norashikin Kajang   •   ' +
    'Menyelamatkan Nyawa, Menyempurnakan Janji   •   ';
  var item = '<span class="brand-ticker__item">' + caption + '</span>';
  var seq = '';
  for (var i = 0; i < 4; i++) seq += item; // repeat to fill wide screens

  var bar = document.createElement('div');
  bar.className = 'brand-ticker';
  bar.setAttribute('aria-hidden', 'true');
  // Two identical sequences so the translateX(-50%) loop is seamless.
  bar.innerHTML = '<div class="brand-ticker__track">' + seq + seq + '</div>';
  mh.insertAdjacentElement('afterend', bar);
})();
