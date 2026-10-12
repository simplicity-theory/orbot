import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { RedactionService } from './redaction.service.js';

/** Redacts every API response body before it leaves the server. */
@Injectable()
export class RedactionInterceptor implements NestInterceptor {
  constructor(private readonly redaction: RedactionService) {}

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => this.redaction.clean(body)));
  }
}
