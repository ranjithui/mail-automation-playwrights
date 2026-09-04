/**
 * Single PrismaClient instance for the whole process.
 *
 * `globalThis` caching keeps `tsx watch` from opening a new pool on every
 * reload during development.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __mailflowPrisma?: PrismaClient };

/**
 * Keeps this process's pool inside what the database will actually grant.
 *
 * Prisma sizes its pool from the CPU count - roughly `cores * 2 + 1`, so
 * seventeen on an ordinary laptop. Supabase's session pooler allows fifteen
 * clients per project in total, shared by every process: the API, each worker,
 * and anything run by hand. One busy worker can therefore exhaust the whole
 * allowance on its own, and everything else then fails to connect at all with
 *
 *   FATAL: (EMAXCONNSESSION) max clients reached in session mode
 *
 * which reads like the database is down rather than like this service being
 * greedy. Five is ample for a process whose work is mostly waiting on a
 * browser, and leaves room for the others.
 *
 * Only applied when the connection string does not say otherwise, so anybody
 * who has sized this deliberately keeps their setting.
 */
function withPoolLimit(raw: string | undefined): string | undefined {
  if (!raw || !/^postgres(ql)?:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '5');
    return url.toString();
  } catch {
    // An unparseable URL is Prisma's problem to report, not ours to mangle.
    return raw;
  }
}

const url = withPoolLimit(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.__mailflowPrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    ...(url ? { datasources: { db: { url } } } : {}),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.__mailflowPrisma = prisma;

export type { Prisma } from '@prisma/client';
export { PrismaClient } from '@prisma/client';
export default prisma;
