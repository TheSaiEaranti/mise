/**
 * Read a photo/screenshot of a class schedule into structured classes.
 *
 * The vision model does EXTRACTION ONLY — it reads pixels and returns a list of
 * classes. It writes nothing (I1), computes no timestamps (I3: it reports the
 * HH:mm printed on the page; add_classes composes the actual events), and its
 * output is never trusted directly: the user edits it in a preview, and the
 * write goes through the normal proposal → approve → commit flow (I2).
 *
 * Expect it to get ~85% right. The preview is where you fix the rest.
 */
import { z } from 'zod';
import { visionCompletion, VISION_MODEL } from './ollama';
import { TIME_RE } from './time';
import { ClassZ, type ParsedClass } from './tools/add-classes';

const DAY_ALIASES: Record<string, string> = {
  m: 'MO', mo: 'MO', mon: 'MO', monday: 'MO',
  t: 'TU', tu: 'TU', tue: 'TU', tues: 'TU', tuesday: 'TU',
  w: 'WE', we: 'WE', wed: 'WE', weds: 'WE', wednesday: 'WE',
  th: 'TH', thu: 'TH', thur: 'TH', thurs: 'TH', thursday: 'TH', r: 'TH',
  f: 'FR', fr: 'FR', fri: 'FR', friday: 'FR',
  s: 'SA', sa: 'SA', sat: 'SA', saturday: 'SA',
  su: 'SU', sun: 'SU', sunday: 'SU', u: 'SU',
};

/**
 * Day strings come back in every shape imaginable: "MWF", "TuTh", "Mon/Wed",
 * "M W F", "TR". Expand them into RFC5545 codes. Two-letter codes are matched
 * before single letters so "Th" never becomes T + H.
 */
export function normalizeDays(input: unknown): string[] {
  const out: string[] = [];
  const push = (code: string | undefined) => {
    if (code && !out.includes(code)) out.push(code);
  };

  const raw = Array.isArray(input) ? input.map(String) : [String(input ?? '')];
  for (const item of raw) {
    for (const token of item.split(/[\s,/|+&-]+/).filter(Boolean)) {
      const lower = token.toLowerCase();
      if (DAY_ALIASES[lower]) {
        push(DAY_ALIASES[lower]);
        continue;
      }
      // A run-together token like "MWF" or "TuTh": walk it, two chars first.
      let i = 0;
      while (i < lower.length) {
        const two = lower.slice(i, i + 2);
        const one = lower.slice(i, i + 1);
        if (DAY_ALIASES[two] && (two === 'tu' || two === 'th' || two === 'we' || two === 'sa' || two === 'su' || two === 'mo' || two === 'fr')) {
          push(DAY_ALIASES[two]);
          i += 2;
        } else if (DAY_ALIASES[one]) {
          push(DAY_ALIASES[one]);
          i += 1;
        } else {
          i += 1;
        }
      }
    }
  }
  const ORDER = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  return out.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

/** "3:30 PM", "15:30", "1530", "3.30pm" → "15:30". */
export function normalizeTime(input: unknown): string | null {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (TIME_RE.test(s)) return s;

  const m = /^(\d{1,2})[:.]?(\d{2})?(a\.?m\.?|p\.?m\.?)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const mer = (m[3] ?? '').replace(/\./g, '');
  if (Number.isNaN(h) || Number.isNaN(min) || min > 59) return null;
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const RawClassZ = z.object({
  title: z.string(),
  days: z.union([z.string(), z.array(z.string())]),
  start_time: z.string(),
  end_time: z.string(),
  location: z.string().optional(),
});

const RawZ = z.object({ classes: z.array(RawClassZ) });

/** JSON Schema handed to Ollama's `format` so the model must return this shape. */
const RESPONSE_FORMAT = {
  type: 'object',
  properties: {
    classes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          days: { type: 'string' },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['title', 'days', 'start_time', 'end_time'],
      },
    },
  },
  required: ['classes'],
};

const SYSTEM = `You read images of university class schedules and transcribe them. You are an OCR-and-structure tool, not an assistant.

Rules:
- Report ONLY what is printed in the image. Never invent a class, a time, a room, or a day.
- Transcribe times exactly as shown, including AM/PM if printed. Do not convert or do arithmetic.
- days: the meeting days as printed (e.g. "MWF", "TuTh", "Mon/Wed").
- title: the course code and name as printed (e.g. "CS 429 Computer Organization").
- location: the building/room if shown, otherwise omit.
- One entry per course. If a course meets at two different times on different days, emit one entry per distinct time.
- If the image is not a class schedule, return {"classes": []}.`;

export interface ScheduleImportResult {
  classes: ParsedClass[];
  /** Rows the model produced that could not be salvaged — shown to the user. */
  skipped: string[];
}

/** Strip a data: URL prefix if the client sent one. */
export function stripDataUrl(b64: string): string {
  const i = b64.indexOf('base64,');
  return i === -1 ? b64.trim() : b64.slice(i + 7).trim();
}

export async function importClassesFromImage(imageB64: string): Promise<ScheduleImportResult> {
  const raw = await visionCompletion({
    system: SYSTEM,
    prompt:
      'Transcribe every class in this schedule image. Return JSON only: {"classes":[{"title","days","start_time","end_time","location"}]}',
    imagesB64: [stripDataUrl(imageB64)],
    format: RESPONSE_FORMAT,
  });

  let parsed: z.infer<typeof RawZ>;
  try {
    parsed = RawZ.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      `${VISION_MODEL} did not return a readable schedule. Try a sharper, straight-on photo — or add the classes by hand.`,
    );
  }

  const classes: ParsedClass[] = [];
  const skipped: string[] = [];

  for (const r of parsed.classes) {
    const days = normalizeDays(r.days);
    const start = normalizeTime(r.start_time);
    const end = normalizeTime(r.end_time);
    const title = r.title.trim();

    if (!title || days.length === 0 || !start || !end || start >= end) {
      skipped.push(`${title || 'untitled'} (${String(r.days)} ${r.start_time}–${r.end_time})`);
      continue;
    }

    const candidate = {
      title: title.slice(0, 80),
      days,
      start_time: start,
      end_time: end,
      ...(r.location?.trim() ? { location: r.location.trim().slice(0, 60) } : {}),
    };
    const ok = ClassZ.safeParse(candidate);
    if (ok.success) classes.push(ok.data);
    else skipped.push(title);
  }

  return { classes, skipped };
}
