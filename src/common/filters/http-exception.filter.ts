import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ErrorCode } from '../errors/api-error';
import { getRequestContext, logger } from '../logger/logger';

type ErrorBody = {
  statusCode?: number;
  code?: string;
  message?: string | string[];
  details?: string[];
  error?: string;
};

const ERROR_LABEL: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

/**
 * Renders every failure into one documented envelope.
 *
 * Guarantees:
 *  - `code` is always present and always a stable string from `ErrorCode`.
 *  - `requestId` is always present so a user can quote it in a bug report.
 *  - 5xx never carries an internal message. An `HttpException` thrown with a
 *    raw error object would otherwise forward that message verbatim, so we
 *    deliberately replace the message for any status >= 500.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = getRequestContext()?.requestId ?? 'unknown';
    const path = request.originalUrl ?? request.url;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const body: ErrorBody = typeof raw === 'string' ? { message: raw } : (raw as ErrorBody);

      const clientSafe = status < 500;
      const message = clientSafe ? firstMessage(body.message, exception.message) : 'Something went wrong on our side. Please try again.';
      const details = clientSafe ? normalizeDetails(body.message, body.details) : undefined;
      const code = clientSafe ? (body.code ?? fallbackCode(status)) : ErrorCode.INTERNAL_ERROR;

      if (status >= 500) {
        logger.error(
          { err: exception, status, path, requestId },
          'request failed with a server error',
        );
      } else if (status === HttpStatus.TOO_MANY_REQUESTS) {
        logger.warn({ status, path, requestId }, 'request rate limited');
      }

      response.status(status).json({
        statusCode: status,
        error: body.error ?? ERROR_LABEL[status] ?? 'Request failed',
        code,
        message,
        requestId,
        ...(details && details.length > 0 ? { details } : {}),
      });
      return;
    }

    // Prisma errors that escape service code would otherwise become opaque
    // 500s. Map the ones with a meaningful client story explicitly.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      logger.error({ err: exception, path, requestId }, 'prisma known request error');
      const mapped = mapPrismaError(exception);
      if (mapped) {
        response.status(mapped.status).json({
          statusCode: mapped.status,
          error: ERROR_LABEL[mapped.status] ?? 'Request failed',
          code: mapped.code,
          message: mapped.message,
          requestId,
        });
        return;
      }
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(genericBody(requestId));
      return;
    }

    logger.error({ err: exception, path, requestId }, 'unhandled error');
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(genericBody(requestId));
  }
}

function genericBody(requestId: string) {
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    error: 'Internal Server Error',
    code: ErrorCode.INTERNAL_ERROR,
    message: 'Something went wrong on our side. Please try again.',
    requestId,
  };
}

function firstMessage(message: string | string[] | undefined, fallback: string): string {
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  if (Array.isArray(message) && message.length > 0) {
    return message.length === 1
      ? message[0]
      : 'Some of the information you sent is not valid.';
  }
  return fallback;
}

function normalizeDetails(
  message: string | string[] | undefined,
  explicit?: string[],
): string[] | undefined {
  if (Array.isArray(message) && message.length > 1) {
    return message;
  }
  return explicit;
}

function fallbackCode(status: number): string {
  const byStatus: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
    [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
    [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
    [HttpStatus.NOT_FOUND]: ErrorCode.VALIDATION_FAILED,
    [HttpStatus.CONFLICT]: ErrorCode.ALREADY_IN_STATE,
    [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.UNSUPPORTED_PAYMENT_METHOD,
    [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
    [HttpStatus.BAD_GATEWAY]: ErrorCode.BANK_UNAVAILABLE,
    [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.BANK_UNAVAILABLE,
  };
  return byStatus[status] ?? ErrorCode.INTERNAL_ERROR;
}

/**
 * P2002 (unique violation) is the one Prisma error worth surfacing: it is how
 * the database enforces the idempotency and open-transaction invariants, so a
 * conflict is the correct answer, not a bug.
 */
function mapPrismaError(
  error: Prisma.PrismaClientKnownRequestError,
): { status: number; code: string; message: string } | null {
  switch (error.code) {
    case 'P2002':
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.ALREADY_IN_STATE,
        message: 'That record already exists or conflicts with the current state.',
      };
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.VALIDATION_FAILED,
        message: 'The record you asked for no longer exists.',
      };
    default:
      return null;
  }
}