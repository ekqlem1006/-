export type NewsItem = { title: string; link: string; source: string; date: string };

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const tag = (xml: string, t: string) =>
  decode(xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "").trim();

// 구글 뉴스 RSS (키 불필요). 5분 캐시.
export async function getNews(query: string, limit = 10): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + " 축구")}&hl=ko&gl=KR&ceid=KR:ko`;
  try {
    const res = await fetch(url, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((m) => ({
      title: tag(m[1], "title"),
      link: tag(m[1], "link"),
      source: tag(m[1], "source"),
      date: tag(m[1], "pubDate"),
    }));
  } catch {
    return [];
  }
}
