/**
 * POST /api/schedule-import — read a photo of a class schedule.
 *
 * Extraction only. This route NEVER writes: it returns a candidate class list
 * that the user edits in a preview, and the write goes through the normal
 * proposal flow (POST /api/proposals with tool_name 'add_classes'). The vision
 * model is one more untrusted source of structured data, like a pasted recipe.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { importClassesFromImage } from '@mise/core';
import { parseBody } from '../lib/http';

export const scheduleImportRoute = new Hono();

// ~8MB of base64 ≈ a 6MB photo. Bigger than any screenshot or phone snap.
const MAX_B64 = 8_000_000;

const BodyZ = z.object({
  image: z
    .string()
    .min(100, 'That image looks empty.')
    .max(MAX_B64, 'That image is too large — under ~6MB, please.')
    .describe('Base64 image, with or without a data: URL prefix.'),
});

scheduleImportRoute.post('/', async (c) => {
  const body = await parseBody(c, BodyZ);
  if (!body.ok) return body.res;

  try {
    const result = await importClassesFromImage(body.data.image);
    return c.json(result);
  } catch (e) {
    // Ollama down or the vision model missing: say so plainly, don't 500.
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
