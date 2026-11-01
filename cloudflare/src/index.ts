import { Container, getContainer } from '@cloudflare/containers';

/**
 * Cloudflare Worker that fronts the annotation-tool Next.js server running in a
 * Cloudflare Container (see ../../annotation-tool/Dockerfile). The Worker holds no
 * application logic: it injects configuration and proxies every request.
 *
 * Plain values live in wrangler.jsonc `vars`; secrets are set with
 * `wrangler secret put` (never committed). See annotation-tool/docs/CLOUDFLARE_DEPLOY.md.
 */

/** Names forwarded from the Worker environment into the container process. */
const FORWARDED_ENV = [
  'SECRET_KEY',
  'DATABASE_URL',
  'BLOB_READ_WRITE_TOKEN',
  'BLOB_STORE_ID',
  'LOCK_TTL_SECONDS',
  'LOCK_HEARTBEAT_SECONDS',
  'BOOTSTRAP_ADMIN_NAME',
  'BOOTSTRAP_ADMIN_EMAIL',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_DRIVE_EXPORT_FOLDER_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
] as const;

/**
 * Without these the app would silently fall back to embedded PGlite and the
 * container's ephemeral disk (db.ts / storage.ts only refuse that fallback on Vercel),
 * so annotations would be lost whenever the container sleeps. Refuse to serve instead.
 */
const REQUIRED_ENV = ['SECRET_KEY', 'DATABASE_URL', 'BLOB_READ_WRITE_TOKEN'] as const;

type ForwardedEnv = { [K in (typeof FORWARDED_ENV)[number]]?: string };

export interface Env extends ForwardedEnv {
  APP: DurableObjectNamespace<AppContainer>;
}

export class AppContainer extends Container<Env> {
  defaultPort = 3000;
  // Memory and disk are billed while the instance is awake; the app is stateless
  // (state lives in Postgres/Blob/IndexedDB), so sleeping and cold-starting is safe.
  sleepAfter = '10m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const forwarded: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '3000',
      HOSTNAME: '0.0.0.0',
      NEXT_TELEMETRY_DISABLED: '1',
    };
    for (const name of FORWARDED_ENV) {
      const value = env[name];
      if (typeof value === 'string' && value !== '') forwarded[name] = value;
    }
    this.envVars = forwarded;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const missing = REQUIRED_ENV.filter((name) => !env[name]);
    if (missing.length > 0) {
      return Response.json(
        { code: 'NOT_CONFIGURED', message: `Missing Worker configuration: ${missing.join(', ')}` },
        { status: 503 },
      );
    }
    // One shared instance: the app is stateless, locks and revisions are enforced in the
    // database. Switch to getRandom(env.APP, n) only after checking export memory/CPU.
    return getContainer(env.APP).fetch(request);
  },
} satisfies ExportedHandler<Env>;
