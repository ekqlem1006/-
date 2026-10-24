import type { NewsItem } from "@/lib/news";

export default function NewsList({ items }: { items: NewsItem[] }) {
  if (!items.length) return <p className="text-sm text-neutral-500">뉴스를 불러오지 못했습니다.</p>;
  return (
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
      {items.map((n) => (
        <li key={n.link} className="py-2">
          <a href={n.link} target="_blank" rel="noreferrer" className="hover:underline">
            {n.title}
          </a>
          <div className="text-xs text-neutral-500">
            {n.source} · {new Date(n.date).toLocaleString("ko-KR")}
          </div>
        </li>
      ))}
    </ul>
  );
}
