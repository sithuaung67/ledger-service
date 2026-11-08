/**
 * Money is stored and calculated as integer minor units (cents) in a bigint.
 * The API only accepts and returns decimal strings like "12.34", so a floating
 * point number never touches an amount.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,14})(\.\d{1,2})?$/;

export class InvalidAmountError extends Error {}

/** Parses a positive decimal string ("10", "10.5", "10.50") into cents. */
export function parseAmount(input: unknown): bigint {
  if (typeof input !== 'string' || !AMOUNT_PATTERN.test(input)) {
    throw new InvalidAmountError(
      'amount must be a decimal string with at most 2 decimal places, e.g. "12.34"',
    );
  }
  const [whole, fraction = ''] = input.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw new InvalidAmountError('amount must be greater than 0');
  return cents;
}

/** Formats cents as a decimal string with exactly 2 decimal places. */
export function formatAmount(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
