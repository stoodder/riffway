/**
 * R3-C-04: `npm run test:e2e` must not rewrite the committed `e2e/screenshots/*.png` unless the
 * operator asks for it with `RIFFWAY_UPDATE_SCREENSHOTS=1`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMITTED_SCREENSHOT_DIR, ROOT, SCRATCH_SCREENSHOT_DIR, screenshotDir } from '../../e2e/support/env';

describe('e2e screenshot directory (R3-C-04)', () => {
  it('writes to the git-ignored test-results dir by default', () => {
    expect(SCRATCH_SCREENSHOT_DIR).toBe(join(ROOT, 'test-results/e2e-screenshots'));
    expect(screenshotDir({})).toBe(SCRATCH_SCREENSHOT_DIR);
    expect(screenshotDir({ RIFFWAY_UPDATE_SCREENSHOTS: '' })).toBe(SCRATCH_SCREENSHOT_DIR);
    expect(screenshotDir({ RIFFWAY_UPDATE_SCREENSHOTS: '0' })).toBe(SCRATCH_SCREENSHOT_DIR);
    expect(screenshotDir({ RIFFWAY_UPDATE_SCREENSHOTS: 'false' })).toBe(SCRATCH_SCREENSHOT_DIR);
  });

  it('writes to the committed e2e/screenshots only with RIFFWAY_UPDATE_SCREENSHOTS=1', () => {
    expect(COMMITTED_SCREENSHOT_DIR).toBe(join(ROOT, 'e2e/screenshots'));
    expect(screenshotDir({ RIFFWAY_UPDATE_SCREENSHOTS: '1' })).toBe(COMMITTED_SCREENSHOT_DIR);
    expect(screenshotDir({ RIFFWAY_UPDATE_SCREENSHOTS: 'true' })).toBe(COMMITTED_SCREENSHOT_DIR);
  });
});
