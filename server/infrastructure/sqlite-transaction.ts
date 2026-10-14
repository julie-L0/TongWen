import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// Both repositories share one connection. Savepoints let application commands
// compose without committing half a decision/proposal update.
export function sqliteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const nested = db.isTransaction;
  const savepoint = 'sp_' + randomUUID().replaceAll('-', '');
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } else db.exec('ROLLBACK');
    throw error;
  }
}
