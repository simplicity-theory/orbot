import { randomUUID } from 'node:crypto';
import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { RedactionService } from '../redaction/redaction.service.js';
import { RedactingLogger } from '../redaction/redacting-logger.js';
import { pgCode } from '../record/record.service.js';
import type { ApiErrorBody } from './api-error.js';

const DEFAULT_ACTIONS: Record<number, string> = {
  400: 'Check the highlighted fields and try again.',
  401: 'Sign in again.',
  403: 'You are not allowed to do this. Ask a higher rank if you need it.',
  404: 'It may have been moved or the link is wrong. Go back to the ORBAT and navigate from there.',
  409: 'Reload to see the latest version, then try again.',
};

/**
 * Turns every exception into a plain-language error body. Never sends a stack
 * trace; unexpected errors get a reference that matches the (redacted) log entry.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(
    private readonly redaction: RedactionService,
    private readonly logger: RedactingLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.describe(exception);
    res.status(status).json(this.redaction.clean(body));
  }

  describe(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof ZodError) {
      return {
        status: 400,
        body: {
          error: {
            code: 'invalid-input',
            message: 'Some of the information sent was not valid.',
            action: DEFAULT_ACTIONS[400]!,
            issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const r = exception.getResponse();
      const message =
        typeof r === 'string'
          ? r
          : typeof (r as { message?: unknown }).message === 'string'
            ? (r as { message: string }).message
            : Array.isArray((r as { message?: unknown }).message)
              ? ((r as { message: string[] }).message).join('; ')
              : exception.message;
      const action =
        (typeof r === 'object' && typeof (r as { action?: unknown }).action === 'string'
          ? (r as { action: string }).action
          : undefined) ?? DEFAULT_ACTIONS[status] ?? 'Try again in a moment.';
      return { status, body: { error: { code: codeFor(status), message, action } } };
    }
    if (pgCode(exception) === 'OR001') {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          error: {
            code: 'append-only',
            message: 'The record is append-only; existing entries cannot be changed or removed.',
            action: 'Write a new version instead. The old one will be kept in the archive.',
          },
        },
      };
    }
    const ref = randomUUID().slice(0, 8);
    this.logger.error(exception instanceof Error ? exception : new Error(String(exception)), `ref=${ref}`, 'ErrorFilter');
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'internal',
          message: 'Something went wrong on our side.',
          action: `Try again. If it keeps happening, check the API log for reference ${ref}.`,
          ref,
        },
      },
    };
  }
}

function codeFor(status: number): string {
  switch (status) {
    case 400:
      return 'invalid-input';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 409:
      return 'conflict';
    default:
      return status >= 500 ? 'internal' : 'error';
  }
}
