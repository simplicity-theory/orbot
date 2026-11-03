import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.guard.js';
import { SitesService } from './sites.service.js';
import { slug } from './servers.service.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

/**
 * The published page runs in a sandbox with an opaque origin: it cannot read ORBOT's cookies,
 * call its API as the viewer, or fetch anything from another origin. A single-file app needs
 * none of that; its own markup, styles and scripts are inline.
 */
const SANDBOX_CSP = [
  'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** What a static site publishes, served as it is. Public: a deployed product is for its users. */
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  /** The entry file as a download, named after the site. */
  @Public()
  @Get(':id/download')
  async download(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const site = await this.sites.get(id);
    const file = site && (await this.sites.published(site, ''));
    if (!site || !file) throw this.nothing();
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(createReadStream(file.file), {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${slug(site.body.name)}${extname(file.name) || '.html'}"`,
    });
  }

  /** The root. Without the trailing slash (relative links would break), sent to it. */
  @Public()
  @Get(':id')
  async root(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!req.path.endsWith('/')) {
      res.redirect(302, `/api/sites/${id}/`);
      return;
    }
    return this.serve(id, '', res);
  }

  @Public()
  @Get(':id/*path')
  async file(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = req.params['path'];
    return this.serve(
      id,
      decodeURIComponent(Array.isArray(raw) ? raw.join('/') : (raw ?? '')),
      res,
    );
  }

  private async serve(id: string, path: string, res: Response) {
    const site = await this.sites.get(id);
    const file = site && (await this.sites.published(site, path));
    if (!site || !file) throw this.nothing();
    res.setHeader('Content-Security-Policy', SANDBOX_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-cache');
    return new StreamableFile(createReadStream(file.file), {
      type: TYPES[extname(file.name).toLowerCase()] ?? 'application/octet-stream',
    });
  }

  private nothing() {
    return new NotFoundException({
      message: 'Nothing is published here.',
      action: 'Deploy the operation: the deploy task publishes the site.',
    });
  }
}
