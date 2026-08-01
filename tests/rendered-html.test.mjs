import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the DeveloperPulse experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(
    html,
    /<title>DeveloperPulse — System audio, visualized<\/title>/i,
  );
  assert.match(html, /Start visualizing/);
  assert.match(html, /Local processing only/);
  assert.match(html, /<html[^>]+data-theme="light"/i);
  assert.match(html, /src="\/theme-init\.js"/i);
  assert.match(html, /Switch to dark mode/);
  assert.match(html, /53 frequency columns by 7 response times/);
  assert.match(html, /Frequency/);
  assert.match(html, /Fast/);
  assert.match(html, /Medium/);
  assert.match(html, /Slow/);
  assert.match(html, /Less/);
  assert.match(html, /More/);
  assert.match(html, /Live Cells/);
  assert.match(html, /Timeline/);
  assert.doesNotMatch(html, /Pulse Cyan|Heat Amber/);
  assert.doesNotMatch(
    html,
    /codex-preview|react-loading-skeleton|Your site is taking shape/i,
  );
});
