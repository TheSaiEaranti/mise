import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Inter_Tight } from 'next/font/google';
import { AppProvider } from '@/lib/store';
import { ChatPanel } from '@/components/chat/chat-panel';
import { TopNav } from '@/components/top-nav';
import { OnboardingGate } from './onboarding-gate';
import './globals.css';

const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-inter-tight',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: 'Mise',
  description: 'A personal calendar agent — classes, gym, cooking, meals.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Mise',
  },
  icons: {
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#FFFFFF',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${interTight.variable} ${plexMono.variable} antialiased`}>
      <body>
        <AppProvider>
          <OnboardingGate>
            {/* One continuous paper surface: main area + chat column. */}
            <div className="md:grid md:h-dvh md:grid-cols-[minmax(0,1fr)_400px]">
              {/* pb-16 reserves room for the mobile bottom sheet input. */}
              <div className="min-w-0 pb-16 md:h-dvh md:overflow-y-auto md:pb-0">
                <TopNav />
                {children}
              </div>
              <ChatPanel />
            </div>
          </OnboardingGate>
        </AppProvider>
      </body>
    </html>
  );
}
