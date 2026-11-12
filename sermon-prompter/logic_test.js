// node logic_test.js — 대본 자동 연결 로직 시험
const assert = require('assert');
const SP = require('./web/logic.js');

const sample = `▶ 1 · 표지 "와서 보라"
첫 인사와 도입

▶ 2 · 요한복음 1:43-46
성경 본문과 설명

▶ 3 · 질문 셋
여러분에게 복음은 무엇입니까?
복음이 무엇이기에 전해야 하는 것입니까?

▶ 4 · 미가 6:8
성경 본문과 설명`;

let s = SP.parseScript(sample);
assert.deepStrictEqual(s.map(x => x.num), [1, 2, 3, 4]);
assert.strictEqual(s[0].title, '표지 "와서 보라"');
assert.strictEqual(s[0].body, '첫 인사와 도입');
assert.strictEqual(s[2].body, '여러분에게 복음은 무엇입니까?\n복음이 무엇이기에 전해야 하는 것입니까?');
assert.strictEqual(s[3].title, '미가 6:8');

// 굵게 표시, 제목 마크다운, 다른 구분 기호, 머리말
s = SP.parseScript(`오늘 설교 메모\r\n\r\n**▶ 1 · 표지**\r\n도입\r\n▶ **2 · 본문**\n내용\n## ▶️ 3. 질문\n\n*(칠판 구간 시작 · 화면은 6번 유지, B키로 검은 화면)*\n\n▶ 7 · 드라마 대사\n(B키로 화면 복귀 후 넘김)\n▶10\n끝`);
assert.deepStrictEqual(s.map(x => [x.num, x.title]), [[0, ''], [1, '표지'], [2, '본문'], [3, '질문'], [7, '드라마 대사'], [10, '']]);
assert.strictEqual(s[0].body, '오늘 설교 메모');
assert.ok(s[3].body.includes('칠판 구간 시작'));

// 표시가 아닌 줄은 구간을 나누지 않는다
s = SP.parseScript('▶ 1 · 가\n▶ 3개의 질문을 드립니다\n본문 중 ▶ 2 · 는 표시가 아님');
assert.strictEqual(s.length, 1);

// 순서대로 연결: 대본 1번 → PPT 20번
const slides = Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i * 7, index: i + 1, title: '슬라이드 ' + (i + 1), hidden: false }));
let secs = SP.mergeSections([], SP.parseScript(sample));
assert.strictEqual(SP.assignSequential(secs, slides, 0, slides[19].id), 4);
assert.deepStrictEqual(secs.map(x => x.hintIndex), [20, 21, 22, 23]);

// 대본 번호가 건너뛰면 PPT 도 그만큼 건너뛴다
secs = SP.mergeSections([], SP.parseScript('▶ 1 · a\n▶ 2 · b\n▶ 4 · d'));
SP.assignSequential(secs, slides, 0, slides[19].id);
assert.deepStrictEqual(secs.map(x => x.hintIndex), [20, 21, 23]);

// 중간부터 다시 연결
SP.assignSequential(secs, slides, 1, slides[29].id);
assert.deepStrictEqual(secs.map(x => x.hintIndex), [20, 30, 32]);

// 숨긴 슬라이드는 건너뛰고, PPT 끝을 넘으면 연결하지 않는다
const hid = slides.map(x => ({ ...x, hidden: x.index === 21 }));
secs = SP.mergeSections([], SP.parseScript(sample));
SP.assignSequential(secs, hid, 0, hid[19].id);
assert.deepStrictEqual(secs.map(x => x.hintIndex), [20, 22, 23, 24]);
assert.strictEqual(SP.assignSequential(secs, slides, 0, slides[48].id), 2);
assert.strictEqual(secs[2].slideId, 0);

// 대본을 고쳐 다시 나눠도 연결이 유지된다
secs = SP.mergeSections([], SP.parseScript(sample));
SP.assignSequential(secs, slides, 0, slides[19].id);
const again = SP.mergeSections(secs, SP.parseScript(sample.replace('첫 인사와 도입', '바뀐 도입') + '\n▶ 5 · 새 구간\n내용'));
assert.deepStrictEqual(again.map(x => x.slideId), [...secs.map(x => x.slideId), 0]);
assert.strictEqual(again[0].body, '바뀐 도입');
assert.strictEqual(again[0].key, secs[0].key);

// PPT 앞에 광고가 추가되어 번호가 밀려도 고유 ID 로 찾는다
const shifted = [{ id: 9999, index: 1, title: '새 광고', hidden: false }, ...slides.map(x => ({ ...x, index: x.index + 1 }))];
let r = SP.resolveSection(secs[0], shifted);
assert.strictEqual(r.status, 'ok');
assert.strictEqual(r.slide.index, 21);
// 삭제되면 확인 필요로 표시하고, 제목이 같은 슬라이드가 하나면 제안한다
r = SP.resolveSection(secs[1], shifted.filter(x => x.id !== secs[1].slideId));
assert.strictEqual(r.status, 'missing');
assert.strictEqual(r.suggestion, null);
r = SP.resolveSection(secs[1], shifted.map(x => x.id === secs[1].slideId ? { ...x, id: 5555 } : x));
assert.strictEqual(r.status, 'missing');
assert.strictEqual(r.suggestion.id, 5555);
assert.strictEqual(SP.resolveSection({ slideId: 0 }, shifted).status, 'none');

// 진행 지시는 구분해 보여 주고, HTML 은 그대로 실행되지 않는다
const html = SP.renderBody('*(칠판 구간 시작 · B키로 검은 화면)*\n\n**강조** 문장 <script>\n(B키로 화면 복귀 후 넘김)');
assert.ok(html.includes('<p class="cue">(칠판 구간 시작 · B키로 검은 화면)</p>'));
assert.ok(html.includes('<b>강조</b> 문장 &lt;script&gt;'));
assert.ok(html.includes('<span class="cue">(B키로 화면 복귀 후 넘김)</span>'));
console.log('logic OK');
