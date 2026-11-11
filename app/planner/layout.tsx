import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: '플래너',
  description: '어느 기기에서나 이어 쓰는 할 일 플래너',
  manifest: '/planner.webmanifest',
  icons: { icon: '/planner-192.png', apple: '/planner-192.png' },
  appleWebApp: { capable: true, title: '플래너', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function PlannerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
