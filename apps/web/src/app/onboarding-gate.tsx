'use client';

/**
 * If no semester exists yet, everything routes to /setup. Deliberately dumb:
 * one fetch on mount, one redirect, children rendered regardless while the
 * check is in flight (no spinner, no flash).
 */
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getSemester } from '@/lib/api';

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === '/setup') return;
    getSemester()
      .then((res) => {
        if (res.semester === null) router.replace('/setup');
      })
      .catch((e) => console.warn('[gate] semester check failed', e));
  }, [pathname, router]);

  return <>{children}</>;
}
