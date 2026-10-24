export type SeasonStats = {
  team: string;
  league: string;
  apps: number;
  minutes: number;
  goals: number;
  assists: number;
  rating: string | null;
};

type ApiStat = {
  team?: { name: string };
  league?: { name: string };
  games?: { appearences?: number; minutes?: number; rating?: string };
  goals?: { total?: number; assists?: number };
};

const BASE = "https://v3.football.api-sports.io";

async function api(path: string) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return null;
  try {
    // 무료 플랜(하루 100회) 절약을 위해 6시간 캐시
    const res = await fetch(BASE + path, { headers: { "x-apisports-key": key }, next: { revalidate: 21600 } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export const hasKey = () => !!process.env.API_FOOTBALL_KEY;

export async function getStats(search: string, season = new Date().getFullYear() - (new Date().getMonth() < 7 ? 1 : 0)): Promise<SeasonStats[] | null> {
  const prof = await api(`/players/profiles?search=${encodeURIComponent(search.split(" ").pop() ?? search)}`);
  const id = prof?.response?.[0]?.player?.id;
  if (!id) return null;
  const data = await api(`/players?id=${id}&season=${season}`);
  const stats = data?.response?.[0]?.statistics;
  if (!stats) return null;
  return stats.map((s: ApiStat) => ({
    team: s.team?.name,
    league: s.league?.name,
    apps: s.games?.appearences ?? 0,
    minutes: s.games?.minutes ?? 0,
    goals: s.goals?.total ?? 0,
    assists: s.goals?.assists ?? 0,
    rating: s.games?.rating ? Number(s.games.rating).toFixed(2) : null,
  }));
}
