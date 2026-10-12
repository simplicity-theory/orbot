import type { DiffLine } from '@orbot/shared';
import { toRows } from './diff-view';

const l = (kind: DiffLine['kind'], text: string): DiffLine => ({
  kind,
  text,
  leftNo: null,
  rightNo: null,
});

describe('toRows (side-by-side diff pairing)', () => {
  it('puts a replacement next to what it replaced', () => {
    const rows = toRows([l('same', 'a'), l('removed', 'b'), l('added', 'B'), l('same', 'c')]);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'c'],
    ]);
  });

  it('pads uneven runs with blanks on the shorter side', () => {
    const rows = toRows([l('removed', 'x'), l('added', '1'), l('added', '2')]);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['x', '1'],
      [null, '2'],
    ]);
  });
});
