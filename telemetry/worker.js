// CAST's anonymous usage-counter endpoint — a Cloudflare Worker.
//
// Deliberately minimal: no per-user IDs, no IP logging, no request bodies
// beyond a single known event name. Every /event request just increments a
// global counter in KV — there is no way to attribute an event to a
// specific user, install, or session, by design (this app is opted OUT of
// tracking anything more granular than that, per its privacy policy).
//
// Routes:
//   POST /event   body: {"event": "app_open" | "video_generated" | "video_published"}
//                 -> 204 on success, 400 on an unknown event name
//   GET  /stats?key=STATS_KEY
//                 -> {"app_open": N, "video_generated": N, "video_published": N}
//                 requires the STATS_KEY secret (wrangler secret put STATS_KEY)
//                 so counts aren't publicly scrapeable.

const ALLOWED_EVENTS = ["app_open", "video_generated", "video_published"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/event" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response("Malformed JSON", { status: 400, headers: CORS_HEADERS });
      }
      const event = body && body.event;
      if (!ALLOWED_EVENTS.includes(event)) {
        return new Response("Unknown event", { status: 400, headers: CORS_HEADERS });
      }
      // KV has no atomic increment — read-then-write has a small race window
      // under real concurrency, but for a low-traffic anonymous counter an
      // occasional missed increment is an acceptable tradeoff against the
      // complexity of a Durable Object just to count clicks.
      const current = parseInt((await env.COUNTERS.get(event)) || "0", 10);
      await env.COUNTERS.put(event, String(current + 1));
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/stats" && request.method === "GET") {
      if (url.searchParams.get("key") !== env.STATS_KEY) {
        return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
      }
      const stats = {};
      for (const event of ALLOWED_EVENTS) {
        stats[event] = parseInt((await env.COUNTERS.get(event)) || "0", 10);
      }
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
