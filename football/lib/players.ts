export type Player = {
  slug: string;
  name: string; // 한국어 이름 (뉴스 검색어)
  english: string; // API-Football 검색어 (성)
  club: string;
  league: string;
  tier: 1 | 2 | 3;
};

// 소속은 검색 기사 기준이라 이적 시 이 파일만 고치면 된다. 선수 추가도 여기에.
export const PLAYERS: Player[] = [
  { slug: "kim-minjae", name: "김민재", english: "Kim Min-jae", club: "바이에른 뮌헨", league: "분데스리가", tier: 1 },
  { slug: "lee-jaesung", name: "이재성", english: "Lee Jae-sung", club: "마인츠", league: "분데스리가", tier: 1 },
  { slug: "castrop", name: "옌스 카스트로프", english: "Castrop", club: "묀헨글라드바흐", league: "분데스리가", tier: 1 },
  { slug: "jung-wooyoung", name: "정우영", english: "Jeong Woo-yeong", club: "우니온 베를린", league: "분데스리가", tier: 1 },
  { slug: "lee-kangin", name: "이강인", english: "Lee Kang-in", club: "PSG", league: "리그 1", tier: 1 },
  { slug: "hong-hyunseok", name: "홍현석", english: "Hong Hyun-seok", club: "낭트", league: "리그 1", tier: 1 },
  { slug: "kwon-hyukkyu", name: "권혁규", english: "Kwon Hyeok-kyu", club: "낭트", league: "리그 1", tier: 1 },
  { slug: "yang-minhyuk", name: "양민혁", english: "Yang Min-hyeok", club: "토트넘", league: "프리미어리그", tier: 1 },
  { slug: "yoon-doyoung", name: "윤도영", english: "Yoon Do-young", club: "브라이턴", league: "프리미어리그", tier: 1 },
  { slug: "kim-jisoo", name: "김지수", english: "Kim Ji-soo", club: "브렌트포드 / 카이저슬라우테른", league: "소속 확인 필요", tier: 2 },
  { slug: "park-iyoung", name: "박이영", english: "Park", club: "상파울리", league: "2. 분데스리가", tier: 2 },
  { slug: "seo-youngjae", name: "서영재", english: "Seo Young-jae", club: "뒤스부르크", league: "2. 분데스리가", tier: 2 },
  { slug: "lee-hyunju", name: "이현주", english: "Lee Hyun-ju", club: "아로카", league: "포르투갈", tier: 1 },
  { slug: "kim-myungjun", name: "김명준", english: "Kim Myung-jun", club: "헹크", league: "벨기에", tier: 1 },
  { slug: "lee-youngjun", name: "이영준", english: "Lee Young-jun", club: "그라스호퍼", league: "스위스", tier: 1 },
  { slug: "son-heungmin", name: "손흥민", english: "Son Heung-min", club: "LAFC", league: "MLS", tier: 1 },
];

export const getPlayer = (slug: string) => PLAYERS.find((p) => p.slug === slug);
