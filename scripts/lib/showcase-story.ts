/**
 * The showcase storyline, shared by the recorder (record-showcase.ts) and its
 * dry run (showcase-dryrun.ts). Built for the demo semester with the clock at
 * Wednesday 10:00 (MISE_NOW=2026-09-23T10:00).
 */
import type { DB } from '../../packages/core/src/db/client';
import { getInstances } from '../../packages/core/src/schedule';
import { addDaysWall, weekdayCode } from '../../packages/core/src/time';

export interface Step {
  /** What gets typed. */
  say: string;
  /** Approve pending cards afterwards (the cancel). */
  approve?: boolean;
  /** Days to print in the dry run ('TODAY' | 'TOMORROW' | a date). */
  showDays?: string[];
  /** The calendar ended up right. */
  check: (db: DB, today: string) => true | string;
}

const at = (db: DB, date: string, re: RegExp) => getInstances(db, date, date).find((i) => re.test(i.title));
const time = (db: DB, date: string, re: RegExp) => at(db, date, re)?.starts_at.slice(11) ?? null;
const nextFri = (today: string, weeks = 0) => {
  let d = addDaysWall(today, 1);
  while (weekdayCode(d) !== 'FR') d = addDaysWall(d, 1);
  return addDaysWall(d, weeks * 7);
};

export const STORY: Step[] = [
  {
    say: 'friends are coming over at 5 tonight for two hours',
    showDays: ['TODAY'],
    check: (db, t) =>
      time(db, t, /friend/i) === '17:00' && (time(db, t, /^Gym/) ?? '') >= '19:00'
        ? true
        : `friends ${time(db, t, /friend/i)}, gym ${time(db, t, /^Gym/)}`,
  },
  {
    say: 'shift everything after 3pm tomorrow back an hour',
    showDays: ['TOMORROW'],
    check: (db, t) => {
      const tm = addDaysWall(t, 1);
      // "back" = earlier: gym 6 → 5 PM (right as ECO ends), study 8 → 7 PM.
      return time(db, tm, /ECO 304K/) === '15:30' && time(db, tm, /^Gym/) === '17:00' && time(db, tm, /Study group/) === '19:00'
        ? true
        : `eco ${time(db, tm, /ECO 304K/)}, gym ${time(db, tm, /^Gym/)}, study ${time(db, tm, /Study group/)}`;
    },
  },
  {
    say: 'no gym on Fridays',
    check: (db, t) => (at(db, nextFri(t), /^Gym/) || at(db, nextFri(t, 1), /^Gym/) ? 'a Friday still has gym' : true),
  },
  {
    say: 'make my gym sessions 2 hours long',
    showDays: ['TODAY', 'TOMORROW'],
    check: (db, t) => {
      const g = at(db, addDaysWall(t, 5), /^Gym/); // next Monday
      if (!g) return 'no Monday gym';
      const len = (Date.parse(g.ends_at) - Date.parse(g.starts_at)) / 60000;
      return len === 120 ? true : `Monday gym is ${len} min`;
    },
  },
  {
    say: 'cancel my advising appointment',
    approve: true,
    check: (db, t) => (at(db, addDaysWall(t, 2), /Advising/) ? 'advising still there after approve' : true),
  },
];
