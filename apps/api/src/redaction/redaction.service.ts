import { Inject, Injectable } from '@nestjs/common';
import { Redactor, type RedactionResult } from '@orbot/shared';
import { APP_CONFIG, configSecrets, type AppConfig } from '../config/config.js';

/**
 * The single redaction layer every outbound path goes through: record writes,
 * log lines, API responses, WebSocket messages and error messages.
 * It knows the live value of every secret in the store (registered by
 * SecretsService) plus ORBOT's own configuration secrets.
 */
@Injectable()
export class RedactionService {
  private readonly secrets = new Map<string, string>();
  private readonly redactor: Redactor;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    configSecrets(config).forEach((v, i) => this.secrets.set(`config:${i}`, v));
    this.redactor = new Redactor({ values: () => this.secrets.values() });
  }

  registerSecret(name: string, value: string): void {
    this.secrets.set(`store:${name}`, value);
  }

  forgetSecret(name: string): void {
    this.secrets.delete(`store:${name}`);
  }

  redactString(input: string): RedactionResult<string> {
    return this.redactor.redactString(input);
  }

  redactDeep<T>(input: T): RedactionResult<T> {
    return this.redactor.redactDeep(input);
  }

  /** Convenience for places that only need the cleaned value. */
  clean<T>(input: T): T {
    return this.redactor.redactDeep(input).value;
  }
}
