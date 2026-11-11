'use client';

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { db, auth, googleProvider } from '@/lib/firebase';
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  DEFAULT_RULES,
  PlannerSettings,
  Rule,
  addDays,
  fromKey,
  instancePrefix,
  planGeneration,
  toKey,
} from './recurring';

interface Todo {
  id: string;
  text: string;
  date: string; // YYYY-MM-DD (기기 현지 날짜)
  done: boolean;
  createdAt: number;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function weekOf(key: string): string[] {
  const start = addDays(key, -fromKey(key).getDay());
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function formatLong(key: string): string {
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export default function PlannerApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  // 어느 계정의 목록인지 함께 들고 있어서, 계정이 바뀌면 이전 목록이 잠깐이라도 보이지 않는다
  const [data, setData] = useState<{ uid: string; todos: Todo[] } | null>(null);
  const [syncError, setSyncError] = useState('');
  const [loginError, setLoginError] = useState('');
  const isOnline = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

  const [today, setToday] = useState(() => toKey(new Date()));
  const [selected, setSelected] = useState(() => toKey(new Date()));
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 반복 할 일 설정 (users/{uid}/settings/planner). exists=false 는 "서버에 아직 문서가 없음".
  const [settingsSnap, setSettingsSnap] = useState<{
    uid: string;
    exists: boolean;
    fromServer: boolean;
    value: PlannerSettings;
  } | null>(null);
  const [showRecurring, setShowRecurring] = useState(false);
  const [ruleText, setRuleText] = useState('');
  const [ruleWeekday, setRuleWeekday] = useState(3);
  const [ruleByMonth, setRuleByMonth] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
  }, []);

  // 서비스워커 등록 · 자정이 지나면 "오늘" 갱신
  useEffect(() => {
    const refreshToday = () => setToday(toKey(new Date()));
    window.addEventListener('focus', refreshToday);
    document.addEventListener('visibilitychange', refreshToday);
    const timer = setInterval(refreshToday, 60_000);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    return () => {
      window.removeEventListener('focus', refreshToday);
      document.removeEventListener('visibilitychange', refreshToday);
      clearInterval(timer);
    };
  }, []);

