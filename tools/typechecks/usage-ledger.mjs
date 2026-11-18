// Compile-only contract checks. Expected errors ensure checkJs is active.
/** @param {import('../../src/usage-ledger.mjs').UsageLedger} ledger */
export function ledgerTypeContract(ledger) {
  const ticket = ledger.reserve({ diamonds: 2 }, { diamonds: 10 }, {}, { uniqueKey: 'example:1' });
  ledger.confirm(ticket);
  ledger.cancel({ id: ticket.id });
  ledger.resolveKey('example:1', true, { kind: 'example' });
  // @ts-expect-error Counter values must be numbers.
  ledger.reserve({ diamonds: '2' });
  // @ts-expect-error Confirmation requires a ticket with a day.
  ledger.confirm({ id: 'incomplete' });
  // @ts-expect-error A renamed key-record field must fail static checking.
  ledger.keyRecords()['example:1'].confirmation;
  // @ts-expect-error Unknown-operation identity must be a string.
  ledger.hasKey(123);
}
