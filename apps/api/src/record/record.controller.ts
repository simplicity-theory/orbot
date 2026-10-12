import { BadRequestException, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';
import { EventQuery, SearchQuery } from '@orbot/shared';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { RecordService } from './record.service.js';

const Uuid = new ParseUUIDPipe();
const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean)));

const SearchParams = SearchQuery.extend({ types: csv });
const EventParams = EventQuery.extend({ kinds: csv.pipe(EventQuery.shape.kinds) });
const AsOfParams = z.object({ at: z.iso.datetime({ offset: true }) });

/** Read access to the permanent record: history, as-of views, diffs, search. */
@Controller('record')
export class RecordController {
  constructor(private readonly record: RecordService) {}

  @Get('search')
  search(@Query(new ZodPipe(SearchParams)) q: z.output<typeof SearchParams>) {
    return this.record.search(q);
  }

  @Get('events')
  events(@Query(new ZodPipe(EventParams)) q: z.output<typeof EventParams>) {
    return this.record.listEvents(q);
  }

  @Get(':entityId/history')
  history(@Param('entityId', Uuid) id: string) {
    return this.record.history(id);
  }

  @Get(':entityId/versions/:version')
  version(@Param('entityId', Uuid) id: string, @Param('version', ParseIntPipe) version: number) {
    return this.record.getVersion(id, version);
  }

  @Get(':entityId/as-of')
  async asOf(@Param('entityId', Uuid) id: string, @Query(new ZodPipe(AsOfParams)) q: z.infer<typeof AsOfParams>) {
    const v = await this.record.asOf(id, q.at);
    return { at: q.at, version: v };
  }

  @Get(':entityId/diff')
  diff(@Param('entityId', Uuid) id: string, @Query('from', ParseIntPipe) from: number, @Query('to', ParseIntPipe) to: number) {
    if (from === to) throw new BadRequestException('Pick two different versions to compare.');
    return this.record.diff(id, from, to);
  }
}
