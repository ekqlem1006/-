// 화면 흐름 자동 시험 (가상 PPT 사용).
//   go build -o sp . && ./sp -sim -no-browser -data /tmp/spdata -port 18765 &
//   node e2e_test.js http://<이 컴퓨터의 내부 IP>:18765 [스크린숏 폴더]
// 실제 파워포인트 연동은 윈도우에서 직접 확인해야 한다 (README 의 현장 확인표).
const { chromium, devices } = require('playwright');
const assert = require('assert');
const LAN = process.argv[2];
const SHOTS = process.argv[3];
const PORT = new URL(LAN).port;
const LOCAL = 'http://127.0.0.1:' + PORT;

const SCRIPT = `▶ 1 · 표지 "와서 보라"
첫 인사와 도입

**▶ 2 · 요한복음 1:43-46**
성경 본문과 설명

▶ 3 · 질문 셋
여러분에게 복음은 무엇입니까?
복음이 무엇이기에 전해야 하는 것입니까?

▶ 4 · 미가 6:8
성경 본문과 설명

*(칠판 구간 시작 · 화면은 4번 유지, B키로 검은 화면)*

▶ 5 · 복음이란
(B키로 화면 복귀 후 넘김)
마무리`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function state() { return (await fetch(LOCAL + '/api/state')).json(); }
async function sim(action, n) {
  await fetch(LOCAL + '/api/sim', { method: 'POST', headers: { 'X-SP': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ action, n }) });
}
async function until(fn, what) {
  for (let i = 0; i < 50; i++) { if (await fn()) return; await sleep(100); }
  throw new Error('시간 초과: ' + what);
}
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = p => { p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept()); };

  // 9. (프로그램을 껐다 켠 뒤) 저장한 준비 내용과 연결 키가 그대로 남아 있다
  if (process.argv[5] === 'restart') {
    const info = await (await fetch(LOCAL + '/api/hostinfo')).json();
    const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
    const p = await ctx.newPage(); watch(p);
    await p.goto(info.addrs[0].url);
    await p.waitForSelector('#preach:not([hidden])');
    assert.strictEqual(await p.locator('#slidePane .sc').count(), 5);
    assert.strictEqual(await p.locator('#slidePane .sc.missing').count(), 1);
    assert.ok((await p.textContent('#scriptPane')).includes('여러분에게 복음은 무엇입니까?'));
    await browser.close();
    assert.deepStrictEqual(errors, []);
    console.log('e2e OK (재실행 후 복원)');
    return;
  }

  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const host = await hostCtx.newPage(); watch(host);
  await host.goto(LOCAL + '/host');
  await host.waitForFunction(() => document.getElementById('url').textContent.includes('?k='));
  const url = await host.textContent('#url');
  assert.ok(url.startsWith(LAN + '/?k='), 'QR 주소가 내부 네트워크 주소여야 함: ' + url);
  assert.strictEqual((await fetch(LOCAL + '/api/qr?ip=' + new URL(LAN).hostname)).headers.get('content-type'), 'image/png');

  // 키 없이 내부 네트워크로 들어오면 거부, 연결 화면은 컴퓨터에서만
  assert.strictEqual((await fetch(LAN + '/api/state')).status, 401);
  assert.strictEqual((await fetch(LAN + '/api/hostinfo?k=' + new URL(url).searchParams.get('k'))).status, 403);

  // 2. 태블릿: QR 주소만으로 접속 (추가 입력 없음)
  const padCtx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const pad = await padCtx.newPage(); watch(pad);
  await pad.goto(url);
  await pad.waitForSelector('#prep:not([hidden])');
  await until(async () => (await host.textContent('#stTablet b')).includes('아이패드'), '연결 화면에 태블릿 표시');
  assert.ok((await pad.textContent('#pptName')).includes('연습용 가상 예배.pptx'));

  // 3. 대본을 넣으면 슬라이드별로 자동으로 나뉜다
  await pad.fill('#script', SCRIPT);
  await pad.click('#btnParse');
  await pad.waitForSelector('#modal .tile');
  assert.strictEqual(await pad.locator('#secList .sec').count(), 5);
  await shot(pad, '1-picker');

  // 4. 전체 예배 PPT 에서 시작 슬라이드(9번)만 지정 → 순서대로 연결
  await pad.click('#modal .tile >> nth=8');
  await pad.waitForFunction(() => document.querySelectorAll('#secList .lbl b').length === 5);
  assert.deepStrictEqual(await pad.locator('#secList .lbl b').allTextContents(), ['PPT 9번', 'PPT 10번', 'PPT 11번', 'PPT 12번', 'PPT 13번']);
  // 한 구간만 따로 수정 (5번 구간 → PPT 15번)
  await pad.click('#secList .sec >> nth=4 >> text=변경');
  await pad.click('#modal .tile >> nth=14');
  await pad.waitForFunction(() => document.querySelectorAll('#secList .lbl b')[4].textContent === 'PPT 15번');
  await pad.waitForFunction(() => document.getElementById('saveState').textContent.includes('저장됨'));
  await shot(pad, '2-prep');

  // 5. 설교 화면: 미리보기에서는 예배 화면이 바뀌지 않는다
  await pad.click('#tabs [data-tab=preach]');
  await pad.waitForSelector('#slidePane .sc');
  assert.strictEqual(await pad.locator('#slidePane .sc').count(), 5, '설교 슬라이드만 표시');
  await pad.click('#slidePane .sc >> nth=2');
  await sleep(400);
  assert.strictEqual((await state()).ppt.curIndex, 1, '미리보기에서는 PPT 가 바뀌면 안 됨');
  assert.ok(await pad.locator('#scriptPane .ps >> nth=2').evaluate(e => e.classList.contains('cur')));

  // '설교 조작 시작'만으로는 화면이 바뀌지 않는다
  await pad.click('#btnControl');
  await pad.waitForSelector('#modeBar.live');
  await sleep(300);
  assert.strictEqual((await state()).ppt.curIndex, 1, '조작 시작만으로 PPT 가 바뀌면 안 됨');

  // 슬라이드를 누르면 설교문과 PPT 가 함께 이동
  await pad.click('#slidePane .sc >> nth=1');
  await until(async () => (await state()).ppt.curIndex === 10, '슬라이드 탭 → PPT 10번');
  await pad.waitForSelector('#slidePane .sc.live >> nth=0');
  await pad.click('#btnNext');
  await until(async () => (await state()).ppt.curIndex === 11, '다음 → PPT 11번');
  await pad.click('#btnNext');
  await until(async () => (await state()).ppt.curIndex === 12, '다음 → PPT 12번');
  await sleep(500);
  await shot(pad, '3-preach-live');

  // 6. 검은 화면: 슬라이드는 유지, 설교문은 그대로, 버튼으로 복귀
  const scrollBefore = await pad.evaluate(() => document.getElementById('scriptPane').scrollTop);
  await pad.evaluate(() => { document.getElementById('scriptPane').scrollTop += 300; });
  await sleep(300);
  assert.strictEqual((await state()).ppt.black, false, '스크롤만으로 검은 화면이 되면 안 됨');
  await pad.click('#btnBlack');
  await until(async () => { const s = (await state()).ppt; return s.black && s.curIndex === 12; }, '검은 화면');
  await pad.waitForFunction(() => document.getElementById('btnBlack').textContent === '화면 복귀');
  assert.ok(await pad.isVisible('#scriptPane .ps.cur'));
  await shot(pad, '4-black');
  await pad.click('#btnBlack');
  await until(async () => !(await state()).ppt.black, '화면 복귀');
  // 가린 채로 다음 슬라이드를 고르면 가림이 풀리고 전환
  await pad.click('#btnBlack');
  await until(async () => (await state()).ppt.black, '검은 화면 2');
  await pad.click('#btnNext');
  await until(async () => { const s = (await state()).ppt; return !s.black && s.curIndex === 15; }, '가림 해제 후 PPT 15번');
  void scrollBefore;

  // 마지막 슬라이드에서 '다음'을 눌러도 뒤의 순서로 넘어가지 않는다
  await pad.click('#btnNext');
  await sleep(400);
  assert.strictEqual((await state()).ppt.curIndex, 15, '마지막에서 더 넘어가면 안 됨');

  // 방송실 수동 조작이 태블릿에 보인다
  await sim('manual', 17);
  await pad.waitForFunction(() => document.getElementById('liveChip').textContent.includes('17번'));
  await pad.waitForSelector('#outside:not([hidden])');

  // 7. 조작 권한: 두 번째 태블릿은 권한 없이 조작할 수 없다
  const tabCtx = await browser.newContext({ ...devices['Galaxy Tab S4 landscape'] });
  const tab = await tabCtx.newPage(); watch(tab);
  await tab.goto(url);
  await tab.waitForSelector('#preach:not([hidden])', { timeout: 5000 });   // 저장된 준비 내용이 바로 뜬다
  assert.strictEqual(await tab.locator('#slidePane .sc').count(), 5);
  await tab.waitForSelector('#modeBar.other');
  await tab.click('#slidePane .sc >> nth=0');
  await sleep(400);
  assert.strictEqual((await state()).ppt.curIndex, 17, '권한 없는 태블릿이 PPT 를 바꾸면 안 됨');
  const cid2 = await tab.evaluate(() => localStorage.getItem('sp_cid'));
  const k = new URL(url).searchParams.get('k');
  const forged = await fetch(`${LAN}/api/goto?k=${k}`, { method: 'POST', headers: { 'X-SP': '1' }, body: JSON.stringify({ cid: cid2, slideId: (await state()).ppt.slides[0].id }) });
  assert.strictEqual(forged.status, 409);
  // 권한을 가져오면 조작 가능, 이전 태블릿은 미리보기로 바뀐다
  await tab.click('#btnControl');
  await tab.waitForSelector('#modeBar.live');
  await pad.waitForSelector('#modeBar.other');
  await tab.click('#slidePane .sc >> nth=0');
  await until(async () => (await state()).ppt.curIndex === 9, '두 번째 태블릿 조작');
  await shot(tab, '5-galaxy');
  await tab.click('#btnControl');
  await tab.waitForSelector('#modeBar:not(.live):not(.other)');

  // 8. 연결이 끊기면 표시하고, 돌아오면 다시 연결된다
  await pad.click('#btnControl');
  await pad.waitForSelector('#modeBar.live');
  // (서버 프로세스를 잠깐 멈춰 와이파이 끊김을 흉내 낸다)
  const pid = process.argv[4];
  process.kill(pid, 'SIGSTOP');
  await pad.waitForSelector('#connBanner:not([hidden])', { timeout: 15000 });
  assert.ok(await pad.locator('#btnControl').isDisabled());
  await shot(pad, '6-disconnected');
  process.kill(pid, 'SIGCONT');
  await pad.waitForSelector('#connBanner', { state: 'hidden', timeout: 15000 });
  await pad.waitForSelector('#modeBar.live');   // 조작 권한이 유지된다
  await pad.click('#slidePane .sc >> nth=1');
  await until(async () => (await state()).ppt.curIndex === 10, '재연결 후 조작');

  // 10. PPT 앞에 광고가 추가되어 번호가 밀려도 연결이 유지된다
  await sim('insert');
  await pad.waitForFunction(() => document.querySelector('#slidePane .sc .p').textContent === 'PPT 10');
  await pad.click('#slidePane .sc >> nth=2');
  await until(async () => (await state()).ppt.curIndex === 12, '번호가 밀린 뒤에도 같은 슬라이드로');
  // 연결된 슬라이드가 삭제되면 확인 필요로 표시
  await sim('delete', 12);
  await pad.waitForSelector('#slidePane .sc.missing');
  await pad.click('#tabs [data-tab=prep]');
  await pad.waitForSelector('#secList .sec.warn');
  assert.ok((await pad.textContent('#mapSummary')).includes('확인 필요 1개'));
  await shot(pad, '7-needs-check');
  await pad.waitForFunction(() => document.getElementById('saveState').textContent.includes('저장됨'));

  await shot(host, '8-host');
  // 조작 중인 태블릿이 꺼지면 컴퓨터 화면에 끊김으로 표시된다
  await pad.close();
  await until(async () => (await host.textContent('#stCtl b')).includes('연결 끊김'), '컴퓨터 화면에 끊김 표시');
  await browser.close();
  assert.deepStrictEqual(errors, [], '화면 오류');
  console.log('e2e OK (1차)');
})().catch(e => { console.error(e); process.exit(1); });
