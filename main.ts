import { createApp } from './app.ts';

// Small pause helper used by both retry loops below.
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One HTTP attempt that gives up after thirty seconds.
async function attempt(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  // The environment endpoint is mandatory; normalise it once up front.
  const rawUrl = process.env.MAKEFUN_ENV_URL ?? '';
  const base = rawUrl.replace(/\/+$/, '');
  if (base.length === 0) {
    console.error('MAKEFUN_ENV_URL is missing or empty, cannot register');
    process.exit(1);
  }

  const server = createApp();

  // Port 0 means the operating system picks a free ephemeral port for us.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not report a TCP address');
  }
  const port: number = address.port;
  console.log(`entry listening on port ${port}`);

  // Announce ourselves to the environment. A conflict still counts as
  // registered, a contract problem is fatal, anything else is retried
  // with a growing delay between attempts.
  let registerWait = 250;
  for (;;) {
    let status: number | null = null;
    try {
      const reply = await attempt(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      status = reply.status;
    } catch {
      status = null;
    }

    if (status === 200 || status === 409) {
      break;
    }
    if (status === 400 || status === 405) {
      console.error(`register rejected with status ${status}`);
      process.exit(1);
    }

    await pause(registerWait);
    registerWait = Math.min(registerWait * 2, 2000);
  }

  // Keep asking the environment whether the run is finished. Any
  // hiccup here only delays the next check, it never ends the run.
  let pollWait = 250;
  for (;;) {
    let finished = false;
    try {
      const reply = await attempt(`${base}/done`, { method: 'GET' });
      if (reply.status === 200) {
        const payload = (await reply.json()) as { done?: unknown };
        finished = payload.done === true;
      }
    } catch {
      finished = false;
    }

    if (finished) {
      break;
    }

    await pause(pollWait);
    pollWait = Math.min(pollWait * 2, 2000);
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  console.log('done received, server closed, exiting');
  process.exit(0);
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`fatal: ${message}`);
  process.exit(1);
});
