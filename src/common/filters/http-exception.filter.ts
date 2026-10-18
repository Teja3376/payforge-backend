import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const rawMessage =
        typeof body === 'string'
          ? body
          : (body as { message?: string | string[] }).message;
      const details = Array.isArray(rawMessage)
        ? rawMessage.filter((item) => item.length > 0)
        : [rawMessage ?? exception.message];
      const message =
        details.length === 1
          ? details[0]
          : 'Some of the information you sent is not valid.';

      response.status(status).json({
        statusCode: status,
        error: errorLabel(status),
        message,
        ...(details.length > 1 ? { details } : {}),
      });
      return;
    }

    this.logger.error(exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Something went wrong on our side. Please try again.',
    });
  }
}

function errorLabel(status: number): string {
  const labels: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: 'Bad Request',
    [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
    [HttpStatus.FORBIDDEN]: 'Forbidden',
    [HttpStatus.NOT_FOUND]: 'Not Found',
    [HttpStatus.CONFLICT]: 'Conflict',
    [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
    [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  };
  return labels[status] ?? 'Request failed';
}
