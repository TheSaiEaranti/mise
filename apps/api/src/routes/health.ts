import { Hono } from 'hono';
import { dbPath } from '@mise/core';
import { MODEL } from '@mise/core/ollama';

export const healthRoute = new Hono();

healthRoute.get('/', (c) => c.json({ ok: true, model: MODEL, db: dbPath() }));
