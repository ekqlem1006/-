'use client';

import React, { useState, useEffect, useRef } from 'react';
import { db, auth, googleProvider } from '@/lib/firebase';
import {
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  setDoc,
  addDoc,
  deleteDoc,
} from 'firebase/firestore';

// 기본 분류 목록
const DEFAULT_CATEGORIES = [
  { id: 'sunday', name: '주일설교' },
  { id: 'dawn', name: '새벽기도' },
  { id: 'wednesday', name: '수요예배' },
  { id: 'special', name: '특별/기타' },
];

interface Category {
  id: string;
  name: string;
}

interface Sermon {
  id: string;
  title: string;
  date: string;
  scripture: string;
  content: string;
  category: string;
  updatedAt: string;
  order?: number;
}

// ── 본문 저장 형식 헬퍼 ──────────────────────────────────────────
// 옛 설교는 평문 + ==형광펜== 마커로 저장되어 있고, 새 에디터는 표를 담을 수
// 있는 HTML로 저장한다. 읽을 때 평문이면 그 자리에서 HTML로 승격시켜서
// 두 형식을 영구히 같이 처리하지 않도록 한다.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isHtml(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str);
}

function legacyMarksToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const withMarks = escaped.replace(
    /==(?:([ygp]):)?([\s\S]*?)==/g,
    (_m, colorCode: string | undefined, inner: string) => {
      const cls = colorCode === 'g' ? 'hl-green' : colorCode === 'p' ? 'hl-pink' : 'hl-yellow';
      return `<mark class="${cls}">${inner}</mark>`;
    }
  );
  return withMarks.replace(/\n/g, '<br>');
}

function ensureHtml(raw: string): string {
  if (!raw) return '';
  return isHtml(raw) ? raw : legacyMarksToHtml(raw);
}

// 검색 매칭/스니펫은 항상 태그를 걷어낸 평문 기준으로 계산한다 (오프셋이
// contentEditable의 텍스트 노드 순회와 1:1로 맞아야 해서 치환만 하고 아무 것도 끼워넣지 않음)
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// 태그 안쪽은 건드리지 않고, 텍스트 구간에만 검색어 하이라이트 마크를 끼워넣는다
function highlightHtml(html: string, query: string): string {
  const q = query.trim();
  if (!q) return html;
  const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedQ, 'gi');
  return html.replace(/(<[^>]+>)|([^<]+)/g, (whole, tag: string, text: string) => {
    if (tag) return tag;
    return text.replace(regex, (m: string) => `<mark class="hl-search">${m}</mark>`);
  });
}

function findTextNodeAndOffset(
  root: Node,
  targetOffset: number
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (consumed + len >= targetOffset) {
      return { node, offset: targetOffset - consumed };
    }
    consumed += len;
  }
  return null;
}

function unwrapMark(markEl: Element) {
  const parent = markEl.parentNode;
  if (!parent) return;
  while (markEl.firstChild) parent.insertBefore(markEl.firstChild, markEl);
  parent.removeChild(markEl);
}

const BLOCK_TAGS = new Set([
  'DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH',
]);

// <mark>은 인라인 태그라 <div> 같은 블록을 감쌀 수 없다 — 그렇게 하면 브라우저가
// HTML을 파싱하면서 mark를 앞/뒤로 쪼개버린다 (여러 줄 선택 시 "앞뒤로 반만 칠해지는" 버그).
// 그래서 블록 경계는 그대로 두고, 그 안에 있는 인라인 내용(텍스트/<br>)만 이어서 감싼다 —
// 한 줄짜리 선택은 통째로 하나의 <mark>가 되고, 여러 줄(= 여러 블록)이면 줄마다 각각 감싼다.
function wrapInlineRuns(parent: Node, className: string) {
  const children = Array.from(parent.childNodes);
  let currentMark: HTMLElement | null = null;

  for (const child of children) {
    const isBlock = child.nodeType === 1 && BLOCK_TAGS.has((child as Element).tagName);
    if (isBlock) {
      currentMark = null;
      wrapInlineRuns(child, className);
    } else {
      if (!currentMark) {
        currentMark = document.createElement('mark');
        currentMark.className = className;
        parent.insertBefore(currentMark, child);
      }
      currentMark.appendChild(child);
    }
  }
}

