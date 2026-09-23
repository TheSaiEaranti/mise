/**
 * Environment for scripts/latency-eval.ts. A separate module imported FIRST,
 * because ES imports are hoisted: assignments written at the top of the eval
 * script itself would run after every other module had already loaded.
 */
process.env.MISE_DB_PATH = ':memory:';
process.env.MISE_SETTINGS_PATH ??= '/nonexistent/settings.json';
process.env.MISE_TURN_LOG ??= '0';
/** A Wednesday, 9 AM — every run sees the same "today". */
export const EVAL_NOW = process.env.MISE_EVAL_NOW ?? '2026-09-23T09:00';
process.env.MISE_NOW = EVAL_NOW;
