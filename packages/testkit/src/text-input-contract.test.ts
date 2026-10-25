// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { editContextContractSubject, FakeEditContext, hiddenTextareaContractSubject, runTextInputContract, textInputContractCases } from './index.js';

runTextInputContract('EditContext (fake platform)', editContextContractSubject(), { describe, it });
runTextInputContract('hidden textarea (Firefox events)', hiddenTextareaContractSubject(), { describe, it });

describe('text input contract suite', () => {
  it('has the cases and honours skip', () => {
    expect(textInputContractCases.length).toBeGreaterThanOrEqual(10);
    const names: string[] = [];
    runTextInputContract('skip', editContextContractSubject(), { describe: (_n, fn) => fn(), it: (n) => names.push(n) }, { skip: [textInputContractCases[0]?.name ?? ''] });
    expect(names).toHaveLength(textInputContractCases.length - 1);
  });

  it('the fake EditContext behaves like Chromium for typing and deletes', () => {
    const ec = new FakeEditContext();
    const updates: string[] = [];
    ec.addEventListener('textupdate', (e) => updates.push((e as Event & { text: string }).text));
    ec.type('a😀');
    ec.deleteBackward();
    expect(ec.text).toBe('a');
    ec.updateSelection(0, 0);
    ec.deleteForward();
    expect(ec.text).toBe('');
    expect(updates).toEqual(['a', '😀', '', '']);
  });
});
