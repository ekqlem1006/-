// 대본 자동 연결의 핵심 로직. 화면과 분리되어 있어 node 로 단독 시험할 수 있다.
(function (root) {
  'use strict';

  // "▶ 1 · 제목" 형태의 슬라이드 구분 표시.
  // 앞뒤의 굵게(**), 제목(#) 마크다운, 여러 가지 가운뎃점·세모 모양을 모두 허용한다.
  var MARK = /^\s*(?:#{1,6}\s+)?(?:[*_]{1,3}\s*)?[▶►▸▷⏵](?:️|︎)?\s*(?:[*_]{1,3}\s*)?(\d{1,3})(?=$|[\s*_·•ㆍ‧∙・.\-–—:|)\]])\s*(?:[·•ㆍ‧∙・.\-–—:|)\]]\s*)?(.*?)\s*$/;

  function cleanTitle(t) {
    return t.replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '').replace(/\*\*|__/g, '').trim();
  }

  function trimBlank(lines) {
    var a = 0, b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b);
  }

  // 대본 전체를 슬라이드 구간으로 나눈다.
  // 표시부터 다음 표시 직전까지가 한 구간의 설교문이 된다.
  // 첫 표시 앞에 글이 있으면 번호 0 의 "시작 전" 구간으로 둔다.
  function parseScript(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var cur = { num: 0, title: '', lines: [] };
    function push() {
      var body = trimBlank(cur.lines).join('\n');
      if (cur.num === 0 && !body) return;
      out.push({ num: cur.num, title: cur.title, body: body });
    }
    for (var i = 0; i < lines.length; i++) {
      var m = MARK.exec(lines[i]);
      if (m) {
        push();
        cur = { num: parseInt(m[1], 10), title: cleanTitle(m[2]), lines: [] };
      } else {
        cur.lines.push(lines[i]);
      }
    }
    push();
    return out;
  }

  var keySeq = 0;
  function newKey() {
    keySeq++;
    return 's' + Date.now().toString(36) + keySeq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  // 대본을 고쳐서 다시 나눌 때, 같은 번호의 구간에 이미 연결해 둔 슬라이드를 유지한다.
  function mergeSections(oldSecs, parsed) {
    var used = {};
    return parsed.map(function (p) {
      var keep = null;
      for (var i = 0; i < (oldSecs || []).length; i++) {
        if (!used[i] && oldSecs[i].num === p.num) { keep = oldSecs[i]; used[i] = true; break; }
      }
      return {
        key: keep ? keep.key : newKey(),
        num: p.num, title: p.title, body: p.body,
        slideId: keep ? keep.slideId || 0 : 0,
        hintIndex: keep ? keep.hintIndex || 0 : 0,
        hintTitle: keep ? keep.hintTitle || '' : ''
      };
    });
  }

  // 시작 슬라이드를 한 번 지정하면 그 뒤 구간을 순서대로 연결한다.
  // 대본 번호 차이만큼 PPT 에서도 건너뛴다 (1,2,4번 → 20,21,23번).
  // 번호가 뒤죽박죽이면 나온 순서대로 연결한다. 숨긴 슬라이드는 건너뛴다.
  function assignSequential(sections, slides, fromIdx, startSlideId) {
    var visible = slides.filter(function (s) { return !s.hidden || s.id === startSlideId; });
    var pos = -1;
    for (var i = 0; i < visible.length; i++) if (visible[i].id === startSlideId) pos = i;
    if (pos < 0) return 0;
    var monotonic = true;
    for (var j = fromIdx + 1; j < sections.length; j++) {
      if (sections[j].num <= sections[j - 1].num) monotonic = false;
    }
    var base = sections[fromIdx].num, n = 0, ord = 0;
    for (var k = fromIdx; k < sections.length; k++) {
      var sec = sections[k];
      if (sec.num === 0 && k !== fromIdx) continue;
      var off = monotonic ? sec.num - base : ord;
      ord++;
      var sl = visible[pos + off];
      sec.slideId = sl ? sl.id : 0;
      sec.hintIndex = sl ? sl.index : 0;
      sec.hintTitle = sl ? sl.title : '';
      if (sl) n++;
    }
    return n;
  }

  // 저장된 연결을 지금 열린 PPT 에 맞춰 본다.
  //  ok      : 슬라이드 고유 ID 로 찾음 (번호가 밀렸어도 그대로 연결)
  //  none    : 연결하지 않은 구간
  //  missing : 연결했던 슬라이드가 PPT 에 없음 → 확인 필요.
  //            제목이 같은 슬라이드가 하나뿐이면 suggestion 으로 제안한다.
  function resolveSection(sec, slides) {
    if (!sec.slideId) return { status: 'none', slide: null, suggestion: null };
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].id === sec.slideId) return { status: 'ok', slide: slides[i], suggestion: null };
    }
    var same = sec.hintTitle ? slides.filter(function (s) { return s.title === sec.hintTitle; }) : [];
    return { status: 'missing', slide: null, suggestion: same.length === 1 ? same[0] : null };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/__(.+?)__/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }

  // 설교문을 읽기 좋은 HTML 로 바꾼다. 괄호로 감싼 줄은 진행 지시로 구분해 보여 준다.
  function renderBody(text) {
    var paras = String(text || '').split(/\n\s*\n/);
    return paras.map(function (p) {
      var lines = p.split('\n').filter(function (l) { return l.trim(); });
      if (!lines.length) return '';
      var allCue = lines.every(isCue);
      var html = lines.map(function (l) {
        var t = l.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+(?!\*)/, '• ');
        return isCue(l) && !allCue ? '<span class="cue">' + inline(stripCue(t)) + '</span>' : inline(allCue ? stripCue(t) : t);
      }).join('<br>');
      return '<p' + (allCue ? ' class="cue"' : '') + '>' + html + '</p>';
    }).join('');
  }

  function isCue(line) {
    return /^\s*[*_]{0,3}\s*[(（].*[)）]\s*[*_]{0,3}\s*$/.test(line);
  }
  function stripCue(t) { return t.replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, ''); }

  var api = {
    parseScript: parseScript, mergeSections: mergeSections, assignSequential: assignSequential,
    resolveSection: resolveSection, renderBody: renderBody, esc: esc, newKey: newKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SP = api;
})(this);
