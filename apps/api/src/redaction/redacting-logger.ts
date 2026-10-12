import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { RedactionService } from './redaction.service.js';

export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

/**
 * Nest logger backed by pino. Every message and every structured field passes
 * through the redaction layer before it is serialised, so no log line can
 * carry a secret value.
 */
@Injectable()
export class RedactingLogger implements LoggerService {
  private readonly pino: Logger;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly redaction: RedactionService,
    @Inject(LOG_DESTINATION) destination: DestinationStream | null,
  ) {
    this.pino = pino(
      {
        level: config.logLevel,
        base: { app: config.productName.toLowerCase() },
        hooks: {
          // Last line of defence: whatever reaches pino is redacted, including
          // calls made directly on `raw`.
          logMethod: (args, method) => {
            method.apply(this.pino, this.redaction.clean(args) as Parameters<typeof method>);
          },
        },
      },
      destination ?? pino.destination(1),
    );
  }

  /** Direct pino access for structured logging; still redacted. */
  get raw(): Logger {
    return this.pino;
  }

  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }

  private write(level: pino.Level, message: unknown, rest: unknown[]) {
    // Nest passes the context name as the last string argument.
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const fields: Record<string, unknown> = context ? { context } : {};
    if (rest.length) fields['detail'] = rest;
    if (message instanceof Error) {
      this.pino[level]({ ...fields, err: { name: message.name, message: message.message, stack: message.stack } }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.pino[level]({ ...fields, ...(message as object) });
    } else {
      this.pino[level](fields, String(message));
    }
  }
}
