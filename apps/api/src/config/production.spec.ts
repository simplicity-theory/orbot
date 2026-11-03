import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';

const base = {
  ORBOT_SECRETS_KEY: createHash('sha256').update('k').digest('base64'),
  ORBOT_COMMANDER_PASSPHRASE: 'a-long-enough-passphrase',
  ORBOT_SESSION_SECRET: 'a-session-secret-of-at-least-32-characters',
  ORBOT_DB_OWNER_PASSWORD: 'real-owner',
  ORBOT_DB_APP_PASSWORD: 'real-app',
  ORBOT_DB_SECRETS_PASSWORD: 'real-secrets',
};

describe('production configuration', () => {
  it('refuses placeholder passwords and a plain-http origin in production, naming the setting', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        ORBOT_DB_APP_PASSWORD: 'change-me-app',
        ORBOT_WEB_ORIGIN: 'http://orbot.example.com',
      }),
    ).toThrow(
      /ORBOT_DB_APP_PASSWORD is still the placeholder[\s\S]*ORBOT_WEB_ORIGIN is plain http/,
    );
  });

  it('accepts an https origin, and localhost over http, in production', () => {
    const c = loadConfig({
      ...base,
      NODE_ENV: 'production',
      ORBOT_WEB_ORIGIN: 'https://orbot.example.com',
    });
    expect(c.production).toBe(true);
    expect(c.cookieSecure).toBe(true);
    const local = loadConfig({
      ...base,
      NODE_ENV: 'production',
      ORBOT_WEB_ORIGIN: 'http://localhost:3000',
    });
    expect(local.cookieSecure).toBe(false);
  });

  it('cookie security follows the origin unless set, and the proxy is not trusted by default', () => {
    const dev = loadConfig({
      ...base,
      NODE_ENV: 'development',
      ORBOT_WEB_ORIGIN: 'http://localhost:4200',
    });
    expect(dev.cookieSecure).toBe(false);
    expect(dev.trustProxy).toBe(false);
    expect(dev.webDist).toBeNull();
    const forced = loadConfig({
      ...base,
      NODE_ENV: 'development',
      ORBOT_COOKIE_SECURE: 'on',
      ORBOT_TRUST_PROXY: 'on',
      ORBOT_WEB_DIST: 'apps/web/dist/web/browser',
    });
    expect(forced.cookieSecure).toBe(true);
    expect(forced.trustProxy).toBe(true);
    expect(forced.webDist).toMatch(/\/apps\/web\/dist\/web\/browser$/);
  });
});