  // 할 일 실시간 동기화 (오프라인에서는 기기 캐시에서 바로 읽고, 연결되면 자동 반영)
  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    return onSnapshot(
      collection(db, 'users', user.uid, 'todos'),
      (snap) => {
        setData({
          uid,
          todos: snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Todo, 'id'>) })),
        });
        setSyncError('');
      },
      (err) => {
        console.error('플래너 동기화 에러:', err);
        setSyncError(err.code || err.message);
        setData({ uid, todos: [] });
      }
    );
  }, [user]);

  const loaded = !!user && data?.uid === user.uid;
  const todos = useMemo(() => (loaded && data ? data.todos : []), [loaded, data]);

  // 반복 설정 실시간 동기화
  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    return onSnapshot(
      doc(db, 'users', uid, 'settings', 'planner'),
      { includeMetadataChanges: true },
      (snap) => {
        const raw = snap.data() as Partial<PlannerSettings> | undefined;
        setSettingsSnap({
          uid,
          exists: snap.exists(),
          fromServer: !snap.metadata.fromCache,
          value: { rules: raw?.rules ?? [], generatedUntil: raw?.generatedUntil ?? {} },
        });
      },
      (err) => {
        console.error('반복 설정 동기화 에러:', err);
        setSyncError(err.code || err.message);
      }
    );
  }, [user]);

  const settings = user && settingsSnap?.uid === user.uid ? settingsSnap : null;
  const rules = settings?.value.rules ?? [];

  // 반복 할 일 만들기. 서버에서 확인된 설정일 때만 돈다 — 캐시만 보고 돌리면
  // "문서 없음"으로 착각해 기본 규칙을 덮어쓰거나, 지운 할 일을 다시 만들 수 있다.
  useEffect(() => {
    if (!user || !loaded || !settings?.fromServer) return;
    const uid = user.uid;
    const settingsRef = doc(db, 'users', uid, 'settings', 'planner');
    const onError = (err: { code?: string; message?: string }) => {
      console.error('반복 할 일 생성 에러:', err);
      setSyncError(err.code || err.message || '알 수 없는 오류');
    };

    if (!settings.exists) {
      // 처음 한 번만 기본 규칙을 넣는다. 이후에는 지워도 다시 생기지 않는다.
      setDoc(settingsRef, { rules: DEFAULT_RULES, generatedUntil: {} }).catch(onError);
      return;
    }
    const plan = planGeneration(settings.value, today);
    if (!plan) return;
    const existing = new Set(todos.map((t) => t.id));
    const batch = writeBatch(db);
    const now = Date.now();
    plan.todos.forEach((t, i) => {
      if (existing.has(t.id)) return;
      batch.set(doc(db, 'users', uid, 'todos', t.id), {
        text: t.text,
        date: t.date,
        done: false,
        createdAt: now + i,
      });
    });
    batch.set(settingsRef, plan.settings);
    batch.commit().catch(onError);
    // todos 는 "이미 있는 문서 건너뛰기"에만 쓰므로, 목록이 바뀔 때마다 다시 돌 필요는 없다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loaded, settings, today]);

  // 첫 클릭 때 Firebase가 로그인 준비(iframe 로드)를 하느라 시간이 걸리면 브라우저가
  // "사용자가 누른 것이 아닌 팝업"으로 보고 막아 버린다. 로그인 화면이 뜰 때 미리 준비해 둔다.
  // (공개 API가 없어 내부 필드를 쓰므로, 없어져도 조용히 넘어가게 한다)
  useEffect(() => {
    if (authLoading || user) return;
    try {
      const internal = auth as unknown as {
        _popupRedirectResolver?: { _initialize?: (a: unknown) => Promise<unknown> };
      };
      internal._popupRedirectResolver?._initialize?.(auth)?.catch(() => {});
    } catch {}
  }, [authLoading, user]);

  // 팝업이 막혔을 때 페이지 이동 방식(signInWithRedirect)으로 넘기지 않는다 — 요즘 브라우저는
  // 다른 도메인(firebaseapp.com)의 저장소 접근을 막아서, 구글에서 돌아와도 로그인이 되지 않고
  // 로그인 화면만 다시 뜬다. 대신 팝업을 허용하도록 안내한다.
  const handleLogin = async () => {
    setLoginError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'auth/popup-blocked') {
        setLoginError(
          '브라우저가 로그인 창(팝업)을 막았습니다. 주소창 오른쪽의 팝업 차단 아이콘을 눌러 이 사이트의 팝업을 허용한 뒤, 로그인 버튼을 다시 눌러 주세요.'
        );
      } else if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        setLoginError('로그인 창이 닫혔습니다. 다시 눌러 계정을 선택해 주세요.');
      } else {
        setLoginError(`로그인에 실패했습니다. [${err.code}] ${err.message ?? ''}`);
      }
    }
  };

  const handleLogout = async () => {
    if (confirm('로그아웃 하시겠습니까?')) await signOut(auth);
  };

  // 쓰기는 기다리지 않는다 — 오프라인에서는 서버 응답이 올 때까지 promise가 끝나지 않고,
  // 화면은 onSnapshot이 로컬 캐시 기준으로 즉시 갱신해 준다.
  const fail = (err: { code?: string; message?: string }) => {
    console.error('플래너 저장 에러:', err);
    setSyncError(err.code || err.message || '알 수 없는 오류');
  };
  const todoRef = (id: string) => doc(db, 'users', user!.uid, 'todos', id);

  const addTodo = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !user) return;
    const ref = doc(collection(db, 'users', user.uid, 'todos'));
    setDoc(ref, { text, date: selected, done: false, createdAt: Date.now() }).catch(fail);
    setDraft('');
    inputRef.current?.focus();
  };

  const toggle = (t: Todo) => updateDoc(todoRef(t.id), { done: !t.done }).catch(fail);
  const remove = (t: Todo) => deleteDoc(todoRef(t.id)).catch(fail);
  const moveTo = (t: Todo, date: string) => updateDoc(todoRef(t.id), { date }).catch(fail);

  // ── 반복 규칙 편집 ──
  const saveRules = (next: Rule[]) => {
    if (!user || !settings) return;
    setDoc(doc(db, 'users', user.uid, 'settings', 'planner'), {
      rules: next,
      generatedUntil: settings.value.generatedUntil,
    }).catch(fail);
  };

  // 규칙에서 만들어진 할 일 중 아직 안 끝낸 것만 지운다 (끝낸 기록은 남긴다)
  const removeInstances = (prefix: string, fromDate: string) => {
    if (!user) return;
    const targets = todos.filter((t) => t.id.startsWith(prefix) && !t.done && t.date >= fromDate);
    if (targets.length === 0) return;
    const batch = writeBatch(db);
    targets.forEach((t) => batch.delete(todoRef(t.id)));
    batch.commit().catch(fail);
  };

  const addRule = (e: React.FormEvent) => {
    e.preventDefault();
    const text = ruleText.trim();
    if (!text) return;
    const rule: Rule = { id: `u${Date.now().toString(36)}`, text, weekday: ruleWeekday };
    if (ruleByMonth) {
      rule.months = [];
      rule.generatedMonths = [];
    }
    saveRules([...rules, rule]);
    setRuleText('');
  };

  const removeRule = (rule: Rule) => {
    if (!confirm(`"${rule.text}" 반복을 삭제할까요?\n앞으로 예정된 할 일도 함께 지워집니다.`)) return;
    saveRules(rules.filter((r) => r.id !== rule.id));
    removeInstances(instancePrefix(rule.id), today);
  };

  const toggleMonth = (rule: Rule, month: string) => {
    const on = rule.months?.includes(month);
    const next: Rule = on
      ? {
          ...rule,
          months: (rule.months ?? []).filter((m) => m !== month),
          generatedMonths: (rule.generatedMonths ?? []).filter((m) => m !== month),
        }
      : { ...rule, months: [...(rule.months ?? []), month].sort() };
    saveRules(rules.map((r) => (r.id === rule.id ? next : r)));
    if (on) removeInstances(instancePrefix(rule.id, month), today);
  };

  // 이번 달부터 12개월
  const monthChoices = useMemo(() => {
    const base = fromKey(today);
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const key = toKey(d).slice(0, 7);
      const label =
        i > 0 && d.getMonth() === 0
          ? `${String(d.getFullYear()).slice(2)}년 1월`
          : `${d.getMonth() + 1}월`;
      return { key, label };
    });
  }, [today]);

  const startEdit = (t: Todo) => {
    setEditingId(t.id);
    setEditText(t.text);
  };
  const commitEdit = () => {
    const t = todos.find((x) => x.id === editingId);
    const text = editText.trim();
    if (t && text && text !== t.text) updateDoc(todoRef(t.id), { text }).catch(fail);
    setEditingId(null);
  };

  const dayTodos = useMemo(
    () =>
      todos
        .filter((t) => t.date === selected)
        .sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt),
    [todos, selected]
  );
  const overdue = useMemo(
    () =>
      todos
        .filter((t) => !t.done && t.date < today)
        .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt),
    [todos, today]
  );
  const remainingByDate = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of todos) if (!t.done) map[t.date] = (map[t.date] || 0) + 1;
    return map;
  }, [todos]);

  const week = weekOf(selected);
  const doneCount = dayTodos.filter((t) => t.done).length;

  if (authLoading) {
    return (
      <main className="flex min-h-dvh flex-1 items-center justify-center text-neutral-400">
        불러오는 중...
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <div>
          <h1 className="text-3xl font-bold">플래너</h1>
          <p className="mt-2 text-neutral-500">
            로그인하면 윈도우 · 맥 · 갤럭시 어디서든
            <br />
            같은 할 일 목록을 이어서 쓸 수 있어요.
          </p>
        </div>
        <button
          onClick={handleLogin}
          className="rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white active:bg-blue-700"
        >
          Google 계정으로 로그인
        </button>
        {loginError && (
          <p
            role="alert"
            className="max-w-sm rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {loginError}
          </p>
        )}
      </main>
    );
  }

  const renderTodo = (t: Todo, extra?: React.ReactNode) => (
    <li
      key={t.id}
      className="group flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <button
        onClick={() => toggle(t)}
        role="checkbox"
        aria-checked={t.done}
        aria-label={t.done ? '완료 취소' : '완료로 표시'}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold transition-colors ${
          t.done
            ? 'border-blue-600 bg-blue-600 text-white'
            : 'border-neutral-300 text-transparent hover:border-blue-500 dark:border-neutral-600'
        }`}
      >
        ✓
      </button>

      {editingId === t.id ? (
        <input
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditingId(null);
          }}
          className="min-w-0 flex-1 rounded bg-neutral-100 px-2 py-1 outline-none dark:bg-neutral-800"
        />
      ) : (
        <button
          onClick={() => startEdit(t)}
          title="눌러서 수정"
          className={`min-w-0 flex-1 py-1 text-left break-words ${
            t.done ? 'text-neutral-400 line-through' : ''
          }`}
        >
          {t.text}
        </button>
      )}

      {extra}
      <button
        onClick={() => remove(t)}
        aria-label="삭제"
        className="shrink-0 rounded-lg px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-500 dark:hover:bg-neutral-800"
      >
        ✕
      </button>
    </li>
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col px-4 pb-10">
      <header className="flex items-center justify-between py-4">
        <h1 className="text-xl font-bold">플래너</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span
            className={syncError ? 'text-red-500' : ''}
            title={syncError ? `동기화 오류: ${syncError}` : undefined}
          >
            {syncError ? '⚠ 동기화 오류' : isOnline ? '● 동기화됨' : '○ 오프라인'}
          </span>
          <button
            onClick={() => setShowRecurring((v) => !v)}
            aria-expanded={showRecurring}
            className={`hover:text-neutral-800 dark:hover:text-neutral-200 ${
              showRecurring ? 'font-semibold text-blue-600' : ''
            }`}
          >
            반복
          </button>
          <button onClick={handleLogout} className="hover:text-neutral-800 dark:hover:text-neutral-200">
            로그아웃
          </button>
        </div>
      </header>

      {syncError && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          클라우드 저장에 실패했습니다 ({syncError}). Firestore 보안 규칙에서
          <code className="mx-1">users/&#123;uid&#125;/todos</code>
          접근이 허용되어 있는지 확인해 주세요.
        </p>
      )}

      {showRecurring && (
        <section className="mb-5 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <h2 className="mb-1 font-bold">반복 할 일</h2>
          <p className="mb-3 text-sm text-neutral-500">
            정해 둔 요일마다 할 일이 자동으로 들어갑니다. 달을 고르는 반복은 선택한 달에만 들어갑니다.
          </p>

          {!settings ? (
            <p className="py-4 text-center text-sm text-neutral-400">불러오는 중...</p>
          ) : rules.length === 0 ? (
            <p className="py-4 text-center text-sm text-neutral-400">반복 할 일이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                      {rule.months ? '선택한 달' : '매주'} {WEEKDAYS[rule.weekday]}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{rule.text}</span>
                    <button
                      onClick={() => removeRule(rule)}
                      aria-label={`${rule.text} 반복 삭제`}
                      className="shrink-0 rounded-lg px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-500 dark:hover:bg-neutral-800"
                    >
                      ✕
                    </button>
                  </div>
                  {rule.months && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {monthChoices.map((m) => {
                        const on = rule.months!.includes(m.key);
                        return (
                          <button
                            key={m.key}
                            onClick={() => toggleMonth(rule, m.key)}
                            aria-pressed={on}
                            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                              on
                                ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                                : 'border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300'
                            }`}
                          >
                            {m.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={addRule} className="mt-4 flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <div className="flex gap-2">
              <select
                value={ruleWeekday}
                onChange={(e) => setRuleWeekday(Number(e.target.value))}
                aria-label="요일"
                className="rounded-lg border border-neutral-300 bg-white px-2 py-2 dark:border-neutral-700 dark:bg-neutral-900"
              >
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}요일
                  </option>
                ))}
              </select>
              <input
                value={ruleText}
                onChange={(e) => setRuleText(e.target.value)}
                placeholder="반복할 일"
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                type="submit"
                disabled={!ruleText.trim() || !settings}
                className="rounded-lg bg-blue-600 px-4 font-semibold text-white disabled:opacity-40"
              >
                추가
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={ruleByMonth}
                onChange={(e) => setRuleByMonth(e.target.checked)}
              />
              매주가 아니라, 내가 고른 달에만 넣기
            </label>
          </form>
        </section>
      )}

      {/* 주간 날짜 선택 */}
      <nav className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <button
            onClick={() => setSelected(addDays(selected, -7))}
            aria-label="이전 주"
            className="rounded-lg px-3 py-1 text-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            ‹
          </button>
          <div className="flex items-center gap-2">
            <span className="font-semibold">
              {fromKey(selected).getFullYear()}년 {fromKey(selected).getMonth() + 1}월
            </span>
            {selected !== today && (
              <button
                onClick={() => setSelected(today)}
                className="rounded-full bg-blue-50 px-3 py-0.5 text-sm font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              >
                오늘
              </button>
            )}
          </div>
          <button
            onClick={() => setSelected(addDays(selected, 7))}
            aria-label="다음 주"
            className="rounded-lg px-3 py-1 text-lg hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {week.map((key) => {
            const d = fromKey(key);
            const isSel = key === selected;
            const isToday = key === today;
            return (
              <button
                key={key}
                onClick={() => setSelected(key)}
                aria-current={isSel ? 'date' : undefined}
                className={`flex flex-col items-center rounded-xl py-2 transition-colors ${
                  isSel
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
              >
                <span
                  className={`text-xs ${
                    isSel ? 'text-blue-100' : d.getDay() === 0 ? 'text-red-500' : 'text-neutral-500'
                  }`}
                >
                  {WEEKDAYS[d.getDay()]}
                </span>
                <span className={`text-lg ${isToday ? 'font-extrabold' : 'font-medium'}`}>
                  {d.getDate()}
                </span>
                <span
                  className={`mt-0.5 h-1.5 w-1.5 rounded-full ${
                    remainingByDate[key] ? (isSel ? 'bg-white' : 'bg-blue-500') : 'bg-transparent'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </nav>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-bold">
          {formatLong(selected)}
          {selected === today && <span className="ml-2 text-sm font-medium text-blue-600">오늘</span>}
        </h2>
        {dayTodos.length > 0 && (
          <span className="text-sm text-neutral-500">
            {doneCount} / {dayTodos.length} 완료
          </span>
        )}
      </div>

      <form onSubmit={addTodo} className="mb-4 flex gap-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="할 일을 입력하고 Enter"
          enterKeyHint="done"
          className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-4 py-3 outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-xl bg-blue-600 px-5 font-semibold text-white disabled:opacity-40"
        >
          추가
        </button>
      </form>

      {!loaded ? (
        <p className="py-10 text-center text-neutral-400">불러오는 중...</p>
      ) : dayTodos.length === 0 ? (
        <p className="py-10 text-center text-neutral-400">이 날은 할 일이 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-2">{dayTodos.map((t) => renderTodo(t))}</ul>
      )}

      {/* 지난 날짜에 끝내지 못한 일 — 오늘 화면에서만 보여 준다 */}
      {selected === today && overdue.length > 0 && (
        <section className="mt-8">
          <h3 className="mb-2 text-sm font-semibold text-neutral-500">
            밀린 할 일 {overdue.length}개
          </h3>
          <ul className="flex flex-col gap-2">
            {overdue.map((t) =>
              renderTodo(
                t,
                <span className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
                  {fromKey(t.date).getMonth() + 1}/{fromKey(t.date).getDate()}
                  <button
                    onClick={() => moveTo(t, today)}
                    className="rounded-full bg-neutral-100 px-2 py-1 font-medium text-neutral-700 hover:bg-blue-50 hover:text-blue-700 dark:bg-neutral-800 dark:text-neutral-300"
                  >
                    오늘로
                  </button>
                </span>
              )
            )}
          </ul>
        </section>
      )}
    </main>
  );
}
