import { newDb } from 'pg-mem';
import { LedgerDB, type PoolLike } from '../../src/db/ledger_db.js';

/** Throwaway in-memory Postgres (pg-mem) for tests; never touches Supabase. */
export async function memoryLedger(): Promise<LedgerDB> {
  const { Pool } = newDb().adapters.createPg();
  return LedgerDB.fromPool(new Pool() as unknown as PoolLike, 'in-memory-test');
}
