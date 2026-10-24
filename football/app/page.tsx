import Link from "next/link";
import AutoRefresh from "@/components/AutoRefresh";
import NewsList from "@/components/NewsList";
import { getNews } from "@/lib/news";
import { PLAYERS } from "@/lib/players";

export default async function Home() {
  // 전체 선수 뉴스를 합쳐 최신순으로
  const all = (await Promise.all(PLAYERS.map((p) => getNews(p.name, 4)))).flat();
  const seen = new Set<string>();
  const feed = all
    .filter((n) => !seen.has(n.link) && seen.add(n.link))
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .slice(0, 30);

  return (
    <main className="mx-auto max-w-5xl p-4">
      <AutoRefresh />
      <h1 className="mb-4 text-2xl font-bold">해외파 축구 트래커</h1>
      <div className="grid gap-6 md:grid-cols-[1fr_2fr]">
        <section>
          <h2 className="mb-2 font-semibold">선수</h2>
          <ul className="space-y-1">
            {PLAYERS.map((p) => (
              <li key={p.slug}>
                <Link href={`/players/${p.slug}`} className="block rounded border border-neutral-200 p-2 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-900">
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-xs text-neutral-500">{p.club} · {p.league}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 font-semibold">최신 뉴스 (5분마다 자동 갱신)</h2>
          <NewsList items={feed} />
        </section>
      </div>
    </main>
  );
}
