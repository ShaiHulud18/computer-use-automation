/**
 * Seed data for the mock "Legacy CU Core" target application.
 *
 * ALL DATA HERE IS FICTIONAL — invented members and balances used for demos
 * and tests only. Member 99999 is deliberately absent so the "not found"
 * business outcome can be exercised on demand.
 *
 * Balances are stored in integer cents (classic core-banking practice: never
 * floats for money) and formatted only at render time.
 */

export interface Account {
  /** The mock keeps the classic share pair every core system has. */
  kind: "Savings" | "Checking";
  balanceCents: number;
}

export interface Member {
  /** 5-digit member number — the app's only search key. */
  id: string;
  name: string;
  status: "Active" | "Frozen";
  accounts: Account[];
}

/** The full seeded book of business. */
export const MEMBERS: readonly Member[] = [
  {
    id: "12345",
    name: "Margaret Chen",
    status: "Active",
    accounts: [
      { kind: "Savings", balanceCents: 452_119 },
      { kind: "Checking", balanceCents: 120_450 },
    ],
  },
  {
    id: "23456",
    name: "Dev Patel",
    status: "Active",
    accounts: [
      { kind: "Savings", balanceCents: 98_204 },
      { kind: "Checking", balanceCents: 31_077 },
    ],
  },
  {
    id: "34567",
    name: "Rosa Alvarez",
    status: "Frozen",
    accounts: [
      { kind: "Savings", balanceCents: 1_588_000 },
      { kind: "Checking", balanceCents: 4_213 },
    ],
  },
];

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id);
}

/** Products offered by the "Open Sub-Account" flow, in display order. */
export const SUB_ACCOUNT_TYPES: readonly string[] = [
  "Holiday Club Savings",
  "Money Market",
];

/**
 * Format cents as "$4,521.19". Hand-rolled instead of toLocaleString so the
 * output is byte-identical regardless of the host's ICU build — replay
 * assertions and extraction regexes compare these strings exactly.
 */
export function formatUsd(cents: number): string {
  const dollars = Math.trunc(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rem = Math.abs(cents % 100).toString().padStart(2, "0");
  return `$${dollars}.${rem}`;
}
