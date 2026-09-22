import assert from 'node:assert/strict';
import test from 'node:test';

const apiUrl = process.env.TEST_API_URL ?? 'http://127.0.0.1:3000';
const webUrl = process.env.TEST_WEB_URL ?? 'http://127.0.0.1:8080';

// These smoke tests describe the deployed Compose stack, not application logic. Skip them when
// that stack is not running so the suite stays usable with only PostgreSQL up; any other failure
// is still reported, so a stack that is up but broken cannot be mistaken for a stack that is down.
async function stackIsRunning(): Promise<boolean> {
  for (const url of [apiUrl, webUrl]) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
    } catch {
      return false;
    }
  }
  return true;
}

// `pnpm test` globs every file, so an absent Compose stack should skip rather than fail: not
// having started it is not a defect. `pnpm test:smoke` is an explicit request for these tests,
// and silently passing with everything skipped would be a false green, so it sets this flag and
// the tests run and fail against an unreachable stack.
const stackRequired = process.env.SMOKE_REQUIRE_STACK === 'true';
const composeStackRunning = await stackIsRunning();
const needsStack = {
  skip: composeStackRunning || stackRequired
    ? false
    : 'Compose stack is not running (start it with `docker compose up -d --build --wait`)',
};

test('API readiness checks PostgreSQL and is reachable through the web proxy', needsStack, async () => {
  for (const url of [`${apiUrl}/health`, `${webUrl}/api/health`]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const health = await response.json();
    const { chaosEnabled, ...readiness } = health;
    assert.deepEqual(readiness, { status: 'ok', service: 'api', database: 'connected' });
    assert.equal(typeof chaosEnabled, 'boolean', 'health must report the chaos admission gate');
  }
});

test('web serves the built application and its JavaScript asset', needsStack, async () => {
  const response = await fetch(webUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  const script = html.match(/<script[^>]+src="([^"]+)"/);
  assert.ok(script?.[1], 'Built page must reference a JavaScript entry point');
  const asset = await fetch(new URL(script[1], webUrl));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
});

test('unknown API routes return JSON 404 through the web proxy', needsStack, async () => {
  const response = await fetch(`${webUrl}/api/not-implemented`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not found' });
});
