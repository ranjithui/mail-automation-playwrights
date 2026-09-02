/**
 * Single PrismaClient instance for the whole process.
 *
 * `globalThis` caching keeps `tsx watch` from opening a new pool on every
 * reload during development.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __mailflowPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.__mailflowPrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.__mailflowPrisma = prisma;

export type { Prisma } from '@prisma/client';
export { PrismaClient } from '@prisma/client';
export default prisma;
