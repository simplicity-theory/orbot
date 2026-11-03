import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ServerOptions } from 'socket.io';
import { AppModule, type AppModuleOptions } from './app.module.js';
import type { AppConfig } from './config/config.js';
import { RedactingLogger } from './redaction/redacting-logger.js';

/** Builds the Nest app. Shared by `main.ts`, the seed script and the e2e tests. */
export async function createApp(opts: AppModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(opts), {
    bufferLogs: true,
  });
  const { config } = opts;
  app.useLogger(app.get(RedactingLogger));
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders(config));
  app.enableCors({ origin: config.webOrigin, credentials: true });
  app.useWebSocketAdapter(new OriginIoAdapter(app, config.webOrigin));
  if (config.webDist) serveWeb(app, config.webDist);
  app.enableShutdownHooks();
  return app;
}

/** The live feed accepts the web origin only (same-origin connections always match). */
class OriginIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly origin: string,
  ) {
    super(app);
  }
  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origin, credentials: true },
    } as ServerOptions);
  }
}

/**
 * Headers every response carries. The Content-Security-Policy is for the web app; a handler
 * that serves other HTML (bot-written pages) sets its own, which is why it is only filled in
 * when the response has none by the time headers go out.
 */
export function securityHeaders(config: AppConfig) {
  const csp = webCsp(config.webDist);
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.cookieSecure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (!req.path.startsWith('/api')) {
      const setHeaders = res.writeHead.bind(res);
      res.writeHead = ((...args: Parameters<Response['writeHead']>) => {
        if (!res.hasHeader('Content-Security-Policy')) {
          res.setHeader('Content-Security-Policy', csp);
        }
        return setHeaders(...args);
      }) as Response['writeHead'];
    }
    next();
  };
}

/**
 * Angular's production index.html carries one inline script (it restores the media of the
 * critical-CSS links); its hash is allowed, nothing else inline.
 */
export function webCsp(webDist: string | null): string {
  const hashes: string[] = [];
  const index = webDist ? join(webDist, 'index.html') : null;
  if (index && existsSync(index)) {
    const html = readFileSync(index, 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      hashes.push(`'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
    }
  }
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ` ${hashes.join(' ')}` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Serve the built web app next to the API: hashed assets are cached for a year, everything
 * else is the app shell (the router takes it from there). `/api` is never touched.
 */
function serveWeb(app: NestExpressApplication, dist: string) {
  const index = join(dist, 'index.html');
  if (!existsSync(index)) {
    throw new Error(
      `ORBOT_WEB_DIST points at ${dist}, which has no index.html. Build the web app (npm run build -w @orbot/web) or unset ORBOT_WEB_DIST.`,
    );
  }
  const hashed = /[-.][A-Za-z0-9_-]{8,}\.(js|css|woff2?|ttf|svg|png|ico|map)$/;
  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, path) => {
        res.setHeader(
          'Cache-Control',
          hashed.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api')) return next();
    if (!req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
