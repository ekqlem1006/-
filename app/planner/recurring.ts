// 반복 할 일 — 규칙(요일·달)에 맞는 날짜마다 실제 할 일 문서를 미리 만들어 둔다.
// 규칙을 화면에서만 계산하지 않고 문서로 만들어 두는 이유: 안드로이드 위젯은
// users/{uid}/todos 만 읽기 때문에, 문서로 존재해야 위젯에도 그대로 보인다.

export interface Rule {
  id: string;
  text: string;
  weekday: number; // 0(일) ~ 6(토)
  // 있으면 "선택한 달에만" 규칙. 값은 'YYYY-MM' 목록.
  months?: string[];
  // months 중 이미 할 일을 만들어 둔 달 (지운 할 일이 다시 생기지 않도록 기록)
  generatedMonths?: string[];
}

export interface PlannerSettings {
  rules: Rule[];
  // 매주 규칙별로 어느 날짜까지 만들어 두었는지 (rule.id → 'YYYY-MM-DD')
  generatedUntil: Record<string, string>;
}

export interface NewTodo {
  id: string;
  text: string;
  date: string;
}

// 매주 규칙은 오늘부터 이만큼 앞까지 미리 만들어 둔다.
// 웹 플래너를 열 때만 만들어지므로, 한동안 위젯만 써도 비지 않도록 넉넉히 잡는다.
export const HORIZON_DAYS = 84;

export const DEFAULT_RULES: Rule[] = [
  { id: 'wedTeacher', text: '교사 기도회 설교문 준비하기', weekday: 3 },
  { id: 'friJubo', text: '토요일 주보 준비하기', weekday: 5 },
  { id: 'friSermon', text: '설교문 준비하기', weekday: 5 },
  { id: 'friPpt', text: '피피티 준비하기', weekday: 5 },
  { id: 'friAd', text: '광고 피피티 만들기', weekday: 5 },
  { id: 'starlight', text: '별빛예배 설교문 준비하기', weekday: 3, months: [], generatedMonths: [] },
];

export function toKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, n: number): string {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

export function instanceId(ruleId: string, date: string): string {
  return `r-${ruleId}-${date}`;
}

export function instancePrefix(ruleId: string, month = ''): string {
  return `r-${ruleId}-${month}`;
}

/** from~to(포함) 사이에서 요일이 맞는 날짜들 */
function matchingDates(from: string, to: string, weekday: number): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to && fromKey(cur).getDay() !== weekday) cur = addDays(cur, 1);
  for (; cur <= to; cur = addDays(cur, 7)) out.push(cur);
  return out;
}

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return toKey(new Date(y, m, 0));
}

/**
 * 아직 만들지 않은 반복 할 일과, 그걸 만든 뒤의 설정을 계산한다.
 * 만들 것이 없으면 null. 지난 날짜는 만들지 않는다.
 */
export function planGeneration(
  settings: PlannerSettings,
  today: string
): { todos: NewTodo[]; settings: PlannerSettings } | null {
  const todos: NewTodo[] = [];
  const generatedUntil = { ...settings.generatedUntil };
  const horizon = addDays(today, HORIZON_DAYS);
  let changed = false;

  const rules = settings.rules.map((rule) => {
    if (rule.months) {
      const done = new Set(rule.generatedMonths ?? []);
      const pending = rule.months.filter((m) => !done.has(m));
      if (pending.length === 0) return rule;
      for (const month of pending) {
        const from = `${month}-01` < today ? today : `${month}-01`;
        for (const date of matchingDates(from, monthEnd(month), rule.weekday)) {
          todos.push({ id: instanceId(rule.id, date), text: rule.text, date });
        }
      }
      changed = true;
      return { ...rule, generatedMonths: [...done, ...pending].sort() };
    }

    const until = generatedUntil[rule.id];
    if (until && until >= horizon) return rule;
    const from = until && addDays(until, 1) > today ? addDays(until, 1) : today;
    for (const date of matchingDates(from, horizon, rule.weekday)) {
      todos.push({ id: instanceId(rule.id, date), text: rule.text, date });
    }
    generatedUntil[rule.id] = horizon;
    changed = true;
    return rule;
  });

  return changed ? { todos, settings: { rules, generatedUntil } } : null;
}
