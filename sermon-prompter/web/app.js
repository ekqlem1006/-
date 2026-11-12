// 설교 프롬프터 — 태블릿/컴퓨터 공용 화면
(function () {
  'use strict';
  var SP = window.SP;
  function $(id) { return document.getElementById(id); }
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch (e) { /* 사생활 보호 모드 등 */ }
    return v;
  }

  // ---- 연결 정보 (QR 주소에 들어 있는 키를 기억해 둔다) ----
  var qs = new URLSearchParams(location.search);
  var K = qs.get('k') || store('sp_k') || '';
  if (qs.get('k')) store('sp_k', K);
  var IS_LOCAL = ['127.0.0.1', 'localhost', '[::1]'].indexOf(location.hostname) >= 0;
  var CID = store('sp_cid');
  if (!CID) CID = store('sp_cid', 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
  var NAME = (function () {
    var ua = navigator.userAgent, n = 'PC';
    if (IS_LOCAL) n = '예배용 컴퓨터';
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) n = '아이패드';
    else if (/iPhone/.test(ua)) n = '아이폰';
    else if (/SM-|SAMSUNG|Samsung/.test(ua)) n = /Mobile/.test(ua) ? '갤럭시' : '갤럭시 탭';
    else if (/Android/.test(ua)) n = '안드로이드 기기';
    return n + ' ' + CID.slice(1, 4).toUpperCase();
  })();

  var S = null;            // 컴퓨터가 알려 준 최신 상태
  var docs = [], docsLoaded = false, docsVerSeen = -1;
  var doc = null;          // 지금 편집/사용 중인 준비 내용
  var dirty = false, saveTimer = null, saving = false, saveFailed = false;
  var tab = null, cur = 0, connected = false, lastMsg = 0, lastTry = 0, es = null;
  var preachSig = '', prepSig = '', hadControl = false;
  var fontSize = parseInt(store('sp_fs') || '26', 10);

  function withK(path) { return path + (path.indexOf('?') < 0 ? '?' : '&') + 'k=' + encodeURIComponent(K); }

  function api(path, body) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 12000);
    var opt = { signal: ctl.signal, cache: 'no-store' };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers = { 'Content-Type': 'application/json', 'X-SP': '1' };
      opt.body = JSON.stringify(body);
    }
    return fetch(withK(path), opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('오류 ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    }, function () {
      throw new Error('컴퓨터와 연결되지 않았습니다');
    }).finally(function () { clearTimeout(t); });
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  // ---- 연결 유지 ---------------------------------------------------------
  function setConn(on) {
    if (connected === on) return;
    connected = on;
    $('connDot').classList.toggle('off', !on);
    $('connBanner').hidden = on || !S;
    if (!on) $('hostName').textContent = S ? hostLabel() : '컴퓨터에 연결하는 중…';
    updateMarks();
  }

  function connect() {
    lastTry = Date.now();
    if (es) { es.close(); es = null; }
    // 먼저 한 번 상태를 받아 본다. 연결 키가 틀렸으면 여기서 알 수 있다.
    api('/api/state').then(function (st) {
      $('badKey').hidden = true;
      lastMsg = Date.now();
      onState(st);
      setConn(true);
      es = new EventSource(withK('/api/events?cid=' + CID + '&name=' + encodeURIComponent(NAME)));
      es.addEventListener('state', function (e) { lastMsg = Date.now(); setConn(true); onState(JSON.parse(e.data)); });
      es.addEventListener('hb', function () { lastMsg = Date.now(); setConn(true); });
    }).catch(function (e) {
      if (e.status === 401) { showTab('badKey'); }
      setConn(false);
    });
  }

  // 컴퓨터는 2초마다 신호를 보낸다. 6초 넘게 조용하면 끊긴 것으로 보고 다시 연결한다.
  setInterval(function () {
    if (Date.now() - lastMsg > 6000) {
      setConn(false);
      if (Date.now() - lastTry > 3000) connect();
    }
  }, 1000);

  // 태블릿이 잠들었다 깨어나면 곧바로 상태를 다시 확인한다.
  function wake() {
    if (document.visibilityState === 'visible' && Date.now() - lastMsg > 3000) { setConn(false); connect(); }
    requestWakeLock();
  }
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);

  // 화면 꺼짐 방지 (지원하는 브라우저에서만 동작한다)
  var wakeLock = null;
  function requestWakeLock() {
    if (!navigator.wakeLock || document.visibilityState !== 'visible' || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  // ---- 상태 반영 ---------------------------------------------------------
  function mine() { return !!(S && S.control && S.control.cid === CID); }
  function slides() { return (S && S.ppt.slides) || []; }
  function hostLabel() { return S.host.dept ? S.host.dept + ' · ' + S.host.pc : S.host.pc; }

  function onState(st) {
    S = st;
    document.documentElement.style.setProperty('--aspect', String(st.ppt.aspect || 1.7778));
    if (st.docsVer !== docsVerSeen) { docsVerSeen = st.docsVer; loadDocs(); }
    if (hadControl && !mine() && st.control) toast('조작 권한이 ' + st.control.name + ' (으)로 넘어갔습니다', 4000);
    hadControl = mine();
    bindDoc();
    renderAll();
  }

  function loadDocs() {
    api('/api/docs').then(function (r) {
      docs = r.docs || [];
      docsLoaded = true;
      // 다른 기기에서 고친 내용이 있으면 반영한다 (내가 고치는 중이면 내 것이 우선).
      if (doc && !dirty) {
        var same = docs.filter(function (d) { return d.id === doc.id; })[0];
        if (same && same.updatedAt !== doc.updatedAt) doc = clone(same);
      }
      bindDoc();
      if (tab === null) showTab(!IS_LOCAL && doc && doc.sections.length ? 'preach' : 'prep');
      renderAll();
    }).catch(function () { docsVerSeen = -1; });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function blankDoc(path, name) {
    return { id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), pptPath: path || '', pptName: name || '', script: '', sections: [], updatedAt: 0 };
  }
  function hasContent(d) { return !!(d && (d.script.trim() || d.sections.length)); }
  function newest(list) {
    return list.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0] || null;
  }

  // 지금 열린 PPT 에 맞는 저장본을 찾아 연다. 같은 PPT 를 다시 열면 기존 연결이 그대로 나온다.
  function bindDoc() {
    if (!S || !docsLoaded) return;
    var p = S.ppt, want = p.presOpen ? p.presPath : null;
    if (doc && (want === null || doc.pptPath === want)) return;
    var found = want === null ? null : newest(docs.filter(function (d) { return d.pptPath === want; }));
    if (doc && !doc.pptPath && hasContent(doc) && !found) {
      doc.pptPath = want; doc.pptName = p.presName; markDirty(); return;
    }
    if (dirty && doc && hasContent(doc)) {
      // 다른 PPT 로 바뀌기 전에, 고치던 내용을 따로 저장해 둔다.
      var old = clone(doc);
      clearTimeout(saveTimer); dirty = false;
      docs = docs.filter(function (d) { return d.id !== old.id; }).concat([old]);
      api('/api/doc', old).catch(function () {});
    }
    if (want === null) { doc = clone(newest(docs) || blankDoc()); return; }
    if (!found) {
      // 파일 위치만 옮긴 경우: 이름이 같은 저장본을 이어서 쓴다.
      found = newest(docs.filter(function (d) { return d.pptName === p.presName; }));
      if (found) { doc = clone(found); doc.pptPath = want; cur = 0; markDirty(); return; }
    }
    doc = found ? clone(found) : blankDoc(want, p.presName);
    cur = 0;
  }

  function markDirty() {
    dirty = true;
    doc.updatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
    renderSaveState();
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (!doc || !dirty) return;
    if (saving) { saveTimer = setTimeout(saveNow, 300); return; }
    var snap = clone(doc);
    saving = true;
    api('/api/doc', snap).then(function (r) {
      saving = false; saveFailed = false;
      docs = docs.filter(function (d) { return d.id !== snap.id; }).concat([snap]);
      if (r.docsVer) docsVerSeen = Math.max(docsVerSeen, r.docsVer);
      if (doc && doc.id === snap.id && doc.updatedAt === snap.updatedAt) dirty = false;
      else if (dirty) saveTimer = setTimeout(saveNow, 300);
      renderSaveState();
    }).catch(function () {
      saving = false; saveFailed = true;
      saveTimer = setTimeout(saveNow, 3000);
      renderSaveState();
    });
  }
  window.addEventListener('pagehide', function () { if (dirty) saveNow(); });

  function renderSaveState() {
    var el = $('saveState');
    if (!doc || !hasContent(doc)) el.textContent = '아직 저장할 내용이 없습니다';
    else if (saveFailed) el.textContent = '⚠ 저장하지 못했습니다. 다시 시도하는 중…';
    else if (dirty) el.textContent = '저장 중…';
    else el.textContent = '✔ 컴퓨터에 저장됨' + (doc.updatedAt ? ' (' + new Date(doc.updatedAt).toLocaleString('ko-KR') + ')' : '');
  }

  // ---- 연결 확인 ---------------------------------------------------------
  function docMatchesPpt() { return !!(S && doc && S.ppt.presOpen && doc.pptPath === S.ppt.presPath); }
  function resolve(sec) {
    if (!docMatchesPpt()) return { status: sec.slideId ? 'unknown' : 'none', slide: null, suggestion: null };
    return SP.resolveSection(sec, slides());
  }

  // PPT 가 수정되어 번호가 밀렸으면, 화면에 보일 번호·제목 기록을 새로 맞춘다.
  function syncHints() {
    if (!docMatchesPpt()) return;
    var changed = false;
    doc.sections.forEach(function (sec) {
      var r = SP.resolveSection(sec, slides());
      if (r.status === 'ok' && (sec.hintIndex !== r.slide.index || sec.hintTitle !== r.slide.title)) {
        sec.hintIndex = r.slide.index; sec.hintTitle = r.slide.title; changed = true;
      }
    });
    if (changed) markDirty();
  }

  function thumbHTML(slide) {
    if (!slide) return '<div class="thumb">슬라이드 없음</div>';
    return '<div class="thumb"><img loading="lazy" alt="" src="' + withK('/api/thumb?id=' + slide.id + '&v=' + S.ppt.slidesVer) + '"></div>';
  }

  // ---- 화면 전환 ---------------------------------------------------------
  function showTab(t) {
    tab = t;
    ['prep', 'preach', 'badKey'].forEach(function (id) { $(id).hidden = id !== t; });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === t);
    });
    if (t === 'preach') { renderPreach(true); scrollToCur(false); }
    if (t === 'prep') renderPrep(true);
  }
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) showTab(b.dataset.tab);
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-goto-prep]')) showTab('prep');
  });

  function renderAll() {
    if (!S) return;
    syncHints();
    renderHeader();
    if (tab === 'prep') renderPrep(false);
    if (tab === 'preach') renderPreach(false);
    updateMarks();
  }

  function renderHeader() {
    var p = S.ppt;
    $('hostName').textContent = hostLabel();
    $('pptName').textContent = !p.appRunning ? '파워포인트가 꺼져 있음' : !p.presOpen ? '열린 PPT 없음' : p.presName + (p.simulated ? ' (연습용 가상 PPT)' : '');
    var chip = $('liveChip'), cls = 'chip', txt;
    if (!p.appRunning || !p.presOpen) { txt = 'PPT 연결 안 됨'; cls += ' warn'; }
    else if (!p.showRunning) { txt = '슬라이드 쇼 꺼짐'; cls += ' warn'; }
    else if (p.black) { txt = '⬛ 검은 화면 (PPT ' + (p.curIndex || '?') + '번 유지)'; cls += ' black'; }
    else if (!p.curIndex) txt = '쇼 끝 화면';
    else { txt = '● 송출 중 PPT ' + p.curIndex + '번'; cls += ' live'; }
    chip.className = cls; chip.textContent = txt;
  }

  // ---- 준비 화면 ---------------------------------------------------------
  function renderPrep(force) {
    if (!S || !doc) return;
    var p = S.ppt;
    var sig = [doc.id, doc.updatedAt, p.slidesVer, p.presPath, p.presOpen, p.appRunning, docMatchesPpt()].join('|');
    renderSaveState();
    if (!force && sig === prepSig) return;
    prepSig = sig;

    var ta = $('script');
    if (document.activeElement !== ta && ta.value !== doc.script) ta.value = doc.script;

    var info = $('pptInfo');
    info.classList.toggle('bad', !p.presOpen);
    if (!p.appRunning) info.innerHTML = '⚠ 예배용 컴퓨터에서 <b>파워포인트가 실행되어 있지 않습니다.</b> 예배 PPT 를 열면 자동으로 연결됩니다.';
    else if (!p.presOpen) info.innerHTML = '⚠ 파워포인트에 <b>열려 있는 PPT 가 없습니다.</b> 예배 PPT 를 열어 주세요.';
    else info.innerHTML = '연결된 컴퓨터: <b>' + SP.esc(hostLabel()) + '</b><br>연결된 PPT: <b>' + SP.esc(p.presName) + '</b> · 전체 ' + slides().length + '장' +
      (doc.pptPath !== p.presPath && doc.pptName ? '<br><span class="sec-warn">이 준비 내용은 「' + SP.esc(doc.pptName) + '」 용입니다.</span>' : '');

    var secs = doc.sections, linked = 0, missing = 0;
    var html = secs.map(function (sec, i) {
      var r = resolve(sec), warn = '';
      if (r.status === 'ok' || r.status === 'unknown') linked++;
      if (r.status === 'missing') {
        missing++;
        warn = '<div class="sec-warn">⚠ 확인 필요: 연결했던 슬라이드' +
          (sec.hintIndex ? ' (예전 PPT ' + sec.hintIndex + '번' + (sec.hintTitle ? ' 「' + SP.esc(sec.hintTitle) + '」' : '') + ')' : '') +
          '가 지금 PPT 에 없습니다.</div>';
      }
      var link;
      if (r.status === 'ok') {
        link = thumbHTML(r.slide) + '<div class="lbl"><b>PPT ' + r.slide.index + '번</b> ' + SP.esc(r.slide.title) + '</div>' +
          '<button data-act="pick" data-i="' + i + '">변경</button>';
      } else if (r.status === 'unknown') {
        link = '<div class="thumb">PPT 를 열면 표시됩니다</div><div class="lbl"><b>PPT ' + (sec.hintIndex || '?') + '번</b> ' + SP.esc(sec.hintTitle || '') + '</div>';
      } else if (r.status === 'missing') {
        link = '<div class="thumb">찾을 수 없음</div>' +
          (r.suggestion ? '<button class="primary" data-act="accept" data-i="' + i + '" data-sid="' + r.suggestion.id + '">제목이 같은 PPT ' + r.suggestion.index + '번으로 연결</button>' : '') +
          '<button data-act="pick" data-i="' + i + '">슬라이드 다시 고르기</button>';
      } else {
        link = '<div class="thumb">연결 안 함</div><button data-act="pick" data-i="' + i + '"' + (p.presOpen ? '' : ' disabled') + '>슬라이드 연결</button>';
      }
      return '<div class="sec' + (r.status === 'missing' ? ' warn' : '') + '">' +
        '<div class="sec-main"><div class="sec-h">' + secLabel(sec) + '</div>' +
        '<div class="sec-b" data-act="toggle">' + SP.esc(sec.body || '(내용 없음)') + '</div>' + warn + '</div>' +
        '<div class="sec-link">' + link + '</div></div>';
    }).join('');
    $('secList').innerHTML = html;

    $('parseInfo').textContent = secs.length ? secs.length + '개 구간으로 나뉨' : '';
    $('btnSeq').disabled = !p.presOpen || !secs.length;
    $('mapSummary').innerHTML = !secs.length ? '' :
      '구간 ' + secs.length + '개 중 ' + linked + '개 연결됨' +
      (missing ? ' · <span class="w">확인 필요 ' + missing + '개</span>' : '') +
      (linked === 0 && p.presOpen ? ' — 「시작 슬라이드 지정」을 눌러 대본 첫 구간에 해당하는 슬라이드를 고르세요.' : '');
  }

  function secLabel(sec) {
    if (sec.num === 0) return '<span class="n">시작 전</span>';
    return '<span class="n">▶ ' + sec.num + '</span>' + (sec.title ? ' · ' + SP.esc(sec.title) : '');
  }

  $('script').addEventListener('input', function () {
    if (!doc) return;
    doc.script = this.value;
    markDirty();
  });
  $('script').addEventListener('paste', function () {
    // 처음 붙여 넣을 때는 버튼을 누르지 않아도 바로 나눈다.
    if (doc && !doc.sections.length) setTimeout(parseNow, 50);
  });
  $('btnParse').addEventListener('click', parseNow);

  function parseNow() {
    if (!doc) return;
    doc.script = $('script').value;
    var parsed = SP.parseScript(doc.script);
    var marks = parsed.filter(function (s) { return s.num > 0; }).length;
    if (!marks) { toast('「▶ 1 · 제목」 같은 구분 표시를 찾지 못했습니다', 4000); return; }
    var hadLinks = doc.sections.some(function (s) { return s.slideId; });
    doc.sections = SP.mergeSections(doc.sections, parsed);
    cur = Math.min(cur, doc.sections.length - 1);
    markDirty();
    renderPrep(true);
    toast(marks + '개 슬라이드 구간으로 나눴습니다');
    if (!hadLinks && S.ppt.presOpen) pickStart();
  }

  function firstNumbered() {
    for (var i = 0; i < doc.sections.length; i++) if (doc.sections[i].num > 0) return i;
    return 0;
  }

  function pickStart() {
    var i = firstNumbered(), sec = doc.sections[i];
    if (!sec) return;
    openPicker({
      title: '대본 ' + plainLabel(sec) + ' 에 해당하는 슬라이드를 고르세요. 나머지 구간은 순서대로 자동 연결됩니다.',
      current: sec.slideId, seqOnly: true,
      onPick: function (sid) {
        var n = SP.assignSequential(doc.sections, slides(), i, sid);
        markDirty(); renderPrep(true);
        toast(n + '개 구간을 순서대로 연결했습니다');
      }
    });
  }
  function plainLabel(sec) { return sec.num === 0 ? '시작 전' : sec.num + '번' + (sec.title ? '(' + sec.title + ')' : ''); }

  $('btnSeq').addEventListener('click', pickStart);
  $('btnRefresh').addEventListener('click', function () {
    api('/api/refresh', {}).then(function () { toast('PPT 를 다시 읽었습니다'); }).catch(function (e) { toast(e.message); });
  });

  $('secList').addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.dataset.act, i = parseInt(t.dataset.i, 10);
    if (act === 'toggle') { t.classList.toggle('open'); return; }
    var sec = doc.sections[i];
    if (!sec) return;
    if (act === 'accept') {
      setLink(sec, parseInt(t.dataset.sid, 10));
      markDirty(); renderPrep(true);
    } else if (act === 'pick') {
      openPicker({
        title: '대본 ' + plainLabel(sec) + ' 에 연결할 슬라이드를 고르세요.',
        current: sec.slideId, allowNone: true,
        onPick: function (sid, seq) {
          if (seq && sid) SP.assignSequential(doc.sections, slides(), i, sid);
          else setLink(sec, sid);
          markDirty(); renderPrep(true);
        }
      });
    }
  });

  function setLink(sec, sid) {
    var sl = slides().filter(function (s) { return s.id === sid; })[0];
    sec.slideId = sl ? sl.id : 0;
    sec.hintIndex = sl ? sl.index : 0;
    sec.hintTitle = sl ? sl.title : '';
  }

  $('btnNew').addEventListener('click', function () {
    if (!doc || !hasContent(doc)) return;
    if (!confirm('이 PPT 에 저장된 대본과 연결 정보를 지울까요?')) return;
    var id = doc.id;
    clearTimeout(saveTimer); dirty = false;
    doc = blankDoc(S.ppt.presOpen ? S.ppt.presPath : '', S.ppt.presOpen ? S.ppt.presName : '');
    docs = docs.filter(function (d) { return d.id !== id; });
    api('/api/doc', { id: id, delete: true }).catch(function (e) { toast(e.message); });
    $('script').value = '';
    renderPrep(true);
  });

  $('btnLoadOther').addEventListener('click', function () {
    var others = docs.filter(function (d) { return d.id !== doc.id && hasContent(d); })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var body = others.length ? others.map(function (d, i) {
      return '<div class="list-item"><div><b>' + SP.esc(d.pptName || '(PPT 없이 저장)') + '</b><small>구간 ' + d.sections.length + '개 · ' +
        new Date(d.updatedAt || 0).toLocaleString('ko-KR') + '</small></div><button class="primary" data-load="' + i + '">불러오기</button></div>';
    }).join('') : '<p class="muted">다른 저장본이 없습니다.</p>';
    openDialog('다른 PPT 로 준비했던 내용을 지금 PPT 에 불러옵니다', '', body, function (e) {
      var b = e.target.closest('[data-load]');
      if (!b) return;
      var src = others[parseInt(b.dataset.load, 10)];
      if (hasContent(doc) && !confirm('지금 내용 대신 불러올까요?')) return;
      doc.script = src.script; doc.sections = clone(src.sections);
      $('script').value = doc.script;
      closeDialog(); markDirty(); renderPrep(true);
      toast('불러왔습니다. 슬라이드 연결을 확인해 주세요');
    });
  });

  // ---- 슬라이드 고르기 창 --------------------------------------------------
  function openDialog(title, optHTML, bodyHTML, onClick) {
    var m = $('modal');
    m.innerHTML = '<div class="dlg"><div class="dlg-h"><h3>' + SP.esc(title) + '</h3><button data-close>닫기</button></div>' +
      (optHTML ? '<div class="dlg-opt">' + optHTML + '</div>' : '') + '<div class="dlg-b">' + bodyHTML + '</div></div>';
    m.hidden = false;
    m.onclick = function (e) {
      if (e.target === m || e.target.closest('[data-close]')) { closeDialog(); return; }
      onClick(e);
    };
  }
  function closeDialog() { $('modal').hidden = true; $('modal').innerHTML = ''; }

  function openPicker(o) {
    var used = {};
    doc.sections.forEach(function (s) { if (s.slideId) used[s.slideId] = s.num; });
    var tiles = slides().map(function (sl) {
      return '<button class="tile' + (sl.id === o.current ? ' sel' : '') + (used[sl.id] !== undefined ? ' used' : '') + '" data-sid="' + sl.id + '">' +
        thumbHTML(sl) + '<div class="cap"><b>' + sl.index + '</b> ' + SP.esc(sl.title) +
        (sl.hidden ? ' <i>숨김</i>' : '') + (used[sl.id] !== undefined ? ' <i>← 대본 ' + used[sl.id] + '</i>' : '') + '</div></button>';
    }).join('');
    var opt = o.seqOnly ? '' :
      '<label><input type="checkbox" id="pkSeq"> 이 구간부터 뒤쪽 구간도 순서대로 다시 연결</label>' +
      (o.allowNone ? '<button data-sid="0">연결 안 함</button>' : '');
    openDialog(o.title, opt, '<div class="grid">' + tiles + '</div>', function (e) {
      var b = e.target.closest('[data-sid]');
      if (!b) return;
      var seq = o.seqOnly || ($('pkSeq') && $('pkSeq').checked);
      closeDialog();
      o.onPick(parseInt(b.dataset.sid, 10), seq);
    });
    var sel = $('modal').querySelector('.tile.sel');
    if (sel) sel.scrollIntoView({ block: 'center' });
  }

  // ---- 설교 화면 ---------------------------------------------------------
  function renderPreach(force) {
    if (!S || !doc) return;
    var secs = doc.sections;
    $('preachEmpty').hidden = secs.length > 0;
    $('panes').hidden = !secs.length;
    $('bar').hidden = !secs.length;
    var sig = [doc.id, doc.updatedAt, S.ppt.slidesVer, S.ppt.presPath, docMatchesPpt()].join('|');
    if (!force && sig === preachSig) return;
    preachSig = sig;
    if (cur >= secs.length) cur = Math.max(0, secs.length - 1);

    var sp = $('scriptPane'), keepTop = sp.scrollTop;
    sp.innerHTML = secs.map(function (sec, i) {
      var r = resolve(sec);
      var ppt = r.status === 'ok' ? '<span class="ppt">PPT ' + r.slide.index + '번</span>' :
        r.status === 'missing' ? '<span class="ppt warn">⚠ 슬라이드 확인 필요</span>' : '';
      return '<article class="ps" data-i="' + i + '"><h3><span>' + secLabel(sec) + '</span>' + ppt + '</h3>' +
        '<div class="body">' + SP.renderBody(sec.body) + '</div></article>';
    }).join('');
    sp.scrollTop = keepTop;

    $('slidePane').innerHTML = '<div id="outside" class="outside" hidden></div>' + secs.map(function (sec, i) {
      var r = resolve(sec);
      var p = r.status === 'ok' ? 'PPT ' + r.slide.index : r.status === 'missing' ? '⚠ 확인 필요' : r.status === 'unknown' ? 'PPT ' + (sec.hintIndex || '?') : '화면 없음';
      return '<button class="sc' + (r.status === 'missing' ? ' missing' : '') + '" data-i="' + i + '" data-sid="' + (r.slide ? r.slide.id : 0) + '">' +
        thumbHTML(r.slide) + '<span class="badge">송출 중</span>' +
        '<div class="cap"><b>' + (sec.num || '·') + '</b><span class="t">' + SP.esc(sec.title || (sec.num ? '' : '시작 전')) + '</span><span class="p">' + p + '</span></div></button>';
    }).join('');
    updateMarks();
  }

  // 자주 바뀌는 표시(현재 구간, 송출 중, 버튼 상태)만 가볍게 고친다.
  function updateMarks() {
    if (!S || !doc) return;
    var p = S.ppt, me = mine();
    var liveShown = false;
    Array.prototype.forEach.call(document.querySelectorAll('#slidePane .sc'), function (el) {
      var i = parseInt(el.dataset.i, 10), sid = parseInt(el.dataset.sid, 10);
      var live = p.showRunning && sid && sid === p.curId;
      if (live) liveShown = true;
      el.classList.toggle('cur', i === cur);
      el.classList.toggle('live', !!live);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#scriptPane .ps'), function (el) {
      el.classList.toggle('cur', parseInt(el.dataset.i, 10) === cur);
    });
    var out = $('outside');
    if (out) {
      out.hidden = !(p.showRunning && p.curIndex && !liveShown);
      out.textContent = '지금 예배 화면은 PPT ' + p.curIndex + '번입니다 (설교 구간 밖)';
    }

    var mb = $('modeBar');
    if (!connected) { mb.className = 'modebar other'; mb.textContent = '연결이 끊겨 있습니다 — 다시 연결되면 이어서 조작할 수 있습니다'; }
    else if (me) { mb.className = 'modebar live'; mb.textContent = '송출 조작 중 — 슬라이드를 누르면 예배 화면이 실제로 바뀝니다'; }
    else if (S.control) { mb.className = 'modebar other'; mb.textContent = S.control.name + ' 이(가) 조작 중 — 이 기기는 미리보기만 합니다'; }
    else { mb.className = 'modebar'; mb.textContent = '미리보기 — 슬라이드를 눌러도 예배 화면은 바뀌지 않습니다'; }

    var bc = $('btnControl');
    bc.textContent = me ? '설교 조작 종료' : '설교 조작 시작';
    bc.classList.toggle('on', me);
    bc.disabled = !connected;
    var bb = $('btnBlack');
    bb.textContent = p.black ? '화면 복귀' : '검은 화면';
    bb.classList.toggle('on', !!p.black);
    bb.disabled = !connected || !me || !p.showRunning;
  }

  function scrollToCur(smooth) {
    var sp = $('scriptPane');
    var el = sp.querySelector('.ps[data-i="' + cur + '"]');
    if (el) sp.scrollTo({ top: Math.max(0, el.offsetTop - sp.offsetTop - 8), behavior: smooth ? 'smooth' : 'auto' });
    var card = $('slidePane').querySelector('.sc[data-i="' + cur + '"]');
    if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
  }

  // 구간을 고른다. 설교문은 항상 그 구간으로 이동하고,
  // 조작 권한이 있을 때만 실제 파워포인트를 해당 슬라이드로 넘긴다.
  // explicit: 슬라이드를 직접 눌렀을 때. 이미 그 슬라이드가 떠 있어도 검은 화면을 풀고 다시 보낸다.
  function select(i, explicit) {
    var sec = doc.sections[i];
    if (!sec) return;
    cur = i;
    updateMarks();
    scrollToCur(true);
    if (!mine()) return;
    var r = resolve(sec), p = S.ppt;
    if (r.status === 'none') return;
    if (r.status !== 'ok') { toast('⚠ 이 구간에 연결된 슬라이드를 PPT 에서 찾을 수 없습니다. 예배 화면은 그대로입니다', 4000); return; }
    if (!p.showRunning) {
      if (confirm('슬라이드 쇼가 실행 중이 아닙니다.\nPPT ' + r.slide.index + '번부터 슬라이드 쇼를 시작할까요?')) {
        api('/api/startshow', { cid: CID, slideId: r.slide.id }).catch(function (e) { toast(e.message, 4000); });
      }
      return;
    }
    if (!explicit && p.curId === r.slide.id) return; // 같은 슬라이드를 이어서 쓰는 구간 (예: 칠판 설명)
    api('/api/goto', { cid: CID, slideId: r.slide.id }).catch(function (e) { toast(e.message, 4000); });
  }

  function step(d) {
    var secs = doc.sections, sec = secs[cur];
    if (!sec) return;
    var p = S.ppt;
    // 현재 슬라이드에 클릭 애니메이션이 남아 있으면 그것부터 진행한다.
    if (mine() && p.showRunning && sec.slideId && p.curId === sec.slideId) {
      if ((d > 0 && p.clickIndex < p.clickCount) || (d < 0 && p.clickIndex > 0)) {
        api('/api/step', { cid: CID, dir: d, curId: p.curId }).catch(function (e) { toast(e.message, 4000); });
        return;
      }
    }
    var ni = cur + d;
    if (ni >= secs.length) { toast('설교의 마지막 구간입니다. 뒤의 예배 순서로는 넘어가지 않습니다', 3500); return; }
    if (ni < 0) { toast('설교의 첫 구간입니다'); return; }
    select(ni, false);
  }

  $('slidePane').addEventListener('click', function (e) {
    var b = e.target.closest('.sc');
    if (b) select(parseInt(b.dataset.i, 10), true);
  });
  $('btnNext').addEventListener('click', function () { step(1); });
  $('btnPrev').addEventListener('click', function () { step(-1); });

  $('btnControl').addEventListener('click', function () {
    if (mine()) {
      api('/api/control', { cid: CID, action: 'release' }).then(function () {
        toast('조작을 마쳤습니다. 방송실에서 예배 순서를 이어갈 수 있습니다', 3500);
      }).catch(function (e) { toast(e.message); });
      return;
    }
    var action = 'acquire';
    if (S.control && S.control.cid !== CID) {
      if (!confirm(S.control.name + ' 이(가) 지금 조작 중입니다.\n조작 권한을 이 기기로 가져올까요?')) return;
      action = 'takeover';
    }
    api('/api/control', { cid: CID, action: action }).then(function () {
      toast('조작을 시작했습니다. 예배 화면은 슬라이드를 누를 때 바뀝니다', 3500);
    }).catch(function (e) { toast(e.message, 4000); });
  });

  $('btnBlack').addEventListener('click', function () {
    api('/api/black', { cid: CID, on: !S.ppt.black }).catch(function (e) { toast(e.message, 4000); });
  });

  function applyFont() {
    fontSize = Math.max(16, Math.min(64, fontSize));
    document.documentElement.style.setProperty('--fs', fontSize + 'px');
    store('sp_fs', String(fontSize));
  }
  $('btnFontUp').addEventListener('click', function () { fontSize += 2; applyFont(); });
  $('btnFontDn').addEventListener('click', function () { fontSize -= 2; applyFont(); });
  $('btnReconnect').addEventListener('click', connect);

  // 블루투스 키보드/리모컨: 오른쪽·아래·스페이스 = 다음, 왼쪽·위 = 이전
  document.addEventListener('keydown', function (e) {
    if (tab !== 'preach' || !$('modal').hidden || /TEXTAREA|INPUT/.test(e.target.tagName)) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].indexOf(e.key) >= 0) { e.preventDefault(); step(1); }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].indexOf(e.key) >= 0) { e.preventDefault(); step(-1); }
  });

  applyFont();
  requestWakeLock();
  connect();
})();
