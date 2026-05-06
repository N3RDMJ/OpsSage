import { langfuse as lf } from '@opssage/tools';
import type { Env } from '@opssage/config-schema';

export function buildTracer(env: Env): lf.LangfuseClient {
  return new lf.LangfuseClient({
    publicKey: env.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: env.LANGFUSE_SECRET_KEY ?? '',
    host: env.LANGFUSE_HOST,
  });
}
