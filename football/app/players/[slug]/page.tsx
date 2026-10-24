import Link from "next/link";
import { notFound } from "next/navigation";
import AutoRefresh from "@/components/AutoRefresh";
import NewsList from "@/components/NewsList";
import { getNews } from "@/lib/news";
import { getPlayer } from "@/lib/players";
import { getStats, hasKey } from "@/lib/stats";

export default async function PlayerPage({ params }: PageProps<"/players/[slug]">) {
  const { slug } = await params;
  const player = getPlayer(slug);
  if (!player) notFound();

  const [news, stats] = await Promise.all([getNews(player.name, 15), getStats(player.english)]);

  return (
    <main className="mx-auto max-w-3xl p-4">
      <AutoRefresh />
      <Link href="/" className="text-sm text-neutral-500 hover:underline">← 전체</Link>
      <h1 className="mt-2 text-2xl font-bold">{player.name}</h1>
      <p className="mb-4 text-sm text-neutral-500">{player.club} · {player.league}</p>

      <h2 className="mb-2 font-semibold">이번 시즌 기록</h2>
      {!hasKey() ? (
        <p className="mb-6 text-sm text-neutral-500">API_FOOTBALL_KEY 환경변수를 설정하면 기록이 표시됩니다.</p>
      ) : !stats?.length ? (
        <p className="mb-6 text-sm text-neutral-500">기록을 찾지 못했습니다 (선수 검색어 확인 또는 일일 호출 한도).</p>
      ) : (
        <table className="mb-6 w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-1">팀/대회</th><th>출전</th><th>분</th><th>골</th><th>도움</th><th>평점</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => (
              <tr key={i} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-1">{s.team} · {s.league}</td><td>{s.apps}</td><td>{s.minutes}</td><td>{s.goals}</td><td>{s.assists}</td><td>{s.rating ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mb-2 font-semibold">뉴스</h2>
      <NewsList items={news} />
    </main>
  );
}
