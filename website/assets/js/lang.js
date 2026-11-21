/* 언어 선택 (head에서 바로 실행, 아주 작게 유지)
   - 루트(한국어) 페이지에 "처음" 들어온 방문자만 브라우저 언어(navigator.languages)에 맞는 페이지로 한 번 보냅니다.
     ko → 그대로, en·ja·zh → /en/ /ja/ /zh/, 그 밖의 언어 → /en/.
   - 메뉴에서 언어를 고르면 기억하고(localStorage), 그 뒤로는 자동으로 옮기지 않습니다.
   - 검색엔진·미리보기 봇, 사이트 안에서 이동해 온 경우에는 옮기지 않습니다. */
(function () {
  'use strict';
  var d = document.documentElement;
  function get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 저장 불가: 무시 */ } }

  document.addEventListener('click', function (e) {
    var t = e.target, a = t && t.closest ? t.closest('[data-setlang]') : null;
    if (a) set('ow-lang', a.getAttribute('data-setlang'));
    // 언어 메뉴 바깥을 누르면 닫기
    var open = document.querySelector('details.lang[open]');
    if (open && !(t && t.closest && t.closest('details.lang'))) open.removeAttribute('open');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('details.lang[open]');
    if (open) { open.removeAttribute('open'); var s = open.querySelector('summary'); if (s) s.focus(); }
  });

  if (d.getAttribute('data-lang') !== 'ko') return;                    // 루트(기본 언어) 페이지에서만
  if (/bot|crawl|spider|slurp|preview|scrap|facebookexternalhit|embedly|lighthouse|headless/i.test(navigator.userAgent || '')) return;
  if (get('ow-lang') || get('ow-lang-auto')) return;                   // 이미 골랐거나 한 번 정했으면 강제하지 않음
  try { if (document.referrer && new URL(document.referrer).origin === location.origin) return; } catch (e) { /* 무시 */ }
  set('ow-lang-auto', '1');

  var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  var pick = 'en';
  for (var i = 0; i < list.length; i++) {
    var l = String(list[i]).toLowerCase();
    if (l.indexOf('ko') === 0) { pick = 'ko'; break; }
    if (l.indexOf('ja') === 0) { pick = 'ja'; break; }
    if (l.indexOf('zh') === 0) { pick = 'zh'; break; }
    if (l.indexOf('en') === 0) { pick = 'en'; break; }
  }
  if (pick === 'ko') return;
  var page = d.getAttribute('data-page') === 'download' ? 'download.html' : '';
  location.replace((d.getAttribute('data-root') || '') + pick + '/' + page + location.hash);
})();
