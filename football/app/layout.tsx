import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "해외파 축구 트래커",
  description: "해외파 한국 축구선수 기록·뉴스",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
