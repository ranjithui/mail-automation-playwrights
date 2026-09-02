/** Uniform API envelope, error taxonomy and async route wrapper. */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ApiFailure, ApiSuccess, Paginated } from '@mail/shared';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown) {
    return new AppError(400, code, message, details);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to do that', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }
  static notFound(entity: string, code = 'NOT_FOUND') {
    return new AppError(404, code, `${entity} not found`);
  }
  static conflict(message: string, code = 'CONFLICT') {
    return new AppError(409, code, message);
  }
  static tooMany(message = 'Too many requests') {
    return new AppError(429, 'RATE_LIMITED', message);
  }
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200) {
  const body: ApiSuccess<T> = { success: true, data, ...(meta ? { meta } : {}) };
  return res.status(status).json(body);
}

export function paginate<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export const handler =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    const body: ApiFailure = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues[0]?.message ?? 'Invalid request',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
    return res.status(422).json(body);
  }

  if (error instanceof AppError) {
    const body: ApiFailure = {
      success: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
    return res.status(error.status).json(body);
  }

  // Prisma unique-constraint violations map cleanly onto 409.
  const prismaCode = (error as { code?: string })?.code;
  if (prismaCode === 'P2002') {
    const target = (error as { meta?: { target?: string[] } })?.meta?.target?.join(', ') ?? 'value';
    const body: ApiFailure = {
      success: false,
      error: { code: 'DUPLICATE', message: `That ${target} is already in use` },
    };
    return res.status(409).json(body);
  }
  if (prismaCode === 'P2025') {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Record not found' } });
  }

  console.error('[api] unhandled error', error);
  const body: ApiFailure = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unexpected server error',
    },
  };
  return res.status(500).json(body);
}
