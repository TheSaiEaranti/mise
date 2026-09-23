'use client';

/**
 * The entire top bar: the nav links, right-aligned. No logo, no icons,
 * no avatar. Active page is --ink; the rest --ink-soft. Screens render
 * their own titles below this.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';

const LINKS = [
  { href: '/', label: 'Week' },
  { href: '/meals', label: 'Meals' },
  { href: '/internships', label: 'Internships' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function TopNav() {
  const pathname = usePathname();
  return (
    <header className="flex justify-end px-6 pt-2 md:px-10">
      <nav aria-label="Main" className="flex items-center">
        {LINKS.map((link, i) => (
          <span key={link.href} className="flex items-center">
            {i > 0 && (
              <span aria-hidden="true" className="t-label px-1 text-ink-soft">
                ·
              </span>
            )}
            <Link
              href={link.href}
              className={clsx(
                't-label flex h-11 items-center px-2',
                isActive(pathname, link.href) ? 'text-ink' : 'text-ink-soft',
              )}
            >
              {link.label}
            </Link>
          </span>
        ))}
      </nav>
    </header>
  );
}
