/* Omniweave 홈페이지 공통 스크립트 (외부 의존성 없음)
   - config.json을 읽어 버전·다운로드 링크·공개 여부를 페이지에 반영합니다.
   - config.json을 못 읽으면(파일로 열었거나 오류) HTML에 적힌 기본값("곧 공개")이 그대로 남습니다. */
(function () {
  'use strict';

  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var OS_LABEL = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
  var OS_FILE = { win: 'winSetup', mac: 'macDmg', linux: 'linuxAppImage' };
  var ROOT = document.documentElement.getAttribute('data-root') || '';
  // 페이지에 들어 있는 언어별 문구(build-i18n.mjs가 넣음). 없으면 한국어 기본값.
  var T = { soon: '곧 공개', preparing: '준비 중', platformsBtn: '플랫폼별 파일 보기', mobileMsg: '', unknownMsg: '',
    dlFor: '{os}용 다운로드', installerSuffix: '', experimentalBuild: '', soonFor: '{os}용 · 곧 공개', prepFor: '{os}용 · 준비 중',
    notAvailable: '', firstRelease: '', copied: '복사됨', locale: 'ko-KR' };
  try { var tj = document.getElementById('i18n'); if (tj) { var o = JSON.parse(tj.textContent); for (var k in o) T[k] = o[k]; } } catch (e) { /* 기본값 */ }
  window.OW_T = T;
  function fmt(s, m) { return String(s).replace(/\{(\w+)\}/g, function (_, k) { return m[k] !== undefined ? m[k] : ''; }); }

  function detectOS() {
    var uad = navigator.userAgentData, p = (uad && uad.platform) || navigator.platform || '', ua = navigator.userAgent || '';
    if (/android|iphone|ipad|ipod/i.test(ua) || (uad && uad.mobile)) return 'mobile';
    if (/win/i.test(p) || /windows/i.test(ua)) return 'win';
    if (/mac/i.test(p) || /mac os x/i.test(ua)) return (navigator.maxTouchPoints > 1 ? 'mobile' : 'mac');
    if (/linux|x11|cros/i.test(p + ' ' + ua)) return 'linux';
    return 'unknown';
  }

  function isHttp(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

  function fileInfo(c, key) {
    var f = c.files && c.files[key];
    if (!f) return null;
    var name = String(f.name || '').split('{version}').join(c.version || '');
    var url = isHttp(name) ? name : (isHttp(c.downloadBase) ? c.downloadBase.split('{version}').join(c.version || '') + name : '');
    return { name: name.replace(/^.*\//, ''), url: url, enabled: f.enabled !== false, experimental: !!f.experimental };
  }

  function apply(c) {
    var released = !!c.released;
    document.documentElement.setAttribute('data-released', released ? 'yes' : 'no');

    $$('[data-cfg]').forEach(function (el) {
      var k = el.getAttribute('data-cfg'), v = c[k];
      if (k === 'releaseDate' && v) { var d = new Date(v); if (!isNaN(d)) v = d.toLocaleDateString(T.locale); }
      if (v !== undefined && v !== null && v !== '') el.textContent = String(v);
    });
    $$('[data-when]').forEach(function (el) {
      var w = el.getAttribute('data-when'), show =
        w === 'released' ? released : w === 'unreleased' ? !released :
        w === 'repo' ? !!c.repoPublic : w === 'no-repo' ? !c.repoPublic :
        w === 'autoupdate' ? !!c.autoUpdate : w === 'no-autoupdate' ? !c.autoUpdate :
        w === 'signed' ? !!c.codeSigned : w === 'unsigned' ? !c.codeSigned :
        w === 'demo' ? !!c.demoPublic : w === 'no-demo' ? !c.demoPublic :
        w === 'dated' ? !!c.releaseDate : true;
      el.hidden = !show;
    });

    // 저장소 링크: 공개 전에는 비활성 + 대체 문구
    $$('[data-repo]').forEach(function (a) {
      var path = a.getAttribute('data-repo') || '';
      if (c.repoPublic && isHttp(c.repoUrl)) {
        a.href = c.repoUrl.replace(/\/$/, '') + path;
        a.removeAttribute('aria-disabled'); a.classList.remove('off');
        if (a.dataset.onText) a.querySelector('.t').textContent = a.dataset.onText;
      } else {
        a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.classList.add('off');
        if (a.dataset.offText) a.querySelector('.t').textContent = a.dataset.offText;
      }
    });
    // 브라우저 데모 링크: demoPublic이 true일 때만 보이고, demoUrl(기본 app/?demo)로 연결
    $$('[data-demo]').forEach(function (a) {
      var u = String(c.demoUrl || 'app/?demo');
      if (c.demoPublic) { a.href = isHttp(u) || u.charAt(0) === '/' ? u : ROOT + u; a.hidden = false; }
      else { a.removeAttribute('href'); a.hidden = true; }
    });
    $$('[data-release-page]').forEach(function (a) {
      if (released && c.repoPublic && isHttp(c.releasePageUrl)) { a.href = c.releasePageUrl; a.hidden = false; }
      else { a.hidden = true; }
    });

    // 파일 버튼
    $$('[data-dl]').forEach(function (a) {
      var f = fileInfo(c, a.getAttribute('data-dl')), ok = released && f && f.enabled && f.url;
      var label = a.querySelector('.t');
      $$('[data-fname="' + a.getAttribute('data-dl') + '"]').forEach(function (n) { if (f && f.name) n.textContent = f.name; });
      if (ok) {
        a.href = f.url; a.removeAttribute('aria-disabled'); a.classList.remove('off');
        if (label && a.dataset.onText) label.textContent = a.dataset.onText;
      } else {
        a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.classList.add('off');
        if (label) label.textContent = (released && f && !f.enabled) ? T.preparing : (a.dataset.offText || T.soon);
      }
    });

    // 랜딩의 다운로드 CTA(항상 download.html로) 문구
    $$('[data-cta]').forEach(function (a) {
      var t = a.querySelector('.t'); if (!t) return;
      t.textContent = released ? (a.dataset.onText || t.textContent) : (a.dataset.offText || t.textContent);
    });

    // 체크섬 예시 안의 파일 이름
    $$('[data-ver]').forEach(function (el) { el.textContent = c.version || el.textContent; });

    // 스크린샷: config.json의 screenshots.<이름>에 경로가 있으면 자리표시자 대신 표시
    var shots = c.screenshots || {};
    $$('[data-shot]').forEach(function (body) {
      var src = shots[body.getAttribute('data-shot')];
      if (!src || body.querySelector('img')) return;
      var img = new Image();
      img.alt = body.getAttribute('data-alt') || '';
      img.decoding = 'async';
      img.onload = function () { body.classList.add('has-img'); };
      img.onerror = function () { img.hidden = true; };
      img.src = isHttp(src) || src.charAt(0) === '/' ? src : ROOT + src;
      body.insertBefore(img, body.firstChild);
    });

    recommend(c);
  }

  // download.html: 이 기기에 맞는 버튼 하나를 추천
  function recommend(c) {
    var btn = document.getElementById('rec-btn'); if (!btn) return;
    var os = detectOS(), sub = document.getElementById('rec-sub'), label = btn.querySelector('.t');
    $$('.plat').forEach(function (p) { p.classList.toggle('rec', p.getAttribute('data-os') === os); });
    $$('.plat .you').forEach(function (y) { y.hidden = y.closest('.plat').getAttribute('data-os') !== os; });
    if (os === 'mobile' || os === 'unknown') {
      btn.href = '#platforms'; btn.removeAttribute('aria-disabled'); btn.classList.remove('off');
      label.textContent = T.platformsBtn;
      if (sub) sub.textContent = os === 'mobile' ? T.mobileMsg : T.unknownMsg;
      return;
    }
    var f = fileInfo(c, OS_FILE[os]), ok = c.released && f && f.enabled && f.url;
    if (ok) {
      btn.href = f.url; btn.removeAttribute('aria-disabled'); btn.classList.remove('off');
      label.textContent = fmt(T.dlFor, { os: OS_LABEL[os] }) + (os === 'win' ? T.installerSuffix : '');
      if (sub) sub.textContent = (c.version ? 'v' + c.version + ' · ' : '') + f.name + (f.experimental ? ' · ' + T.experimentalBuild : '');
    } else {
      btn.removeAttribute('href'); btn.setAttribute('aria-disabled', 'true'); btn.classList.add('off');
      label.textContent = fmt(c.released ? T.prepFor : T.soonFor, { os: OS_LABEL[os] });
      if (sub) sub.textContent = c.released ? T.notAvailable : fmt(T.firstRelease, { v: c.version || '0.1.0' });
    }
  }

  // 복사 버튼
  $$('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var src = document.getElementById(b.getAttribute('data-copy')); if (!src) return;
      var text = src.innerText.split('\n').filter(function (l) { return l.trim() && !/^\s*#/.test(l); }).join('\n');
      var done = function () { var o = b.textContent; b.textContent = T.copied; setTimeout(function () { b.textContent = o; }, 1400); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () {});
      else { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) {} t.remove(); }
    });
  });

  // 탭(체크섬 OS별 명령)
  $$('[role="tablist"]').forEach(function (list) {
    var tabs = $$('[role="tab"]', list);
    function pick(t, focus) {
      tabs.forEach(function (x) {
        var on = x === t; x.setAttribute('aria-selected', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) t.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { pick(t); });
      t.addEventListener('keydown', function (e) {
        var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
        if (j < 0 && e.key !== 'ArrowLeft') return;
        e.preventDefault(); pick(tabs[(j + tabs.length) % tabs.length], true);
      });
    });
    var os = detectOS(), pre = tabs.filter(function (t) { return t.getAttribute('data-os') === os; })[0];
    if (pre) pick(pre);
  });

  // 기본값으로 먼저 한 번 그린 뒤, config.json으로 덮어씁니다.
  var defaults = { released: false, repoPublic: false, autoUpdate: false, codeSigned: false };
  apply(defaults);
  if (location.protocol === 'file:') return;
  fetch(ROOT + 'config.json?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (c) { apply(Object.assign({}, defaults, c)); })
    .catch(function () { /* 기본값 유지 */ });
})();
