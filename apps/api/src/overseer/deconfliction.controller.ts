import { Controller, Get } from '@nestjs/common';
import { DeconflictionService } from './deconfliction.service.js';

/** HQ's map of who touches what. */
@Controller('deconfliction')
export class DeconflictionController {
  constructor(private readonly deconfliction: DeconflictionService) {}

  @Get()
  view() {
    return this.deconfliction.view();
  }
}
