import { formatAmount, InvalidAmountError, parseAmount } from './money';

describe('money', () => {
  it.each([
    ['1', 100n],
    ['1.5', 150n],
    ['1.05', 105n],
    ['0.01', 1n],
    ['999999999999999.99', 99999999999999999n],
  ])('parses %s to %s cents', (input, cents) => {
    expect(parseAmount(input)).toBe(cents);
  });

  it.each(['0', '0.00', '-1', '1.234', '1e3', '01', '.5', '1.', ' 1', 'NaN', ''])('rejects %j', (input) => {
    expect(() => parseAmount(input)).toThrow(InvalidAmountError);
  });

  it('rejects JSON numbers, so floats never reach the ledger', () => {
    expect(() => parseAmount(0.1 + 0.2)).toThrow(InvalidAmountError);
  });

  it.each([
    [0n, '0.00'],
    [1n, '0.01'],
    [150n, '1.50'],
    [-2505n, '-25.05'],
  ])('formats %s cents as %s', (cents, text) => {
    expect(formatAmount(cents)).toBe(text);
  });
});