export default function SermonApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);


  const [categories, setCategories] = useState<Category[]>(DEFAULT_CATEGORIES);
  const [currentCategory, setCurrentCategory] = useState('sunday');
  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);

  // 사이드바 토글 (기본 열림)
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // 본문 뷰 모드: 'edit'(수정만, 기본값) | 'split'(나란히 보기) | 'preview'(보기만)
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('edit');

  // 모바일 드릴다운: 분류 목록 → 설교 목록 → 편집창 (데스크톱에서는 셋 다 한 화면에 표시)
  const [mobilePane, setMobilePane] = useState<'categories' | 'sermons' | 'editor'>('categories');
  const pendingRestoreIdRef = useRef<string | null>(null);

  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [scripture, setScripture] = useState('');
  const [content, setContent] = useState('');
  const [syncStatus, setSyncStatus] = useState('동기화 완료');
  const [isOnline, setIsOnline] = useState(true);

  // ↶ 되돌리기 / ↷ 다시 실행 독립 히스토리
  const historyRef = useRef<{ past: string[]; future: string[] }>({
    past: [],
    future: [],
  });
  const [historyCount, setHistoryCount] = useState({ past: 0, future: 0 });
  const contentRef = useRef(content);
  contentRef.current = content;

  // 타이핑 감지용 Ref
  const isTypingBatchRef = useRef(false);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 통합 검색 상태
  const [searchQuery, setSearchQuery] = useState('');
  const [allSermonsForSearch, setAllSermonsForSearch] = useState<Sermon[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  // 강단 모드 및 타이머
  const [isPulpitMode, setIsPulpitMode] = useState(false);
  const [fontSize, setFontSize] = useState(24);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);

  // 본문을 아래로 스크롤하면 제목/날짜/본문 구절 칸을 숨겨서 쓰는 공간을 넓혀준다
  const [showMetaFields, setShowMetaFields] = useState(true);
  const lastScrollTopRef = useRef(0);
  const scrollDebounceRef = useRef<NodeJS.Timeout | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editableRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  // 형광펜 버튼을 누르는 순간(특히 모바일) 브라우저가 드래그 선택을 먼저
  // 풀어버리는 경우가 있어서, 선택이 바뀔 때마다 마지막 드래그 범위를 따로 저장해둔다
  const savedRangeRef = useRef<Range | null>(null);

  // activeId 변경 시 Ref 동기화
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // 🔖 마지막으로 보던 분류/설교 복원 (앱을 다시 켰을 때 늘 첫 분류로 돌아가지 않도록)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = JSON.parse(localStorage.getItem('sermon_last_open') || 'null');
      if (saved?.category) {
        setCurrentCategory(saved.category);
        pendingRestoreIdRef.current = saved.id || null;
        setMobilePane(saved.id ? 'editor' : 'sermons');
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 현재 보고 있는 분류/설교를 기억해 둔다
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('sermon_last_open', JSON.stringify({ category: currentCategory, id: activeId }));
  }, [currentCategory, activeId]);

  // 히스토리 상태 업데이트 헬퍼
  // 구글 로그인 상태 감지
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      if (err.code === 'auth/popup-blocked') {
        // 팝업이 차단된 기기(아이폰 사파리/크롬 팝업 제한 등)에서는 페이지 이동 방식으로 자동 전환
        await signInWithRedirect(auth, googleProvider);
      } else {
        console.error('로그인 에러:', err);
        alert(`로그인 실패 코드: [${err.code}]\n${err.message}`);
      }
    }
  };

  const handleLogout = async () => {
    if (confirm('로그아웃 하시겠습니까?')) {
      await signOut(auth);
      setActiveId(null);
      activeIdRef.current = null;
      setSermons([]);
      setAllSermonsForSearch([]);
      setCategories(DEFAULT_CATEGORIES);
      // 같은 기기를 다른 계정이 쓸 때 이전 계정 캐시가 보이지 않도록
      Object.keys(localStorage)
        .filter((k) => /^(sermons_|all_sermons_backup|sermon_categories|sermon_last_open)/.test(k))
        .forEach((k) => localStorage.removeItem(k));
    }
  };

  const updateHistoryState = () => {
    setHistoryCount({
      past: historyRef.current.past.length,
      future: historyRef.current.future.length,
    });
  };

  // 현재 본문 상태를 되돌리기 스택에 기록
  const recordHistoryBeforeChange = (textToSave: string) => {
    historyRef.current.past.push(textToSave);
    if (historyRef.current.past.length > 40) {
      historyRef.current.past.shift();
    }
    historyRef.current.future = [];
    updateHistoryState();
  };

  // 본문 타이핑 핸들러 (contentEditable DOM이 원본이고, state는 그걸 따라간다)
  const handleEditableInput = () => {
    const newHtml = editableRef.current?.innerHTML ?? '';
    const currentHtml = contentRef.current;
    const targetId = activeIdRef.current; // 지금 바로 읽어서 묶어둔다 — 0.4초 뒤 다른 설교로 넘어가도 안전하게

    if (!isTypingBatchRef.current) {
      recordHistoryBeforeChange(currentHtml);
      isTypingBatchRef.current = true;
    }

    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingBatchRef.current = false;
    }, 800);

    setContent(newHtml);

    setSyncStatus('저장 대기 중...');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveToCloud(targetId, title, date, scripture, newHtml);
    }, 400);
  };

  // 표 삽입/형광펜처럼 DOM을 직접 바꾼 뒤 state·클라우드에 그 결과를 반영할 때 쓴다
  const commitChange = () => {
    const html = editableRef.current?.innerHTML ?? '';
    setContent(html);
    setSyncStatus('저장 대기 중...');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveToCloud(activeIdRef.current, title, date, scripture, html);
  };

  // 다른 설교를 선택했거나(화면 전환) 보기 모드를 바꿔서 에디터 DOM이 다시
  // 그려졌을 때만 내용을 채워 넣는다. 타이핑 중에는 절대 다시 쓰지 않는다
  // (그러면 매 글자마다 커서가 맨 앞으로 튀어버린다).
  // isPulpitMode도 포함: 강단 모드는 별도 return 분기라 편집창 DOM이 통째로
  // 사라졌다가 돌아올 때 새로 생기므로, 그때도 다시 채워 넣어야 한다.
  useEffect(() => {
    if (editableRef.current) {
      editableRef.current.innerHTML = ensureHtml(contentRef.current);
    }
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    setShowMetaFields(true);
    lastScrollTopRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, viewMode, isPulpitMode]);

  // 본문 스크롤 방향에 따라 제목/날짜/본문 구절 칸을 숨기거나 보여준다.
  // 붙여넣기로 본문이 갑자기 길어지면 브라우저가 커서를 보이게 하려고 스크롤을
  // 여러 번 잘게 움직이는데, 그걸 그대로 따라가면 숨김/보임이 깜빡인다. 그래서
  // 스크롤이 잠시 멈춘 뒤의 최종 위치만 보고 판단한다.
  const handleEditorScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(() => {
      const last = lastScrollTopRef.current;
      if (top <= 4) {
        setShowMetaFields(true);
      } else if (top > last + 4) {
        setShowMetaFields(false);
      } else if (top < last - 4) {
        setShowMetaFields(true);
      }
      lastScrollTopRef.current = top;
    }, 120);
  };

  // 설교를 바꾸면 이전 설교의 드래그 범위를 들고 있지 않도록 비운다
  useEffect(() => {
    savedRangeRef.current = null;
  }, [activeId]);

  // 드래그로 선택한 범위를 실시간으로 저장해 둔다 (형광펜 버튼 클릭 시점엔
  // 이미 선택이 풀려 있을 수 있어서, 버튼이 눌리는 순간 새로 묻는 대신 이걸 쓴다)
  useEffect(() => {
    const handleSelectionChange = () => {
      const sel = window.getSelection();
      const editable = editableRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !editable) return;
      const range = sel.getRangeAt(0);
      if (editable.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange();
      }
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  // ↶ 되돌리기 (Undo)
  const handleUndo = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    isTypingBatchRef.current = false;

    if (historyRef.current.past.length === 0) {
      alert('되돌릴 이전 작업 내역이 없습니다.');
      return;
    }

    const previous = historyRef.current.past.pop()!;
    historyRef.current.future.unshift(contentRef.current);
    updateHistoryState();

    if (editableRef.current) editableRef.current.innerHTML = previous;
    setContent(previous);
    saveToCloud(activeIdRef.current, title, date, scripture, previous);

    setTimeout(() => editableRef.current?.focus(), 20);
  };

  // ↷ 다시 실행 (Redo)
  const handleRedo = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    isTypingBatchRef.current = false;

    if (historyRef.current.future.length === 0) {
      alert('다시 실행할 다음 작업 내역이 없습니다.');
      return;
    }

    const next = historyRef.current.future.shift()!;
    historyRef.current.past.push(contentRef.current);
    updateHistoryState();

    if (editableRef.current) editableRef.current.innerHTML = next;
    setContent(next);
    saveToCloud(activeIdRef.current, title, date, scripture, next);

    setTimeout(() => editableRef.current?.focus(), 20);
  };

  // Enter로 줄바꿈할 때 브라우저 기본값(새 <div> 생성) 대신 <br>을 쓰게 한다 —
  // 그래야 여러 줄을 형광펜으로 선택했을 때 줄마다 블록으로 쪼개지지 않는다.
  useEffect(() => {
    try {
      document.execCommand('defaultParagraphSeparator', false, 'br');
    } catch {}
  }, []);

  // 오프라인 상태 감지 및 서비스워커 등록
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsOnline(navigator.onLine);

      const handleOnline = () => {
        setIsOnline(true);
        setSyncStatus('온라인 복구 (동기화 완료)');
      };
      const handleOffline = () => {
        setIsOnline(false);
        setSyncStatus('오프라인 모드 (기기 로컬 저장됨)');
      };

      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      }

      return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    }
  }, []);

  // 📁 분류(카테고리) 목록 로드 및 실시간 동기화
  useEffect(() => {
    if (!user) return;
    if (typeof window !== 'undefined') {
      const cachedCats = localStorage.getItem('sermon_categories');
      if (cachedCats) {
        try {
          const parsed = JSON.parse(cachedCats);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setCategories(parsed);
          }
        } catch (e) {}
      }
    }

    const catDocRef = doc(db, 'users', user!.uid, 'settings', 'categories');
    const unsubscribe = onSnapshot(
      catDocRef,
      (snapshot) => {
        if (snapshot.exists() && snapshot.data()?.list) {
          const cloudCats: Category[] = snapshot.data().list;
          if (cloudCats.length > 0) {
            setCategories(cloudCats);
            if (typeof window !== 'undefined') {
              localStorage.setItem('sermon_categories', JSON.stringify(cloudCats));
            }
          }
        } else {
          // 최초 실행 시 기본 카테고리 Firestore에 저장
          setDoc(catDocRef, { list: DEFAULT_CATEGORIES }, { merge: true });
        }
      },
      () => {
        // 오프라인 에러 시 기본/캐시 유지
      }
    );

    return () => unsubscribe();
  }, [user]);

  // ➕ 새 분류 추가 함수
  const handleAddCategory = async () => {
    const name = prompt('추가할 새 예배/설교 분류 이름을 입력하세요:');
    if (!name || !name.trim()) return;

    const trimmedName = name.trim();
    if (categories.some((c) => c.name === trimmedName)) {
      alert('이미 존재하는 분류 이름입니다.');
      return;
    }

    const newCategory: Category = {
      id: `cat_${Date.now()}`,
      name: trimmedName,
    };

    const updated = [...categories, newCategory];
    setCategories(updated);
    setCurrentCategory(newCategory.id);
    setActiveId(null);
    activeIdRef.current = null;

    try {
      await setDoc(doc(db, 'users', user!.uid, 'settings', 'categories'), { list: updated });
      if (typeof window !== 'undefined') {
        localStorage.setItem('sermon_categories', JSON.stringify(updated));
      }
    } catch {
      alert('분류 저장 중 오류가 발생했습니다.');
    }
  };

  // ✏️ 분류 이름 변경
  const handleRenameCategory = async (cat: Category, e: React.MouseEvent) => {
    e.stopPropagation();
    const name = prompt('새 분류 이름을 입력하세요:', cat.name);
    if (!name || !name.trim() || name.trim() === cat.name) return;

    const trimmedName = name.trim();
    if (categories.some((c) => c.id !== cat.id && c.name === trimmedName)) {
      alert('이미 존재하는 분류 이름입니다.');
      return;
    }

    const updated = categories.map((c) => (c.id === cat.id ? { ...c, name: trimmedName } : c));
    setCategories(updated);

    try {
      await setDoc(doc(db, 'users', user!.uid, 'settings', 'categories'), { list: updated });
      if (typeof window !== 'undefined') {
        localStorage.setItem('sermon_categories', JSON.stringify(updated));
      }
    } catch {
      alert('분류 이름 변경 중 오류가 발생했습니다.');
    }
  };

  // ❌ 분류 삭제 함수 (비밀번호 0316 검증)
  const handleDeleteCategory = async (catToDelete: Category, e: React.MouseEvent) => {
    e.stopPropagation();

    if (categories.length <= 1) {
      alert('최소 1개의 분류는 유지되어야 합니다.');
      return;
    }

    // 해당 카테고리에 설교가 있는지 확인
    const sermonsInThisCat = allSermonsForSearch.filter((s) => s.category === catToDelete.id);
    let confirmPrompt = `'${catToDelete.name}' 분류를 삭제하시겠습니까?`;

    if (sermonsInThisCat.length > 0) {
      confirmPrompt += `\n\n⚠️ 주의: 이 분류에 작성된 설교가 총 ${sermonsInThisCat.length}개 있습니다.\n분류를 삭제해도 설교 원고 자체는 안전하게 보관되지만, 목록에서 찾기 어려워질 수 있습니다.`;
    }

    if (!confirm(confirmPrompt)) return;

    // 2차 보안 비밀번호 검증
    const updated = categories.filter((c) => c.id !== catToDelete.id);
    setCategories(updated);

    // 삭제된 카테고리를 보고 있었다면 첫 번째 카테고리로 안전 이동
    if (currentCategory === catToDelete.id) {
      setCurrentCategory(updated[0].id);
      setActiveId(null);
      activeIdRef.current = null;
    }

    try {
      await setDoc(doc(db, 'users', user!.uid, 'settings', 'categories'), { list: updated });
      if (typeof window !== 'undefined') {
        localStorage.setItem('sermon_categories', JSON.stringify(updated));
      }
    } catch {
      alert('분류 삭제 중 오류가 발생했습니다.');
    }
  };

  // 전체 설교 데이터 수집 (통합 검색용)
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'users', user!.uid, 'sermons'));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: Sermon[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          list.push({
            id: docSnap.id,
            title: data.title || '',
            date: data.date || '',
            scripture: data.scripture || '',
            content: data.content || '',
            category: data.category || 'sunday',
            updatedAt: data.updatedAt || '',
          });
        });
        setAllSermonsForSearch(list);
        if (typeof window !== 'undefined' && list.length > 0) {
          localStorage.setItem('all_sermons_backup', JSON.stringify(list));
        }
      },
      () => {
        if (typeof window !== 'undefined') {
          const cachedAll = localStorage.getItem('all_sermons_backup');
          if (cachedAll) {
            try {
              setAllSermonsForSearch(JSON.parse(cachedAll));
            } catch (e) {}
          }
        }
      }
    );
    return () => unsubscribe();
  }, [user]);

  // 현재 카테고리 설교 목록 로드
  useEffect(() => {
    if (!user) return;
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem(`sermons_${currentCategory}`);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.length > 0) {
            setSermons(parsed);
            if (!activeIdRef.current) {
              setActiveId(parsed[0].id);
              activeIdRef.current = parsed[0].id;
              setTitle(parsed[0].title);
              setDate(parsed[0].date);
              setScripture(parsed[0].scripture);
              setContent(parsed[0].content);
              historyRef.current = { past: [], future: [] };
              updateHistoryState();
            }
          }
        } catch (e) {}
      }
    }

    setSyncStatus(navigator.onLine ? '동기화 중...' : '오프라인 캐시 사용 중');
    const q = query(collection(db, 'users', user!.uid, 'sermons'), where('category', '==', currentCategory));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: Sermon[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          list.push({
            id: docSnap.id,
            title: data.title || '',
            date: data.date || '',
            scripture: data.scripture || '',
            content: data.content || '',
            category: data.category || currentCategory,
            updatedAt: data.updatedAt || '',
            order: typeof data.order === 'number' ? data.order : undefined,
          });
        });

        // 직접 정한 순서(order)가 있는 설교가 먼저, 나머지는 최근 수정순. 새 설교는 order가 가장 작아 맨 위로 간다.
        list.sort((a, b) =>
          a.order !== undefined && b.order !== undefined
            ? a.order - b.order
            : a.order !== undefined
              ? -1
              : b.order !== undefined
                ? 1
                : (b.updatedAt || '').localeCompare(a.updatedAt || '')
        );
        setSermons(list);

        if (typeof window !== 'undefined' && list.length > 0) {
          localStorage.setItem(`sermons_${currentCategory}`, JSON.stringify(list));
        }

        const curActive = activeIdRef.current;
        const restoreId = pendingRestoreIdRef.current;
        pendingRestoreIdRef.current = null; // 복원은 분류당 한 번만 적용

        let target: Sermon | null = null;
        if (list.length > 0) {
          if (restoreId) {
            target = list.find((s) => s.id === restoreId) || list[0];
          } else if (!curActive || !list.some((s) => s.id === curActive)) {
            target = list[0];
          }
        }

        if (target) {
          setActiveId(target.id);
          activeIdRef.current = target.id;
          setTitle(target.title);
          setDate(target.date);
          setScripture(target.scripture);
          setContent(target.content);
          historyRef.current = { past: [], future: [] };
          updateHistoryState();
        } else if (list.length === 0) {
          setActiveId(null);
          activeIdRef.current = null;
          setTitle('');
          setDate('');
          setScripture('');
          setContent('');
          historyRef.current = { past: [], future: [] };
          updateHistoryState();
        }

        setSyncStatus(navigator.onLine ? '실시간 동기화 완료' : '오프라인 모드 작동 중');
      },
      () => setSyncStatus('오프라인 안전 보관 모드')
    );

    return () => unsubscribe();
  }, [currentCategory, user]);

  const selectSermon = (s: Sermon) => {
    setCurrentCategory(s.category);
    setActiveId(s.id);
    activeIdRef.current = s.id;
    setTitle(s.title);
    setDate(s.date);
    setScripture(s.scripture);
    setContent(s.content);
    setCurrentMatchIndex(0);
    historyRef.current = { past: [], future: [] };
    updateHistoryState();
    setMobilePane('editor');
  };

  const createNewSermon = async (
    initialTitle = '새 설교',
    initialDate = '',
    initialScripture = '',
    initialContent = ''
  ) => {
    setSyncStatus('생성 중...');
    try {
      const today = initialDate || new Date().toISOString().slice(0, 10);
      const docRef = await addDoc(collection(db, 'users', user!.uid, 'sermons'), {
        title: initialTitle,
        date: today,
        scripture: initialScripture,
        content: initialContent,
        category: currentCategory,
        updatedAt: new Date().toISOString(),
        order: -Date.now(),
      });
      setActiveId(docRef.id);
      activeIdRef.current = docRef.id;
      setTitle(initialTitle);
      setDate(today);
      setScripture(initialScripture);
      setContent(initialContent);
      historyRef.current = { past: [], future: [] };
      updateHistoryState();
      setSyncStatus('저장 완료');
      setMobilePane('editor');
    } catch {
      setSyncStatus('생성 오류');
    }
  };

  // targetId는 반드시 "저장을 예약하는 시점"에 넘겨 받는다. 0.4초 디바운스가 끝나기 전에
  // 다른 설교로 넘어가면 activeIdRef.current가 이미 바뀌어 있어서, 그 시점에 다시 읽으면
  // 방금 쓴 글이 전혀 다른 설교 문서를 덮어써 버린다 (이게 "글이 자기가 바뀐다" 버그의 원인).
  const saveToCloud = async (
    targetId: string | null,
    newTitle: string,
    newDate: string,
    newScripture: string,
    newContent: string
  ) => {
    if (!targetId) return;
    try {
      await setDoc(
        doc(db, 'users', user!.uid, 'sermons', targetId),
        {
          title: newTitle,
          date: newDate,
          scripture: newScripture,
          content: newContent,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      setSyncStatus(navigator.onLine ? '실시간 동기화 완료' : '오프라인 보관 중 (연결 시 동기화)');
    } catch {
      setSyncStatus('저장 오류');
    }
  };

  const deleteSermon = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('이 설교 원고를 삭제하시겠습니까?')) return;
    try {
      await deleteDoc(doc(db, 'users', user!.uid, 'sermons', id));
      if (activeIdRef.current === id) {
        setActiveId(null);
        activeIdRef.current = null;
      }
    } catch {
      alert('삭제 중 오류가 발생했습니다.');
    }
  };

  // 📦 드래그 앤 드롭으로 설교를 다른 분류로 이동
  const [dragOverCat, setDragOverCat] = useState<string | null>(null);

  const moveSermonToCategory = async (sermonId: string, targetCatId: string) => {
    if (!sermonId || targetCatId === currentCategory) return;
    // 이동 직후 대기 중인 자동저장이 옛 분류로 되돌려 쓰지 않도록 취소
    if (activeIdRef.current === sermonId && saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    try {
      await setDoc(
        doc(db, 'users', user!.uid, 'sermons', sermonId),
        { category: targetCatId, updatedAt: new Date().toISOString() },
        { merge: true }
      );
      setSyncStatus(`'${getCategoryName(targetCatId)}'(으)로 이동 완료`);
    } catch {
      alert('설교 이동 중 오류가 발생했습니다.');
    }
  };

  const handleMultipleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setSyncStatus(`${files.length}개 파일 업로드 중...`);
    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const text = await file.text();
      const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '');

      await addDoc(collection(db, 'users', user!.uid, 'sermons'), {
        title: fileNameWithoutExt,
        date: today,
        scripture: '',
        content: text,
        category: currentCategory,
        updatedAt: new Date().toISOString(),
        order: -Date.now() + i,
      });
    }

    setSyncStatus('일괄 업로드 완료');
    e.target.value = '';
  };

  // 목록에서 설교 위치를 한 칸 위(-1)/아래(1)로 옮긴다. 보이는 순서 그대로 order를 다시 매겨 저장.
  const moveSermonOrder = async (id: string, dir: -1 | 1) => {
    const from = sermons.findIndex((s) => s.id === id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= sermons.length) return;
    const next = [...sermons];
    [next[from], next[to]] = [next[to], next[from]];
    setSermons(next.map((s, i) => ({ ...s, order: i })));
    try {
      await Promise.all(
        next.map((s, i) =>
          setDoc(doc(db, 'users', user!.uid, 'sermons', s.id), { order: i }, { merge: true })
        )
      );
    } catch {
      setSyncStatus('순서 저장 오류');
    }
  };

  // 라이브 드래그 선택이 아직 살아있으면 그걸 쓰고, 버튼 클릭 때문에 이미
  // 풀려버렸으면 selectionchange로 저장해 둔 마지막 드래그 범위를 대신 쓴다
  const resolveDragRange = (editable: HTMLDivElement): Range | null => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const liveRange = sel.getRangeAt(0);
      if (editable.contains(liveRange.commonAncestorContainer)) return liveRange;
    }
    const saved = savedRangeRef.current;
    if (saved && editable.contains(saved.commonAncestorContainer)) return saved;
    return null;
  };

  // 🖍️ 형광펜 적용 (선택한 범위를 <mark>로 감싼다)
  // Range.extractContents()로 직접 자르고 붙이는 방식은 모바일 사파리의
  // contentEditable에서 글자가 통째로 사라지는 경우가 있어서, 표 삽입과
  // 같은 방식(execCommand insertHTML — 선택 영역을 교체)으로 맞춘다.
  // 선택 영역의 텍스트만 뽑으면(Range.toString()) 그 안에 있던 <br> 줄바꿈이
  // 사라져서 여러 줄이 한 줄로 합쳐지므로, 반드시 HTML(cloneContents)을 그대로 감싼다.
  const applyHighlight = (color: 'yellow' | 'green' | 'pink') => {
    const editable = editableRef.current;
    if (!editable) return;
    const range = resolveDragRange(editable);
    if (!range || !range.toString().trim()) {
      alert('형광펜을 칠할 문장을 마우스로 먼저 드래그(선택)해 주세요!');
      return;
    }

    recordHistoryBeforeChange(editable.innerHTML);

    editable.focus();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const cls = color === 'green' ? 'hl-green' : color === 'pink' ? 'hl-pink' : 'hl-yellow';
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(range.cloneContents());
    wrapInlineRuns(tempDiv, cls); // 줄(블록) 경계는 그대로 두고 그 안의 내용만 감싼다

    document.execCommand('insertHTML', false, tempDiv.innerHTML);
    savedRangeRef.current = null;

    commitChange();
  };

  // ⚪ 형광펜 지우개 (드래그한 범위 안의 <mark>를 풀거나, 커서가 닿은 <mark> 하나를 푼다)
  const removeHighlight = () => {
    const editable = editableRef.current;
    if (!editable) return;

    const dragRange = resolveDragRange(editable);
    recordHistoryBeforeChange(editable.innerHTML);

    if (dragRange) {
      const marks = Array.from(editable.querySelectorAll('mark:not(.hl-search)')).filter((m) =>
        dragRange.intersectsNode(m)
      );
      if (marks.length === 0) {
        alert('형광펜을 지우고 싶은 문장을 드래그해 주세요.');
        return;
      }
      marks.forEach(unwrapMark);
      savedRangeRef.current = null;
    } else {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !editable.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        alert('형광펜을 지우고 싶은 문장을 드래그하거나 형광펜 글자 사이에 커서를 놓아주세요.');
        return;
      }
      let node: Node | null = sel.getRangeAt(0).startContainer;
      let found = false;
      while (node && node !== editable) {
        if (node.nodeType === 1 && (node as Element).tagName === 'MARK') {
          unwrapMark(node as Element);
          found = true;
          break;
        }
        node = node.parentNode;
      }
      if (!found) {
        alert('형광펜을 지우고 싶은 문장을 드래그하거나 형광펜 글자 사이에 커서를 놓아주세요.');
        return;
      }
    }

    window.getSelection()?.removeAllRanges();
    commitChange();
  };

  // 📊 표 삽입
  const insertTable = () => {
    const rowsInput = prompt('표의 행(가로줄) 개수를 입력하세요:', '3');
    if (rowsInput === null) return;
    const colsInput = prompt('표의 열(세로줄) 개수를 입력하세요:', '3');
    if (colsInput === null) return;

    const rows = Math.min(30, Math.max(1, parseInt(rowsInput, 10) || 3));
    const cols = Math.min(10, Math.max(1, parseInt(colsInput, 10) || 3));

    const editable = editableRef.current;
    if (!editable) return;
    editable.focus();

    recordHistoryBeforeChange(editable.innerHTML);

    let tableHtml = '<table class="sermon-table"><tbody>';
    for (let r = 0; r < rows; r++) {
      tableHtml += '<tr>' + '<td><br></td>'.repeat(cols) + '</tr>';
    }
    tableHtml += '</tbody></table><div><br></div>';

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editable.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      document.execCommand('insertHTML', false, tableHtml);
    } else {
      editable.insertAdjacentHTML('beforeend', tableHtml);
    }

    commitChange();
  };

  // 🔍 검색어 인덱스 (태그를 걷어낸 평문 기준 — contentEditable 텍스트 노드 순회와 오프셋이 맞음)
  const plainContent = toPlainText(content);
  const searchMatchIndices: number[] = [];
  if (searchQuery.trim() && plainContent) {
    const lowerContent = plainContent.toLowerCase();
    const lowerQ = searchQuery.toLowerCase();
    let idx = lowerContent.indexOf(lowerQ);
    while (idx !== -1) {
      searchMatchIndices.push(idx);
      idx = lowerContent.indexOf(lowerQ, idx + lowerQ.length);
    }
  }

  // 🔍 검색어로 이동 (DOM 텍스트 노드를 직접 찾아서 선택 + 스크롤)
  const jumpToMatch = (direction: 'next' | 'prev') => {
    const editable = editableRef.current;
    if (searchMatchIndices.length === 0 || !editable) return;

    let nextIdx = 0;
    if (direction === 'next') {
      nextIdx = (currentMatchIndex + 1) % searchMatchIndices.length;
    } else {
      nextIdx = (currentMatchIndex - 1 + searchMatchIndices.length) % searchMatchIndices.length;
    }
    setCurrentMatchIndex(nextIdx);

    const pos = searchMatchIndices[nextIdx];
    const start = findTextNodeAndOffset(editable, pos);
    const end = findTextNodeAndOffset(editable, pos + searchQuery.length);
    if (!start || !end) return;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);

    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const rect = range.getBoundingClientRect();
    const containerRect = editable.getBoundingClientRect();
    if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
      editable.scrollTop += rect.top - containerRect.top - editable.clientHeight / 2;
    }
  };

  // 타이머 로직
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isTimerRunning) {
      interval = setInterval(() => setTimerSeconds((p) => p + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [isTimerRunning]);

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const currentCategoryName = categories.find((c) => c.id === currentCategory)?.name || '분류 없음';

  // 🔍 검색어 하이라이트 함수
  const highlightSearchTerm = (text: string, queryStr: string) => {
    if (!queryStr.trim() || !text) return text;
    const escaped = queryStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const parts = text.split(regex);

    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (
            <mark
              key={i}
              className="bg-amber-300 text-neutral-950 font-bold px-1 py-0.5 rounded shadow-sm"
            >
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  const getSearchSnippet = (fullContent: string, queryStr: string) => {
    if (!queryStr.trim() || !fullContent) return '';
    const lowerContent = fullContent.toLowerCase();
    const lowerQuery = queryStr.toLowerCase();
    const idx = lowerContent.indexOf(lowerQuery);

    if (idx === -1) return fullContent.slice(0, 70);

    const start = Math.max(0, idx - 18);
    const end = Math.min(fullContent.length, idx + queryStr.length + 45);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < fullContent.length ? '...' : '';

    return prefix + fullContent.slice(start, end).replace(/\n/g, ' ') + suffix;
  };

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const titleMatches = trimmedQuery
    ? allSermonsForSearch.filter((s) => s.title.toLowerCase().includes(trimmedQuery))
    : [];
  const contentMatches = trimmedQuery
    ? allSermonsForSearch.filter(
        (s) =>
          !s.title.toLowerCase().includes(trimmedQuery) &&
          toPlainText(s.content).toLowerCase().includes(trimmedQuery)
      )
    : [];

  const getCategoryName = (catId: string) => {
    return categories.find((c) => c.id === catId)?.name || '기타';
  };

  // 🖍️ 본문 렌더러 (미리보기/강단 모드용) — 평문+마커든 HTML이든 전부 HTML로 승격해서 그린다
  const renderedContentHtml = content
    ? highlightHtml(ensureHtml(content), searchQuery)
    : '작성된 원고 내용이 없습니다.';

  // 로딩 화면
  if (authLoading) {
    return (
      <div className="h-screen bg-neutral-100 flex items-center justify-center">
        <p className="text-sm font-semibold text-neutral-500 animate-pulse">설교 노트를 불러오는 중...</p>
      </div>
    );
  }

  // 로그인 화면
  if (!user) {
    return (
      <div className="h-screen bg-neutral-900 flex flex-col items-center justify-center p-4 text-white">
        <div className="max-w-md w-full bg-neutral-800 border border-neutral-700 p-8 rounded-3xl text-center shadow-xl">
          <div className="text-4xl mb-3">📖</div>
          <h1 className="text-2xl font-black mb-2">설교 메모장</h1>
          <p className="text-sm text-neutral-400 mb-8 leading-relaxed">
            나만의 설교 원고 작성 및 실시간 강단 리딩 도구입니다.<br />
            개인 설교문은 본인 계정에만 안전하게 보관됩니다.
          </p>
          <button
            onClick={handleLogin}
            className="w-full py-3.5 px-4 bg-white text-neutral-900 font-bold rounded-2xl hover:bg-neutral-100 transition flex items-center justify-center gap-3 shadow-md"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>Google 계정으로 시작하기</span>
          </button>
        </div>
      </div>
    );
  }

  // 강단 리딩 모드
  if (isPulpitMode) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col p-6 selection:bg-yellow-500 selection:text-black">
        <header className="flex justify-between items-center border-b border-neutral-800 pb-4 w-full px-4 max-w-6xl mx-auto">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsPulpitMode(false)}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm font-medium transition"
            >
              ← 편집 모드
            </button>
            <span className="text-xs px-2.5 py-1 rounded bg-neutral-800 text-neutral-400 font-semibold">
              {currentCategoryName}
            </span>
            <div className="flex items-center gap-2 bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-1 text-sm">
              <span>글자</span>
              <button
                onClick={() => setFontSize((p) => Math.max(16, p - 2))}
                className="w-6 h-6 flex items-center justify-center bg-neutral-800 rounded hover:bg-neutral-700"
              >
                -
              </button>
              <span className="w-8 text-center font-bold text-yellow-400">{fontSize}</span>
              <button
                onClick={() => setFontSize((p) => Math.min(52, p + 2))}
                className="w-6 h-6 flex items-center justify-center bg-neutral-800 rounded hover:bg-neutral-700"
              >
                +
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 px-4 py-1.5 rounded-xl">
            <span className="font-mono text-2xl font-bold tracking-wider text-yellow-400">
              {formatTimer(timerSeconds)}
            </span>
            <button
              onClick={() => setIsTimerRunning(!isTimerRunning)}
              className={`px-3 py-1 text-xs rounded-md font-semibold ${
                isTimerRunning ? 'bg-red-600' : 'bg-emerald-600'
              }`}
            >
              {isTimerRunning ? '일시정지' : '시작'}
            </button>
            <button
              onClick={() => {
                setIsTimerRunning(false);
                setTimerSeconds(0);
              }}
              className="px-2 py-1 text-xs rounded-md bg-neutral-800 text-neutral-400"
            >
              초기화
            </button>
          </div>
        </header>

        <main className="max-w-5xl w-full mx-auto flex-1 py-10 px-4">
          <div className="mb-8 border-b border-neutral-800 pb-6">
            <h1 className="text-3xl md:text-4xl font-extrabold text-white mb-3">
              {highlightSearchTerm(title || '제목 없음', searchQuery)}
            </h1>
            <div className="flex flex-wrap gap-2">
              {date && (
                <span className="text-sm font-medium text-neutral-300 bg-neutral-900 border border-neutral-800 px-3 py-1 rounded-lg">
                  📅 {date}
                </span>
              )}
              {scripture && (
                <span className="text-sm font-medium text-yellow-400 bg-neutral-900 border border-neutral-800 px-3 py-1 rounded-lg">
                  📖 {scripture}
                </span>
              )}
            </div>
          </div>
          <div
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.95 }}
            className="font-sans text-neutral-200 tracking-normal"
            dangerouslySetInnerHTML={{ __html: renderedContentHtml }}
          />
        </main>
      </div>
    );
  }

  const canUndo = historyCount.past > 0;
  const canRedo = historyCount.future > 0;

  // 편집 모드 메인 화면
  return (
    <div className="h-screen bg-neutral-100 text-neutral-900 flex flex-col overflow-hidden">
      {/* 상단 헤더 */}
      <header className="bg-white border-b border-neutral-200 px-5 py-3 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          {/* 분류/설교 목록 전체 접기 — 데스크톱 전용 (모바일은 뒤로가기로 이동) */}
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="hidden md:flex p-2 rounded-xl border border-neutral-200 hover:bg-neutral-100 text-neutral-700 transition items-center gap-1.5 text-xs font-semibold shrink-0"
            title={isSidebarOpen ? '목록 접기' : '목록 열기'}
          >
            <span className="text-base">{isSidebarOpen ? '◀' : '▶'}</span>
            <span>{isSidebarOpen ? '목록 접기' : '설교 목록'}</span>
          </button>

          <div className="shrink-0 min-w-0">
            <h1 className="text-lg font-black tracking-tight truncate">설교 메모장</h1>
            <p
              className={`text-[11px] font-semibold flex items-center gap-1 ${
                isOnline ? 'text-emerald-600' : 'text-amber-600'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
                }`}
              ></span>
              {syncStatus}
            </p>
          </div>
        </div>

        <button
          onClick={() => setIsPulpitMode(true)}
          disabled={!activeId}
          className="flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white rounded-xl text-xs sm:text-sm font-semibold hover:bg-neutral-800 transition disabled:opacity-50 shrink-0 ml-2"
        >
          <span>강단 읽기 모드</span>
          <span>→</span>
        </button>
        <button
          onClick={handleLogout}
          title={user.email || '로그아웃'}
          className="px-3 py-2 border border-neutral-200 hover:bg-neutral-100 text-neutral-600 rounded-xl text-xs font-bold transition shrink-0 ml-2"
        >
          로그아웃
        </button>
      </header>

      {/* 본문 레이아웃: 분류 목록 → 설교 목록 → 편집창 (모바일은 한 단씩, 데스크톱은 한 화면에) */}
      <div className="flex-1 flex w-full p-4 gap-4 overflow-hidden">
        {/* 1단: 분류 목록 */}
        <aside
          className={
            (mobilePane === 'categories' ? 'flex' : 'hidden') +
            ' ' +
            (isSidebarOpen ? 'md:flex' : 'md:hidden') +
            ' w-full md:w-56 shrink-0 bg-white border border-neutral-200 rounded-2xl flex-col p-3 gap-1.5 h-full shadow-sm overflow-y-auto'
          }
        >
          <p className="text-[11px] font-bold text-neutral-400 px-2 pb-1">설교 분류</p>
          {categories.map((cat) => (
            <div
              key={cat.id}
              onClick={() => {
                setCurrentCategory(cat.id);
                setActiveId(null);
                activeIdRef.current = null;
                setMobilePane('sermons');
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverCat(cat.id);
              }}
              onDragLeave={() => setDragOverCat(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverCat(null);
                moveSermonToCategory(e.dataTransfer.getData('text/plain'), cat.id);
              }}
              className={`group relative flex items-center justify-between gap-1.5 px-3 py-2.5 text-sm font-bold rounded-xl cursor-pointer transition select-none ${
                dragOverCat === cat.id
                  ? 'bg-yellow-200 text-neutral-900 ring-2 ring-yellow-400'
                  : currentCategory === cat.id
                  ? 'bg-neutral-900 text-white shadow-sm'
                  : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              <span className="truncate">{cat.name}</span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={(e) => handleRenameCategory(cat, e)}
                  className={`text-[10px] rounded-full w-5 h-5 flex items-center justify-center transition opacity-60 group-hover:opacity-100 ${
                    currentCategory === cat.id ? 'hover:bg-white/20' : 'hover:bg-neutral-200'
                  }`}
                  title={`${cat.name} 이름 변경`}
                >
                  ✏️
                </button>
                <button
                  type="button"
                  onClick={(e) => handleDeleteCategory(cat, e)}
                  className={`text-[10px] rounded-full w-5 h-5 flex items-center justify-center transition opacity-60 group-hover:opacity-100 ${
                    currentCategory === cat.id ? 'hover:bg-white/20' : 'hover:bg-neutral-200 hover:text-red-600'
                  }`}
                  title={`${cat.name} 분류 삭제`}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={handleAddCategory}
            className="px-3 py-2.5 text-sm font-bold text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 rounded-xl transition flex items-center gap-1.5 border border-dashed border-neutral-300"
          >
            <span>+</span>
            <span>분류 추가</span>
          </button>
        </aside>

        {/* 2단: 현재 분류의 설교 목록 (검색 중이면 전체 검색 결과) */}
        <aside
          className={
            (mobilePane === 'sermons' ? 'flex' : 'hidden') +
            ' ' +
            (isSidebarOpen ? 'md:flex' : 'md:hidden') +
            ' w-full md:w-80 shrink-0 bg-white border border-neutral-200 rounded-2xl flex-col p-4 gap-3 h-full shadow-sm'
          }
        >
          <button
            type="button"
            onClick={() => setMobilePane('categories')}
            className="md:hidden flex items-center gap-1 text-xs font-bold text-neutral-500 hover:text-neutral-900 shrink-0 -mt-1 -ml-1 px-1 py-1"
          >
            <span>←</span>
            <span>분류 목록</span>
          </button>

          <p className="hidden md:block text-[11px] font-bold text-neutral-400 px-1 shrink-0 truncate">
            {currentCategoryName}
          </p>

            {/* 🔍 통합 검색창 */}
            <div className="relative shrink-0">
              <input
                type="text"
                placeholder="전체 폴더 검색 (제목/본문)"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentMatchIndex(0);
                }}
                className="w-full text-xs font-medium bg-neutral-50 border border-neutral-200 rounded-xl px-3 py-2.5 pl-8 focus:outline-none focus:ring-2 focus:ring-neutral-900"
              />
              <span className="absolute left-2.5 top-2.5 text-neutral-400 text-xs">🔍</span>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2 text-xs text-neutral-400 hover:text-neutral-700 px-1"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => createNewSermon()}
                className="flex-1 py-2 bg-neutral-900 text-white text-xs font-bold rounded-xl hover:bg-neutral-800 transition"
              >
                + 새 설교 작성
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-2 bg-neutral-100 hover:bg-neutral-200 text-xs font-bold rounded-xl border border-neutral-200 transition"
                title="텍스트 파일 여러 개 일괄 불러오기"
              >
                파일 일괄 열기
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleMultipleFileUpload}
                accept=".txt,.md"
                multiple
                className="hidden"
              />
            </div>

            {/* 목록 또는 검색 결과 */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
              {searchQuery.trim() !== '' ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-[11px] font-bold text-neutral-400 mb-1 px-1">
                      📌 제목 매칭 ({titleMatches.length})
                    </p>
                    {titleMatches.length === 0 ? (
                      <p className="text-xs text-neutral-400 px-1 py-1">일치하는 제목 없음</p>
                    ) : (
                      titleMatches.map((s) => (
                        <div
                          key={s.id}
                          onClick={() => selectSermon(s)}
                          className={`p-2.5 rounded-xl border text-left cursor-pointer transition mb-1.5 ${
                            activeId === s.id
                              ? 'bg-neutral-900 text-white border-neutral-900'
                              : 'bg-neutral-50 hover:bg-neutral-100 border-neutral-200 text-neutral-800'
                          }`}
                        >
                          <div className="flex justify-between items-center text-[10px] text-yellow-600 font-semibold mb-0.5">
                            <span>[{getCategoryName(s.category)}]</span>
                            <span>{s.date}</span>
                          </div>
                          <p className="font-bold text-xs truncate">
                            {highlightSearchTerm(s.title, searchQuery)}
                          </p>
                        </div>
                      ))
                    )}
                  </div>

                  <div>
                    <p className="text-[11px] font-bold text-neutral-400 mb-1 px-1">
                      📄 본문 매칭 ({contentMatches.length})
                    </p>
                    {contentMatches.length === 0 ? (
                      <p className="text-xs text-neutral-400 px-1 py-1">일치하는 본문 없음</p>
                    ) : (
                      contentMatches.map((s) => (
                        <div
                          key={s.id}
                          onClick={() => selectSermon(s)}
                          className={`p-2.5 rounded-xl border text-left cursor-pointer transition mb-1.5 ${
                            activeId === s.id
                              ? 'bg-neutral-900 text-white border-neutral-900'
                              : 'bg-neutral-50 hover:bg-neutral-100 border-neutral-200 text-neutral-800'
                          }`}
                        >
                          <div className="flex justify-between items-center text-[10px] text-blue-600 font-semibold mb-0.5">
                            <span>[{getCategoryName(s.category)}]</span>
                            <span>{s.date}</span>
                          </div>
                          <p className="font-bold text-xs truncate">{s.title}</p>
                          <p className="text-[11px] text-neutral-500 truncate mt-0.5 leading-snug">
                            {highlightSearchTerm(
                              getSearchSnippet(toPlainText(s.content), searchQuery),
                              searchQuery
                            )}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : sermons.length === 0 ? (
                <div className="text-center text-xs text-neutral-400 py-10">
                  작성된 설교가 없습니다. <br /> 새 설교나 파일 열기를 눌러보세요.
                </div>
              ) : (
                sermons.map((s) => (
                  <div
                    key={s.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', s.id)}
                    onClick={() => selectSermon(s)}
                    title="위쪽 분류 탭으로 끌어다 놓으면 해당 분류로 이동합니다"
                    className={`p-3 rounded-xl border text-left cursor-pointer transition flex justify-between items-start group ${
                      activeId === s.id
                        ? 'bg-neutral-900 text-white border-neutral-900 shadow-sm'
                        : 'bg-neutral-50 hover:bg-neutral-100 border-neutral-200 text-neutral-800'
                    }`}
                  >
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="font-bold text-sm truncate">{s.title || '제목 없음'}</p>
                      <div className="flex items-center gap-2 text-xs truncate mt-1">
                        {s.date && (
                          <span
                            className={`font-mono ${
                              activeId === s.id ? 'text-neutral-400' : 'text-neutral-500'
                            }`}
                          >
                            {s.date}
                          </span>
                        )}
                        {s.scripture && (
                          <span
                            className={`truncate ${
                              activeId === s.id ? 'text-yellow-400' : 'text-neutral-500'
                            }`}
                          >
                            {s.scripture}
                          </span>
                        )}
                      </div>
                    </div>
                    {activeId === s.id && (
                      <div className="flex flex-col shrink-0 mr-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            moveSermonOrder(s.id, -1);
                          }}
                          title="위로"
                          className="text-[10px] leading-none px-1.5 py-1 rounded hover:bg-neutral-700"
                        >
                          ▲
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            moveSermonOrder(s.id, 1);
                          }}
                          title="아래로"
                          className="text-[10px] leading-none px-1.5 py-1 rounded hover:bg-neutral-700"
                        >
                          ▼
                        </button>
                      </div>
                    )}
                    <button
                      onClick={(e) => deleteSermon(s.id, e)}
                      className="opacity-0 group-hover:opacity-100 text-xs px-1.5 py-0.5 rounded hover:bg-red-500 hover:text-white transition text-neutral-400"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
        </aside>

        {/* 3단: 편집창 */}
        <main
          className={
            (mobilePane === 'editor' ? 'flex' : 'hidden') + ' md:flex flex-1 flex-col gap-3 h-full min-w-0'
          }
        >
          {activeId ? (
            <>
              <button
                type="button"
                onClick={() => setMobilePane('sermons')}
                className="md:hidden flex items-center gap-1 text-xs font-bold text-neutral-500 hover:text-neutral-900 shrink-0 px-1"
              >
                <span>←</span>
                <span>설교 목록</span>
              </button>

              {/* 제목/날짜/본문 구절 — 본문을 아래로 스크롤하면 숨고, 위로 올리면 다시 보인다 */}
              {showMetaFields && (
                <>
                  {/* 제목 입력 */}
                  <input
                    type="text"
                    placeholder="설교 제목"
                    value={title}
                    onChange={(e) => {
                      const val = e.target.value;
                      setTitle(val);
                      saveToCloud(activeIdRef.current, val, date, scripture, content);
                    }}
                    className="w-full text-xl font-bold bg-white border border-neutral-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900 shadow-sm shrink-0"
                  />

                  {/* 날짜 및 본문 */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3 shrink-0">
                    <input
                      type="text"
                      placeholder="설교 날짜 (예: 2026.09.20)"
                      value={date}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDate(val);
                        saveToCloud(activeIdRef.current, title, val, scripture, content);
                      }}
                      className="w-full text-sm font-medium bg-white border border-neutral-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-neutral-900 shadow-sm"
                    />
                    <input
                      type="text"
                      placeholder="본문 구절 (예: 로마서 8:1-2)"
                      value={scripture}
                      onChange={(e) => {
                        const val = e.target.value;
                        setScripture(val);
                        saveToCloud(activeIdRef.current, title, date, val, content);
                      }}
                      className="w-full md:col-span-3 text-sm font-medium bg-white border border-neutral-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-neutral-900 shadow-sm"
                    />
                  </div>
                </>
              )}

              {/* 툴바 */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 shrink-0 bg-white border border-neutral-200 rounded-xl shadow-sm">
                <div className="flex items-center gap-1.5">
                  {/* 되돌리기 & 다시 실행 */}
                  <div className="flex items-center gap-1 mr-1 border-r border-neutral-200 pr-2">
                    <button
                      type="button"
                      onClick={handleUndo}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer ${
                        canUndo
                          ? 'bg-neutral-800 text-white hover:bg-neutral-700 shadow-sm'
                          : 'bg-neutral-100 text-neutral-400 hover:bg-neutral-200'
                      }`}
                      title="되돌리기 (Cmd+Z / Ctrl+Z)"
                    >
                      <span className="text-sm">↶</span>
                      <span>되돌리기</span>
                      {canUndo && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-0.5 animate-pulse"></span>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handleRedo}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1 cursor-pointer ${
                        canRedo
                          ? 'bg-neutral-800 text-white hover:bg-neutral-700 shadow-sm'
                          : 'bg-neutral-100 text-neutral-400 hover:bg-neutral-200'
                      }`}
                      title="다시 실행 (Cmd+Shift+Z / Ctrl+Y)"
                    >
                      <span className="text-sm">↷</span>
                      <span>다시 실행</span>
                      {canRedo && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 ml-0.5 animate-pulse"></span>
                      )}
                    </button>
                  </div>

                  <span className="text-xs font-bold text-neutral-500 mr-1">형광펜:</span>

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyHighlight('yellow')}
                    className="px-2.5 py-1 bg-yellow-100 hover:bg-yellow-200 text-yellow-900 border border-yellow-300 rounded-lg text-xs font-bold transition flex items-center gap-1"
                    title="노란색 형광펜"
                  >
                    <span>🟡</span>
                    <span>노랑</span>
                  </button>

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyHighlight('green')}
                    className="px-2.5 py-1 bg-emerald-100 hover:bg-emerald-200 text-emerald-900 border border-emerald-300 rounded-lg text-xs font-bold transition flex items-center gap-1"
                    title="초록색 형광펜"
                  >
                    <span>🟢</span>
                    <span>초록</span>
                  </button>

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyHighlight('pink')}
                    className="px-2.5 py-1 bg-pink-100 hover:bg-pink-200 text-pink-900 border border-pink-300 rounded-lg text-xs font-bold transition flex items-center gap-1"
                    title="분홍색 형광펜"
                  >
                    <span>🩷</span>
                    <span>분홍</span>
                  </button>

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={removeHighlight}
                    className="px-2.5 py-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border border-neutral-300 rounded-lg text-xs font-bold transition flex items-center gap-1 ml-1"
                    title="형광펜 지우기"
                  >
                    <span>⚪</span>
                    <span>지우개</span>
                  </button>

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={insertTable}
                    className="px-2.5 py-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border border-neutral-300 rounded-lg text-xs font-bold transition flex items-center gap-1 ml-1"
                    title="표 삽입"
                  >
                    <span>📊</span>
                    <span>표 삽입</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {searchQuery.trim() && (
                    <div className="flex items-center gap-1 bg-amber-50 border border-amber-300 text-amber-900 px-2.5 py-0.5 rounded-lg text-xs font-bold">
                      <span>본문 내 {searchMatchIndices.length}개 발견</span>
                      {searchMatchIndices.length > 0 && (
                        <div className="flex items-center gap-0.5 ml-1">
                          <button
                            type="button"
                            onClick={() => jumpToMatch('prev')}
                            className="px-1.5 py-0.5 bg-amber-200 hover:bg-amber-300 rounded text-[10px]"
                          >
                            ▲
                          </button>
                          <span className="text-[10px] text-amber-800 px-0.5">
                            {currentMatchIndex + 1}/{searchMatchIndices.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => jumpToMatch('next')}
                            className="px-1.5 py-0.5 bg-amber-200 hover:bg-amber-300 rounded text-[10px]"
                          >
                            ▼
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex p-0.5 bg-neutral-100 rounded-lg border border-neutral-200 text-xs font-bold">
                    <button
                      type="button"
                      onClick={() => setViewMode('edit')}
                      className={`px-2 py-1 rounded-md transition ${
                        viewMode === 'edit'
                          ? 'bg-white text-neutral-900 shadow-sm'
                          : 'text-neutral-500 hover:text-neutral-800'
                      }`}
                    >
                      ✏️ 수정만
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('split')}
                      className={`px-2 py-1 rounded-md transition ${
                        viewMode === 'split'
                          ? 'bg-white text-neutral-900 shadow-sm'
                          : 'text-neutral-500 hover:text-neutral-800'
                      }`}
                    >
                      📑 나란히 (추천)
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('preview')}
                      className={`px-2 py-1 rounded-md transition ${
                        viewMode === 'preview'
                          ? 'bg-white text-neutral-900 shadow-sm'
                          : 'text-neutral-500 hover:text-neutral-800'
                      }`}
                    >
                      👁️ 보기만
                    </button>
                  </div>
                </div>
              </div>

              {/* 본문 에디터 */}
              <div className="flex-1 flex gap-3 h-full min-h-0">
                {(viewMode === 'edit' || viewMode === 'split') && (
                  <div className="flex-1 flex flex-col h-full bg-white border border-neutral-200 rounded-xl shadow-sm overflow-hidden">
                    <div
                      ref={editableRef}
                      contentEditable
                      suppressContentEditableWarning
                      data-placeholder="설교 원고를 작성하세요... (문장을 드래그하고 위의 형광펜 버튼을 누르면 강조됩니다)"
                      onInput={handleEditableInput}
                      onScroll={handleEditorScroll}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                          e.preventDefault();
                          if (e.shiftKey) {
                            handleRedo();
                          } else {
                            handleUndo();
                          }
                        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
                          e.preventDefault();
                          handleRedo();
                        }
                      }}
                      className="sermon-editor-area w-full h-full p-5 bg-white text-neutral-900 font-sans text-base leading-relaxed break-words overflow-y-auto focus:outline-none"
                    />
                  </div>
                )}

                {(viewMode === 'preview' || viewMode === 'split') && (
                  <div className="flex-1 flex flex-col h-full bg-white border border-neutral-200 rounded-xl shadow-sm overflow-hidden">
                    <div className="px-4 py-2 border-b border-neutral-100 bg-neutral-50 text-[11px] font-bold text-neutral-500 flex justify-between items-center">
                      <span>형광펜 & 검색 실시간 뷰어</span>
                      {searchQuery.trim() && (
                        <span className="text-amber-600 font-semibold">
                          검색어 '{searchQuery}' 강조 중
                        </span>
                      )}
                    </div>
                    <div
                      className="flex-1 p-5 overflow-y-auto text-base leading-relaxed font-sans text-neutral-800 break-words"
                      dangerouslySetInnerHTML={{ __html: renderedContentHtml }}
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 bg-white border border-neutral-200 rounded-2xl flex items-center justify-center text-neutral-400 text-sm shadow-sm">
              왼쪽에서 설교를 선택하거나 [+ 새 설교 작성]을 눌러주세요.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}