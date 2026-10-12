import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a request body/query against a shared zod schema. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    return this.schema.parse(value);
  }
}
