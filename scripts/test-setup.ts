/**
 * Test preload (bunfig.toml).
 *
 * 1. Freeze Date at a moment before every fixture date in the suite. Only Date
 *    is frozen; timers run normally. A test that needs a different "now" can
 *    still call setSystemTime itself.
 * 2. Tests never reach a real model. Bun loads .env for `bun test` too, so a
 *    developer's ANTHROPIC_API_KEY would otherwise make the Anthropic API the
 *    default backend (and any un-mocked turn a billed network call). Backend
 *    tests that need credentials set a fake key themselves.
 */
import { setSystemTime } from 'bun:test';

setSystemTime(new Date('2026-09-01T12:00:00-05:00'));

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
// Belt and braces: the SDK can also find credentials in profile files, so any
// client built without a test override points at a dead local port.
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
process.env.ANTHROPIC_CONFIG_DIR = '/nonexistent/mise-test-anthropic-config';
