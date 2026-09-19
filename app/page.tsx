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

const DEFAULT_CATEGORIES = [
  { id: 'sunday', name: '주일설교' },
  { id: 'dawn', name: '새벽기도' },
  { id: 'wednesday', name: '수요예배' },
  { id: 'special', name: '특별/기타' },
];

interface Sermon {
  id: string;
  title: string;
  date: string;
  scripture: string;
  content: string;
  category: string;
  updatedAt: string;
}

export default function SermonApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [currentCategory, setCurrentCategory] = useState('sunday');
  const [sermons, setSermons] = useState<Sermon[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split');

  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [scripture, setScripture] = useState('');
  const [content, setContent] = useState('');
  const [syncStatus, setSyncStatus] = useState('동기화 완료');
  const [isOnline, setIsOnline] = useState(true);

  // 실행 취소 / 다시 실행
  const historyRef = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const [historyCount, setHistoryCount] = useState({ past: 0, future: 0 });
  const contentRef = useRef(content);
  contentRef.current = content;

  const isTypingBatchRef = useRef(false);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 검색
  const [searchQuery, setSearchQuery] = useState('');
  const [allSermonsForSearch, setAllSermonsForSearch] = useState<Sermon[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  // 강단 모드
  const [isPulpitMode, setIsPulpitMode] = useState(false);
  const [fontSize, setFontSize] = useState(24);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

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
    }
  };

  const updateHistoryState = () => {
    setHistoryCount({
      past: historyRef.current.past.length,
      future: historyRef.current.future.length,
    });
  };

  const recordHistoryBeforeChange = (textToSave: string) => {
    historyRef.current.past.push(textToSave);
    if (historyRef.current.past.length > 40) historyRef.current.past.shift();
    historyRef.current.future = [];
    updateHistoryState();
  };

  const handleContentChange = (newVal: string) => {
    const currentText = contentRef.current;
    if (!isTypingBatchRef.current) {
      recordHistoryBeforeChange(currentText);
      isTypingBatchRef.current = true;
    }

    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      isTypingBatchRef.current = false;
    }, 800);

    setContent(newVal);

    setSyncStatus('저장 대기 중...');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveToCloud(title, date, scripture, newVal);
    }, 400);
  };

  const handleUndo = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    isTypingBatchRef.current = false;
    if (historyRef.current.past.length === 0) return;

    const previous = historyRef.current.past.pop()!;
    historyRef.current.future.unshift(contentRef.current);
    updateHistoryState();

    setContent(previous);
    saveToCloud(title, date, scripture, previous);
    setTimeout(() => textareaRef.current?.focus(), 20);
  };

  const handleRedo = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    isTypingBatchRef.current = false;
    if (historyRef.current.future.length === 0) return;

    const next = historyRef.current.future.shift()!;
    historyRef.current.past.push(contentRef.current);
    updateHistoryState();

    setContent(next);
    saveToCloud(title, date, scripture, next);
    setTimeout(() => textareaRef.current?.focus(), 20);
  };

  // 온라인 상태 감지
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

  // 사용자별 전체 설교 데이터 수집 (검색용)
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'users', user.uid, 'sermons'));
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
      },
      () => {}
    );
    return () => unsubscribe();
  }, [user]);

  // 사용자별 현재 카테고리 설교 목록 불러오기
  useEffect(() => {
    if (!user) return;

    setSyncStatus(navigator.onLine ? '동기화 중...' : '오프라인 캐시 사용 중');
    const q = query(
      collection(db, 'users', user.uid, 'sermons'),
      where('category', '==', currentCategory)
    );

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
          });
        });

        list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        setSermons(list);

        const curActive = activeIdRef.current;
        if (list.length > 0) {
          if (!curActive || !list.some((s) => s.id === curActive)) {
            setActiveId(list[0].id);
            activeIdRef.current = list[0].id;
            setTitle(list[0].title);
            setDate(list[0].date);
            setScripture(list[0].scripture);
            setContent(list[0].content);
            historyRef.current = { past: [], future: [] };
            updateHistoryState();
          }
        } else {
          setActiveId(null);
          activeIdRef.current = null;
          setTitle('');
          setDate('');
          setScripture('');
          setContent('');
          historyRef.current = { past: [], future: [] };
          updateHistoryState();
        }

        setSyncStatus(navigator.onLine ? '실시간 동기화 완료' : '오프라인 모드');
      },
      () => setSyncStatus('오프라인 안전 보관 모드')
    );

    return () => unsubscribe();
  }, [user, currentCategory]);

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
  };

  const createNewSermon = async (
    initialTitle = '새 설교',
    initialDate = '',
    initialScripture = '',
    initialContent = ''
  ) => {
    if (!user) return;
    setSyncStatus('생성 중...');
    try {
      const today = initialDate || new Date().toISOString().slice(0, 10);
      const docRef = await addDoc(collection(db, 'users', user.uid, 'sermons'), {
        title: initialTitle,
        date: today,
        scripture: initialScripture,
        content: initialContent,
        category: currentCategory,
        updatedAt: new Date().toISOString(),
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
    } catch {
      setSyncStatus('생성 오류');
    }
  };

  const saveToCloud = async (
    newTitle: string,
    newDate: string,
    newScripture: string,
    newContent: string
  ) => {
    const targetId = activeIdRef.current;
    if (!user || !targetId) return;
    try {
      await setDoc(
        doc(db, 'users', user.uid, 'sermons', targetId),
        {
          title: newTitle,
          date: newDate,
          scripture: newScripture,
          content: newContent,
          category: currentCategory,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      setSyncStatus(navigator.onLine ? '실시간 동기화 완료' : '오프라인 보관 중');
    } catch {
      setSyncStatus('저장 오류');
    }
  };

  const deleteSermon = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    if (!confirm('이 설교 원고를 삭제하시겠습니까?')) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'sermons', id));
      if (activeIdRef.current === id) {
        setActiveId(null);
        activeIdRef.current = null;
      }
    } catch {
      alert('삭제 중 오류가 발생했습니다.');
    }
  };

  const handleMultipleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !user) return;

    setSyncStatus(`${files.length}개 파일 업로드 중...`);
    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const text = await file.text();
      const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '');

      await addDoc(collection(db, 'users', user.uid, 'sermons'), {
        title: fileNameWithoutExt,
        date: today,
        scripture: '',
        content: text,
        category: currentCategory,
        updatedAt: new Date().toISOString(),
      });
    }

    setSyncStatus('일괄 업로드 완료');
    e.target.value = '';
  };

  // 형광펜 기능
  const applyHighlight = (color: 'yellow' | 'green' | 'pink') => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (start === end) {
      alert('형광펜을 칠할 문장을 먼저 드래그해 주세요.');
      return;
    }

    const selectedText = content.slice(start, end);
    if (!selectedText.trim()) return;

    recordHistoryBeforeChange(content);

    const cleanText = selectedText.replace(/==([ygp]:)?/g, '').replace(/==/g, '');
    const prefix = color === 'green' ? '==g:' : color === 'pink' ? '==p:' : '==';
    const tagged = `${prefix}${cleanText}==`;

    const newContent = content.slice(0, start) + tagged + content.slice(end);
    setContent(newContent);
    saveToCloud(title, date, scripture, newContent);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start, start + tagged.length);
    }, 20);
  };

  const removeHighlight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (start === end) {
      alert('지우고 싶은 형광펜 글자를 드래그해 주세요.');
      return;
    }

    recordHistoryBeforeChange(content);
    const selectedText = content.slice(start, end);
    const cleanText = selectedText.replace(/==([ygp]:)?/g, '').replace(/==/g, '');
    const newContent = content.slice(0, start) + cleanText + content.slice(end);

    setContent(newContent);
    saveToCloud(title, date, scripture, newContent);
  };

  // 검색 네비게이션
  const searchMatchIndices: number[] = [];
  if (searchQuery.trim() && content) {
    const lowerContent = content.toLowerCase();
    const lowerQ = searchQuery.toLowerCase();
    let idx = lowerContent.indexOf(lowerQ);
    while (idx !== -1) {
      searchMatchIndices.push(idx);
      idx = lowerContent.indexOf(lowerQ, idx + lowerQ.length);
    }
  }

  const jumpToMatch = (direction: 'next' | 'prev') => {
    if (searchMatchIndices.length === 0 || !textareaRef.current) return;
    let nextIdx = 0;
    if (direction === 'next') {
      nextIdx = (currentMatchIndex + 1) % searchMatchIndices.length;
    } else {
      nextIdx = (currentMatchIndex - 1 + searchMatchIndices.length) % searchMatchIndices.length;
    }
    setCurrentMatchIndex(nextIdx);

    const pos = searchMatchIndices[nextIdx];
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(pos, pos + searchQuery.length);
    const ratio = pos / (content.length || 1);
    textareaRef.current.scrollTop = Math.max(0, ratio * textareaRef.current.scrollHeight - 100);
  };

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

  const highlightSearchTerm = (text: string, queryStr: string) => {
    if (!queryStr.trim() || !text) return text;
    const escaped = queryStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const parts = text.split(regex);

    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (
            <mark key={i} className="bg-amber-300 text-neutral-950 font-bold px-1 py-0.5 rounded">
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </>
    );
  };

  const renderFormattedSermon = (rawText: string, queryStr: string) => {
    if (!rawText) return '작성된 원고 내용이 없습니다.';
    const parts = rawText.split(/(==(?:[ygp]:)?[\s\S]*?==)/g);

    return parts.map((part, index) => {
      if (part.startsWith('==') && part.endsWith('==') && part.length >= 4) {
        let markBg = 'bg-yellow-300 text-neutral-950';
        let innerText = part.slice(2, -2);

        if (part.startsWith('==g:')) {
          markBg = 'bg-emerald-300 text-neutral-950';
          innerText = part.slice(4, -2);
        } else if (part.startsWith('==p:')) {
          markBg = 'bg-pink-300 text-neutral-950';
          innerText = part.slice(4, -2);
        } else if (part.startsWith('==y:')) {
          innerText = part.slice(4, -2);
        }

        return (
          <mark key={index} className={`${markBg} font-bold px-1.5 py-0.5 rounded shadow-sm mx-0.5 inline-block`}>
            {highlightSearchTerm(innerText, queryStr)}
          </mark>
        );
      }
      return <span key={index}>{highlightSearchTerm(part, queryStr)}</span>;
    });
  };

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const titleMatches = trimmedQuery
    ? allSermonsForSearch.filter((s) => s.title.toLowerCase().includes(trimmedQuery))
    : [];
  const contentMatches = trimmedQuery
    ? allSermonsForSearch.filter(
        (s) => !s.title.toLowerCase().includes(trimmedQuery) && s.content.toLowerCase().includes(trimmedQuery)
      )
    : [];

  const getCategoryName = (catId: string) => {
    return DEFAULT_CATEGORIES.find((c) => c.id === catId)?.name || '기타';
  };

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

  // 강단 모드
  if (isPulpitMode) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col p-6">
        <header className="flex justify-between items-center border-b border-neutral-800 pb-4 w-full px-4 max-w-6xl mx-auto">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsPulpitMode(false)}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm font-medium transition"
            >
              ← 편집 모드
            </button>
            <span className="text-xs px-2.5 py-1 rounded bg-neutral-800 text-neutral-400 font-semibold">
              {getCategoryName(currentCategory)}
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
            className="whitespace-pre-wrap font-sans text-neutral-200 tracking-normal"
          >
            {renderFormattedSermon(content, searchQuery)}
          </div>
        </main>
      </div>
    );
  }

  const canUndo = historyCount.past > 0;
  const canRedo = historyCount.future > 0;

  // 메인 편집 화면
  return (
    <div className="h-screen bg-neutral-100 text-neutral-900 flex flex-col overflow-hidden">
      {/* 상단 헤더 */}
      <header className="bg-white border-b border-neutral-200 px-5 py-3 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-2 rounded-xl border border-neutral-200 hover:bg-neutral-100 text-neutral-700 transition flex items-center gap-1.5 text-xs font-semibold"
          >
            <span>{isSidebarOpen ? '◀' : '▶'}</span>
            <span className="hidden sm:inline">{isSidebarOpen ? '목록 접기' : '설교 목록'}</span>
          </button>

          <div>
            <h1 className="text-lg font-black tracking-tight">설교 메모장</h1>
            <p className={`text-[11px] font-semibold flex items-center gap-1 ${isOnline ? 'text-emerald-600' : 'text-amber-600'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
              {syncStatus}
            </p>
          </div>

          <div className="flex gap-1 p-1 bg-neutral-100 rounded-xl">
            {DEFAULT_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => {
                  setCurrentCategory(cat.id);
                  setActiveId(null);
                  activeIdRef.current = null;
                }}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${
                  currentCategory === cat.id
                    ? 'bg-white text-neutral-900 shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-900'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPulpitMode(true)}
            disabled={!activeId}
            className="flex items-center gap-2 px-3.5 py-2 bg-neutral-900 text-white rounded-xl text-xs font-semibold hover:bg-neutral-800 transition disabled:opacity-50"
          >
            <span>강단 모드</span>
            <span>→</span>
          </button>
          <button
            onClick={handleLogout}
            title={user.email || '로그아웃'}
            className="px-3 py-2 border border-neutral-200 hover:bg-neutral-100 text-neutral-600 rounded-xl text-xs font-bold transition"
          >
            로그아웃
          </button>
        </div>
      </header>

      {/* 본문 레이아웃 */}
      <div className="flex-1 flex w-full p-4 gap-4 overflow-hidden">
        {/* 사이드바 */}
        {isSidebarOpen && (
          <aside className="w-80 shrink-0 bg-white border border-neutral-200 rounded-2xl flex flex-col p-4 gap-3 h-full shadow-sm">
            <div className="relative shrink-0">
              <input
                type="text"
                placeholder="내 설교 검색 (제목/본문)"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentMatchIndex(0);
                }}
                className="w-full text-xs font-medium bg-neutral-50 border border-neutral-200 rounded-xl px-3 py-2.5 pl-8 focus:outline-none focus:ring-2 focus:ring-neutral-900"
              />
              <span className="absolute left-2.5 top-2.5 text-neutral-400 text-xs">🔍</span>
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
                파일 열기
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

            {/* 설교 목록 / 검색 결과 */}
            <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
              {searchQuery.trim() !== '' ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-[11px] font-bold text-neutral-400 mb-1 px-1">
                      제목 매칭 ({titleMatches.length})
                    </p>
                    {titleMatches.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => selectSermon(s)}
                        className={`p-2.5 rounded-xl border text-left cursor-pointer transition mb-1.5 ${
                          activeId === s.id
                            ? 'bg-neutral-900 text-white border-neutral-900'
                            : 'bg-neutral-50 hover:bg-neutral-100 border-neutral-200'
                        }`}
                      >
                        <p className="font-bold text-xs truncate">{highlightSearchTerm(s.title, searchQuery)}</p>
                      </div>
                    ))}
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-neutral-400 mb-1 px-1">
                      본문 매칭 ({contentMatches.length})
                    </p>
                    {contentMatches.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => selectSermon(s)}
                        className={`p-2.5 rounded-xl border text-left cursor-pointer transition mb-1.5 ${
                          activeId === s.id
                            ? 'bg-neutral-900 text-white border-neutral-900'
                            : 'bg-neutral-50 hover:bg-neutral-100 border-neutral-200'
                        }`}
                      >
                        <p className="font-bold text-xs truncate">{s.title}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : sermons.length === 0 ? (
                <div className="text-center text-xs text-neutral-400 py-10">
                  작성된 설교가 없습니다.
                </div>
              ) : (
                sermons.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => selectSermon(s)}
                    className={`p-3 rounded-xl border text-left cursor-pointer transition flex justify-between items-start group ${
                      activeId === s.id
                        ? 'bg-neutral-900 text-white border-neutral-900'
                        : 'bg-neutral-50 hover:bg-neutral-100 border-neutral-200'
                    }`}
                  >
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="font-bold text-sm truncate">{s.title || '제목 없음'}</p>
                      <p className="text-xs text-neutral-400 truncate mt-1">
                        {s.date} {s.scripture && `| ${s.scripture}`}
                      </p>
                    </div>
                    <button
                      onClick={(e) => deleteSermon(s.id, e)}
                      className="opacity-0 group-hover:opacity-100 text-xs px-1.5 py-0.5 rounded hover:bg-red-500 hover:text-white transition"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}

        {/* 에디터 메인 */}
        <main className="flex-1 flex flex-col gap-3 h-full min-w-0">
          {activeId ? (
            <>
              <input
                type="text"
                placeholder="설교 제목"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  saveToCloud(e.target.value, date, scripture, content);
                }}
                className="w-full text-xl font-bold bg-white border border-neutral-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900 shrink-0"
              />

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 shrink-0">
                <input
                  type="text"
                  placeholder="설교 날짜 (예: 2026.09.20)"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    saveToCloud(title, e.target.value, scripture, content);
                  }}
                  className="w-full text-sm font-medium bg-white border border-neutral-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                />
                <input
                  type="text"
                  placeholder="본문 구절 (예: 로마서 8:1-2)"
                  value={scripture}
                  onChange={(e) => {
                    setScripture(e.target.value);
                    saveToCloud(title, date, e.target.value, content);
                  }}
                  className="w-full md:col-span-3 text-sm font-medium bg-white border border-neutral-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                />
              </div>

              {/* 툴바 */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 shrink-0 bg-white border border-neutral-200 rounded-xl shadow-sm">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleUndo}
                    disabled={!canUndo}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30"
                  >
                    ↶ 되돌리기
                  </button>
                  <button
                    type="button"
                    onClick={handleRedo}
                    disabled={!canRedo}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold bg-neutral-100 hover:bg-neutral-200 disabled:opacity-30"
                  >
                    ↷ 다시 실행
                  </button>
                  <span className="text-xs font-bold text-neutral-400 ml-2">형광펜:</span>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyHighlight('yellow')}
                    className="px-2 py-1 bg-yellow-100 hover:bg-yellow-200 text-yellow-900 rounded-lg text-xs font-bold"
                  >
                    🟡 노랑
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyHighlight('green')}
                    className="px-2 py-1 bg-emerald-100 hover:bg-emerald-200 text-emerald-900 rounded-lg text-xs font-bold"
                  >
                    🟢 초록
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyHighlight('pink')}
                    className="px-2 py-1 bg-pink-100 hover:bg-pink-200 text-pink-900 rounded-lg text-xs font-bold"
                  >
                    🩷 분홍
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={removeHighlight}
                    className="px-2 py-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 rounded-lg text-xs font-bold"
                  >
                    ⚪ 지우개
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex p-0.5 bg-neutral-100 rounded-lg border border-neutral-200 text-xs font-bold">
                    <button
                      onClick={() => setViewMode('edit')}
                      className={`px-2 py-1 rounded-md ${viewMode === 'edit' ? 'bg-white shadow-sm' : 'text-neutral-500'}`}
                    >
                      수정만
                    </button>
                    <button
                      onClick={() => setViewMode('split')}
                      className={`px-2 py-1 rounded-md ${viewMode === 'split' ? 'bg-white shadow-sm' : 'text-neutral-500'}`}
                    >
                      나란히
                    </button>
                    <button
                      onClick={() => setViewMode('preview')}
                      className={`px-2 py-1 rounded-md ${viewMode === 'preview' ? 'bg-white shadow-sm' : 'text-neutral-500'}`}
                    >
                      보기만
                    </button>
                  </div>
                </div>
              </div>

              {/* 본문 에디터 */}
              <div className="flex-1 flex gap-3 h-full min-h-0">
                {(viewMode === 'edit' || viewMode === 'split') && (
                  <div className="flex-1 flex flex-col h-full bg-white border border-neutral-200 rounded-xl overflow-hidden">
                    <textarea
                      ref={textareaRef}
                      placeholder="설교 원고를 작성하세요..."
                      value={content}
                      onChange={(e) => handleContentChange(e.target.value)}
                      className="w-full h-full p-5 bg-white text-neutral-900 text-base leading-relaxed resize-none focus:outline-none overflow-y-auto"
                    />
                  </div>
                )}
                {(viewMode === 'preview' || viewMode === 'split') && (
                  <div className="flex-1 flex flex-col h-full bg-white border border-neutral-200 rounded-xl overflow-hidden">
                    <div className="flex-1 p-5 overflow-y-auto text-base leading-relaxed whitespace-pre-wrap break-words">
                      {renderFormattedSermon(content, searchQuery)}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 bg-white border border-neutral-200 rounded-2xl flex items-center justify-center text-neutral-400 text-sm">
              왼쪽에서 설교를 선택하거나 [+ 새 설교 작성]을 눌러주세요.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}