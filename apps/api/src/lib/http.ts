/**
 * Request-validation helpers. Every body/query in the API goes through one of
 * these: zod-parse, and 400 with { error, issues } on failure.
 */
import type { Context } from 'hono';
import type { z } from 'zod';

export interface Issue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

/** JSON body → schema. Non-JSON and schema failures both 400 { error, issues }. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<Parsed<z.output<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: 'Request body must be valid JSON', issues: [] }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, res: c.json({ error: 'Invalid request body', issues: issuesOf(parsed.error) }, 400) };
  }
  return { ok: true, data: parsed.data };
}

/** Query string → schema. 400 { error, issues } on failure. */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): Parsed<z.output<S>> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    return { ok: false, res: c.json({ error: 'Invalid query parameters', issues: issuesOf(parsed.error) }, 400) };
  }
  return { ok: true, data: parsed.data };
}
