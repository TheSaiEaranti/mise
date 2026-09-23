/**
 * Test preload (bunfig.toml): freeze Date at a moment before every fixture
 * date in the suite. Only Date is frozen; timers run normally.
 *
 * A test that needs a different "now" can still call setSystemTime itself.
 */
import { setSystemTime } from 'bun:test';

setSystemTime(new Date('2026-09-01T12:00:00-05:00'));
