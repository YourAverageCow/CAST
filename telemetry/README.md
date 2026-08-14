# CAST telemetry worker

Anonymous usage counters for CAST — see `worker.js` for exactly what it does
and does not collect (no per-user IDs, no IP logging, three known event
names, nothing else). This exists to answer basic product questions ("how
many videos are people generating") without tracking anyone individually.

## One-time setup

1. Install the CLI (already available via `npx`, no global install needed):
   ```bash
   npx wrangler login
   ```
   Opens a browser to authorize wrangler against your Cloudflare account
   (create a free one at https://dash.cloudflare.com/sign-up first if you
   don't have one).

2. Create the KV namespace that stores the counters:
   ```bash
   npx wrangler kv namespace create COUNTERS
   ```
   Copy the `id` it prints into `wrangler.toml`'s `kv_namespaces` entry
   (replacing `REPLACE_WITH_KV_NAMESPACE_ID`).

3. Deploy:
   ```bash
   cd telemetry
   npx wrangler deploy
   ```
   Prints your Worker's real URL, something like
   `https://cast-telemetry.<your-subdomain>.workers.dev`.

4. Set a secret key for reading `/stats` (pick any random string):
   ```bash
   npx wrangler secret put STATS_KEY
   ```

5. Put the deployed Worker URL into `web/app.js`'s `TELEMETRY_ENDPOINT`
   constant (see that file — currently a placeholder) and redeploy the app.

## Checking the numbers

```bash
curl "https://cast-telemetry.<your-subdomain>.workers.dev/stats?key=<your STATS_KEY>"
```

## What's NOT here

Download counts don't need any of this — GitHub already tracks per-asset
download counts on every release for free:
```bash
gh release view <tag> --repo YourAverageCow/CAST --json assets --jq '.assets[] | {name, download_count}'
```
