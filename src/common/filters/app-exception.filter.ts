import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { AppException } from '../exceptions/app.exception';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'حدث خطأ غير متوقع';
    let code = 'INTERNAL_SERVER_ERROR';
    let errors: string[] = [];

    if (exception instanceof AppException) {
      status = exception.statusCode;
      message = exception.message;
      code = exception.code ?? 'APP_ERROR';
      errors = [exception.message];
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (typeof payload === 'string') {
        message = payload;
        errors = [payload];
      } else if (typeof payload === 'object' && payload !== null) {
        const body = payload as {
          message?: string | string[];
          error?: string;
        };
        if (Array.isArray(body.message)) {
          message = 'بيانات غير صالحة';
          errors = body.message;
          code = 'VALIDATION_ERROR';
          status = HttpStatus.BAD_REQUEST;
        } else if (typeof body.message === 'string') {
          message = body.message;
          errors = [body.message];
        }
      }
    } else if (exception instanceof Error) {
      errors = [safeError(exception)];
    }

    if (status >= 500) {
      this.logger.error(
        `Unhandled exception ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(ApiResponse.fail(message, code, errors));
  }
}

function safeError(exception: Error): string {
  const parts = [`${exception.name}: ${exception.message}`];
  if (exception.cause instanceof Error) {
    parts.push(`${exception.cause.name}: ${exception.cause.message}`);
  }
  const text = parts.join(' | ');
  return text.replace(/(Password|Pwd)\s*=\s*[^;]+/gi, '$1=***');
}
