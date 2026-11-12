// 예배용 컴퓨터의 연결 화면
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SP': '1' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || '오류'); return j; }); });
  }
  var info = null, selIP = null, S = null, lastMsg = 0;

  function loadInfo() {
    return fetch('/api/hostinfo', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      info = j;
      $('pc').textContent = j.pc;
      $('dataDir').textContent = j.dataDir;
      $('ver').textContent = j.version;
      $('btnFw').hidden = !j.firewallHelper;
      if (document.activeElement !== $('dept')) $('dept').value = j.dept || '';
      var ips = j.addrs.map(function (a) { return a.ip; });
      if (!selIP || ips.indexOf(selIP) < 0) selIP = ips[0] || null;
      renderQR();
    });
  }

  function renderQR() {
    $('noNet').hidden = !!selIP;
    $('qr').hidden = !selIP;
    if (!selIP) { $('url').textContent = ''; $('addrs').innerHTML = ''; return; }
    var a = info.addrs.filter(function (x) { return x.ip === selIP; })[0];
    $('qr').src = '/api/qr?ip=' + selIP + '&t=' + Date.now();
    $('url').textContent = a.url;
    $('addrs').innerHTML = info.addrs.length < 2 ? '' :
      '<div class="muted" style="margin-top:10px">이 컴퓨터에 네트워크 주소가 여러 개 있습니다. 접속이 안 되면 다른 주소로 바꿔 보세요.</div>' +
      info.addrs.map(function (x) {
        return '<button data-ip="' + x.ip + '" class="' + (x.ip === selIP ? 'on' : '') + '">' + x.ip + ' (' + x.iface + ')</button>';
      }).join('');
  }
  $('addrs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ip]');
    if (b) { selIP = b.dataset.ip; renderQR(); }
  });

  function st(id, cls, title, desc) {
    var el = $(id);
    el.className = 'st ' + cls;
    el.querySelector('b').textContent = title;
    el.querySelector('span').textContent = desc || '';
  }

  function render() {
    if (!S) return;
    var p = S.ppt;
    var tablets = S.clients.filter(function (c) { return !c.local; });
    var on = tablets.filter(function (c) { return c.online; });
    if (on.length) st('stTablet', 'ok', '태블릿 연결됨: ' + on.map(function (c) { return c.name; }).join(', '), '');
    else if (tablets.length) st('stTablet', 'warn', '태블릿 연결이 끊겨 있습니다', tablets.map(function (c) { return c.name; }).join(', ') + ' — 태블릿 화면을 켜면 자동으로 다시 연결됩니다.');
    else st('stTablet', '', '아직 연결된 태블릿이 없습니다', '왼쪽 QR 을 태블릿 카메라로 찍어 주세요.');

    if (!p.appRunning) st('stPpt', 'bad', '파워포인트가 실행되어 있지 않습니다', '예배 PPT 를 열면 자동으로 연결됩니다.');
    else if (!p.presOpen) st('stPpt', 'warn', '열려 있는 PPT 가 없습니다', '파워포인트에서 예배 PPT 를 열어 주세요.');
    else st('stPpt', 'ok', 'PPT 연결됨: ' + p.presName, '전체 ' + p.slides.length + '장' + (p.simulated ? ' · 연습용 가상 PPT (실제 화면과 연결되지 않음)' : ''));

    if (!p.presOpen) st('stShow', '', '슬라이드 쇼', '');
    else if (!p.showRunning) st('stShow', 'warn', '슬라이드 쇼가 꺼져 있습니다', '예배 때처럼 슬라이드 쇼(F5)를 시작해 주세요.');
    else st('stShow', 'ok', p.black ? '슬라이드 쇼 실행 중 — 검은 화면' : '슬라이드 쇼 실행 중 — ' + (p.curIndex ? p.curIndex + '번 슬라이드' : '쇼 끝 화면'), '방송실에서 평소처럼 직접 넘겨도 됩니다.');

    if (S.control) st('stCtl', S.control.online ? 'ok' : 'warn', '조작 중인 기기: ' + S.control.name + (S.control.online ? '' : ' (연결 끊김)'), '');
    else st('stCtl', '', '조작 중인 태블릿 없음', '태블릿에서 「설교 조작 시작」을 누르기 전에는 화면이 바뀌지 않습니다.');
    $('btnRelease').hidden = !S.control;
  }

  var es = null;
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events?cid=host-' + Math.random().toString(36).slice(2, 8) + '&name=' + encodeURIComponent('연결 화면'));
    es.addEventListener('state', function (e) { lastMsg = Date.now(); S = JSON.parse(e.data); render(); });
    es.addEventListener('hb', function () { lastMsg = Date.now(); });
  }
  setInterval(function () { if (Date.now() - lastMsg > 8000) { lastMsg = Date.now(); connect(); } }, 2000);
  setInterval(function () { loadInfo().catch(function () {}); }, 5000); // 와이파이가 바뀌면 QR 도 바뀐다

  $('btnDept').addEventListener('click', function () {
    post('/api/host', { action: 'dept', dept: $('dept').value }).then(function () {
      $('deptSaved').textContent = '저장했습니다';
      setTimeout(function () { $('deptSaved').textContent = ''; }, 2500);
    });
  });
  $('btnRelease').addEventListener('click', function () { post('/api/control', { cid: 'host', action: 'forceRelease' }); });
  $('btnFw').addEventListener('click', function () {
    post('/api/host', { action: 'firewall' }).then(function () {
      $('fwMsg').textContent = '「이 앱이 디바이스를 변경하도록 허용하시겠어요?」 창이 뜨면 「예」를 눌러 주세요.';
    }).catch(function (e) { $('fwMsg').textContent = e.message; });
  });
  $('btnNewKey').addEventListener('click', function () {
    if (!confirm('연결 키를 새로 만들면 이전에 연결했던 태블릿은 QR 을 다시 찍어야 합니다. 계속할까요?')) return;
    post('/api/host', { action: 'newKey' }).then(loadInfo);
  });
  $('btnQuit').addEventListener('click', function () {
    if (!confirm('프로그램을 종료하면 태블릿에서 더 이상 조작할 수 없습니다. 종료할까요?')) return;
    post('/api/host', { action: 'quit' }).then(function () {
      document.body.innerHTML = '<div class="wrap"><h1>설교 프롬프터를 종료했습니다</h1><p class="sub">이 창은 닫아도 됩니다.</p></div>';
    });
  });

  loadInfo().catch(function () {});
  connect();
})();
