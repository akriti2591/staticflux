import { describe, expect, it } from 'vitest';
import { pagePart as fromDocument, ROOT_PART as rootFromDocument } from './document.js';
import { pagePart, ROOT_PART } from './parts.js';

describe('Studio part ids', () => {
  it('names the root part and one part per page (document.ts re-exports the same values)', () => {
    expect(ROOT_PART).toBe('root');
    expect(pagePart('p1' as never)).toBe('page:p1');
    expect(fromDocument).toBe(pagePart);
    expect(rootFromDocument).toBe(ROOT_PART);
  });
});
