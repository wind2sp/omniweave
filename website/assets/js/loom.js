/* Loom 설명용 인터랙티브 그림 (index.html 전용)
   왼쪽 8×5 = 40개 화면 타일, 오른쪽은 타일이 풀려 세 가닥 실(보라·청록·코랄)로 엮이는 모습.
   격자를 문지르면 닿은 타일만 "다시 그림", 실행 취소하면 예전 키가 다시 나타나 "캐시 적중".
   실제 엔진 동작을 단순화한 그림이며 측정값이 아닙니다. prefers-reduced-motion이면 움직이지 않습니다. */
(function () {
  'use strict';
  var cv = document.getElementById('loom-canvas');
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext('2d');
  var stat = document.getElementById('loom-stat');
  var btnPaint = document.getElementById('loom-paint');
  var btnUndo = document.getElementById('loom-undo');
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mqLight = window.matchMedia('(prefers-color-scheme: light)');
  var reduce = mqReduce.matches;

  var COLS = 8, ROWS = 5, N = COLS * ROWS;
  var W = 0, H = 0, dpr = 1, gx = 0, gy = 0, ts = 0;
  var C = {};
  var tiles = [], history = [], stroke = null, particles = [], seed = 7;
  var visible = true, raf = 0, phase = 0, last = 0;

  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function readColors() {
    var s = getComputedStyle(document.documentElement);
    var g = function (n, d) { return (s.getPropertyValue(n) || d).trim(); };
    C = {
      th: [g('--violet', '#7c5cff'), g('--teal', '#22d3c5'), g('--coral', '#ff6b81')],
      bg: g('--bg-0', '#0c0d11'), tile: g('--bg-3', '#1e2027'), line: g('--line-2', '#33363f'),
      miss: g('--coral', '#ff6b81'), hit: g('--teal', '#22d3c5'), light: mqLight.matches
    };
  }
  function makeNoise() { var a = []; for (var i = 0; i < 16; i++) a.push(rnd()); return a; }

  // 타일 초기 상태: 대부분 빈 바탕, 몇 칸은 미리 칠해 둔 그림
  for (var i = 0; i < N; i++) tiles.push({ c: -1, noise: makeNoise(), flash: null });
  [[1, 1, 0], [2, 1, 0], [2, 2, 0], [5, 3, 1], [6, 3, 1], [6, 2, 2], [3, 3, 2]].forEach(function (p) { tiles[p[1] * COLS + p[0]].c = p[2]; });

  function layout() {
    var r = cv.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(280, r.width); H = W * 10 / 16;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var pad = W * 0.05;
    ts = Math.min((W * 0.52) / COLS, (H - pad * 2) / ROWS);
    gx = pad; gy = (H - ts * ROWS) / 2;
    draw(performance.now());
  }

  // 세 가닥 실: 격자 오른쪽 가장자리의 2·3·4번째 줄에서 출발해 꼬이며 오른쪽 끝으로
  function threadY(k, x) {
    var x0 = gx + ts * COLS, x1 = W - W * 0.03;
    var u = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
    var startY = gy + ts * (1.5 + k), mid = H / 2;
    var ease = 1 - Math.pow(1 - Math.min(1, u * 2.4), 2);
    var amp = H * 0.2 * ease;
    var y = startY + (mid - startY) * ease + amp * Math.sin(u * Math.PI * 3.2 - phase + k * 2.094);
    return y;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

    // threads (뒤)
    var x0 = gx + ts * COLS - 2, x1 = W - W * 0.03;
    for (var k = 0; k < 3; k++) {
      var grad = ctx.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, hexA(C.th[k], 0.15)); grad.addColorStop(0.25, hexA(C.th[k], 0.95)); grad.addColorStop(1, hexA(C.th[k], 1));
      ctx.strokeStyle = grad; ctx.lineWidth = Math.max(3, ts * 0.11); ctx.lineCap = 'round';
      ctx.beginPath();
      for (var x = x0; x <= x1; x += 3) { var y = threadY(k, x); if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }

    // particles: 오른쪽 열에서 떨어져 나가 실이 되는 작은 픽셀
    particles.forEach(function (p) {
      var x = x0 + (x1 - x0) * p.u * 0.6, y = threadY(p.k, x) + p.off * (1 - p.u);
      var s = ts * 0.22 * (1 - p.u);
      ctx.fillStyle = hexA(C.th[p.k], 0.9 * (1 - p.u));
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    });

    // tiles
    var gap = Math.max(2, ts * 0.06), r = Math.max(2, ts * 0.12);
    for (var i = 0; i < N; i++) {
      var t = tiles[i], cx = gx + (i % COLS) * ts, cy = gy + Math.floor(i / COLS) * ts;
      var x = cx + gap / 2, y = cy + gap / 2, w = ts - gap;
      roundRect(x, y, w, w, r); ctx.fillStyle = C.tile; ctx.fill();
      if (t.c >= 0) {
        ctx.save(); roundRect(x, y, w, w, r); ctx.clip();
        var q = w / 4;
        for (var j = 0; j < 16; j++) {
          ctx.fillStyle = hexA(C.th[t.c], 0.35 + t.noise[j] * 0.55);
          ctx.fillRect(x + (j % 4) * q, y + Math.floor(j / 4) * q, q + 0.5, q + 0.5);
        }
        ctx.restore();
      }
      if (t.flash) {
        var age = reduce ? 0 : (now - t.flash.t) / 1100;
        if (age >= 1) { t.flash = null; }
        else {
          roundRect(x + 1, y + 1, w - 2, w - 2, r);
          ctx.lineWidth = Math.max(2, ts * 0.07);
          ctx.strokeStyle = hexA(t.flash.type === 'miss' ? C.miss : C.hit, 1 - age * 0.85);
          ctx.stroke();
        }
      }
    }
    // 격자 테두리
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    roundRect(gx - 4, gy - 4, ts * COLS + 8, ts * ROWS + 8, r + 3); ctx.stroke();
  }

  function hexA(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return hex;
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
  }

  function tick(now) {
    raf = 0;
    var dt = last ? Math.min(64, now - last) : 16; last = now;
    phase += dt * 0.0009;
    if (Math.random() < dt * 0.004 && particles.length < 14) particles.push({ k: Math.floor(Math.random() * 3), u: 0, off: (Math.random() - 0.5) * ts });
    particles.forEach(function (p) { p.u += dt * 0.0006; });
    particles = particles.filter(function (p) { return p.u < 1; });
    draw(now);
    schedule();
  }
  function schedule() { if (!reduce && visible && !document.hidden && !raf) raf = requestAnimationFrame(tick); }
  function redraw() { if (reduce || !visible) draw(performance.now()); }

  // ── 상호작용 ──
  var brush = 0;
  function tileAt(e) {
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    var c = Math.floor((x - gx) / ts), rr = Math.floor((y - gy) / ts);
    return (c >= 0 && c < COLS && rr >= 0 && rr < ROWS) ? rr * COLS + c : -1;
  }
  function touch(i) {
    if (i < 0 || !stroke || stroke.touched[i] !== undefined) return;
    var t = tiles[i];
    stroke.touched[i] = { c: t.c, noise: t.noise };
    t.c = brush; t.noise = makeNoise(); t.flash = { type: 'miss', t: performance.now() };
    stroke.n++;
    redraw();
  }
  function clearFlashes() { tiles.forEach(function (t) { t.flash = null; }); }
  function beginStroke() {
    clearFlashes();
    stroke = { touched: {}, n: 0 };
    brush = (brush + 1) % 3;
  }
  function endStroke() {
    if (!stroke) return;
    if (stroke.n > 0) {
      history.push(stroke); if (history.length > 30) history.shift();
      say(tr('loomStroke', '이번 획: 다시 그린 화면 타일 {n}개 · 그대로 재사용 {r}개 (전체 {t}개)', { n: stroke.n, r: N - stroke.n, t: N }));
    }
    stroke = null; btnUndo.disabled = history.length === 0; btnUndo.setAttribute('aria-disabled', btnUndo.disabled ? 'true' : 'false');
  }
  function say(html) { stat.innerHTML = html; }
  // 문구는 페이지의 #i18n(번역 파일에서 생성, 신뢰된 내용)에서 가져옵니다.
  function tr(key, fallback, m) {
    var T = window.OW_T || {}, s = T[key] || fallback;
    return String(s).replace(/\{(\w+)\}/g, function (_, k) { return m[k] !== undefined ? String(m[k]) : ''; });
  }

  cv.addEventListener('pointerdown', function (e) {
    var i = tileAt(e); if (i < 0) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    beginStroke(); touch(i);
  });
  cv.addEventListener('pointermove', function (e) { if (stroke) touch(tileAt(e)); });
  cv.addEventListener('pointerup', endStroke);
  cv.addEventListener('pointercancel', endStroke);

  btnPaint.addEventListener('click', function () {
    beginStroke();
    var c = Math.floor(rnd() * (COLS - 3)), r = Math.floor(rnd() * ROWS), len = 2 + Math.floor(rnd() * 3), dr = rnd() < 0.5 ? 0 : (r < ROWS - 2 ? 1 : -1);
    for (var k = 0; k < len; k++) touch(Math.max(0, Math.min(ROWS - 1, r + (dr ? Math.round(k * 0.6) * dr : 0))) * COLS + c + k);
    endStroke();
  });
  btnUndo.addEventListener('click', function () {
    var s = history.pop(); if (!s) return;
    clearFlashes();
    var now = performance.now(), n = 0;
    Object.keys(s.touched).forEach(function (k) { var t = tiles[k], p = s.touched[k]; t.c = p.c; t.noise = p.noise; t.flash = { type: 'hit', t: now }; n++; });
    say(tr('loomUndo', '실행 취소: {n}개 타일이 캐시에서 바로 적중 · 다시 그린 타일 0개', { n: n }));
    btnUndo.disabled = history.length === 0; btnUndo.setAttribute('aria-disabled', btnUndo.disabled ? 'true' : 'false');
    redraw();
  });

  // ── 수명 관리 ──
  readColors(); layout();
  if ('ResizeObserver' in window) new ResizeObserver(function () { layout(); }).observe(cv);
  else window.addEventListener('resize', layout);
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; schedule(); }).observe(cv);
  document.addEventListener('visibilitychange', function () { last = 0; schedule(); });
  var onScheme = function () { readColors(); draw(performance.now()); };
  var onMotion = function () { reduce = mqReduce.matches; particles = []; draw(performance.now()); schedule(); };
  if (mqLight.addEventListener) { mqLight.addEventListener('change', onScheme); mqReduce.addEventListener('change', onMotion); }
  schedule();
})();
