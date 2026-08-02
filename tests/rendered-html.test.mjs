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
  assert.match(html, /Visualize audio/);
  assert.doesNotMatch(html, /Your audio will appear here/);
  assert.doesNotMatch(html, /Local processing only/);
  assert.match(html, /<html[^>]+data-theme="light"/i);
  assert.match(html, /src="\/theme-init\.js"/i);
  assert.match(html, /Switch to dark mode/);
  assert.match(
    html,
    /<header class="topbar">[\s\S]*aria-label="DeveloperPulse"[\s\S]*DeveloperPulse[\s\S]*<\/header>/,
  );
  assert.doesNotMatch(
    html,
    /<header class="topbar">[\s\S]*class="theme-toggle"[\s\S]*<\/header>/,
  );
  assert.doesNotMatch(html, /class="(?:panel-head|capture-state|state-title)"/);
  assert.match(
    html,
    /class="controls"[\s\S]*Visualize audio[\s\S]*class="control-elapsed"[^>]*>00:00<\/span>[\s\S]*class="display-controls"[\s\S]*class="theme-toggle"[\s\S]*Live Cells[\s\S]*Timeline/,
  );
  assert.match(html, /taller columns indicate more sudden rises in audio/);
  assert.match(html, /Frequency/);
  assert.match(html, /Sudden/);
  assert.match(html, /Rising/);
  assert.match(html, /Steady/);
  assert.doesNotMatch(html, /\b(?:Strong|Medium|Soft)\b/);
  assert.match(html, /Quiet/);
  assert.match(html, /Loud/);
  assert.match(html, /Live Cells/);
  assert.match(html, /Timeline/);
  assert.match(html, /Display mode/);
  assert.doesNotMatch(
    html,
    /class="control-label visually-hidden">\s*Visualizer mode/,
  );
  assert.doesNotMatch(html, /Toggle fullscreen/);
  assert.doesNotMatch(html, /state-detail|Chrome tab audio/);
  assert.doesNotMatch(html, /Pulse Cyan|Heat Amber/);
  assert.doesNotMatch(
    html,
    /codex-preview|react-loading-skeleton|Your site is taking shape/i,
  );
});
