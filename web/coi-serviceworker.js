/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless = false;

// Cache-first for the large, rarely-changing vendored assets (ffmpeg cores,
// ONNX runtime, Piper phonemize wasm/data, fonts) — these only change when
// someone re-vendors a new build, so serving them from Cache Storage saves
// re-fetching ~50-90MB on every repeat visit. Bump CACHE_NAME (not the app's
// own VERSION in app.js) only when the vendored asset *set* itself changes.
// Everything else (index.html, app.js, ffmpeg-worker.js, this file) stays
// network-first/uncached, same as before — those change on every version
// bump, and caching them would reintroduce exactly the "testing against
// stale cached code" problem this app already hit once this session.
const CACHE_NAME = "slopdaddy-assets-v2";
const CACHEABLE_PATTERNS = [/\/vendor\//, /\/onnx\//, /\/piper\//];
function isCacheableAsset(url) {
    return url.origin === self.location.origin && CACHEABLE_PATTERNS.some((re) => re.test(url.pathname));
}

if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            // However cache cleanup goes, activation must still claim clients —
            // otherwise a storage error would leave pages running uncontrolled.
            .catch((e) => console.error(e))
            .then(() => self.clients.claim())
    ));

    self.addEventListener("message", (ev) => {
        if (!ev.data) {
            return;
        } else if (ev.data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => {
                    return self.clients.matchAll();
                })
                .then(clients => {
                    clients.forEach((client) => client.navigate(client.url));
                });
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;

        const cacheable = r.method === "GET" && isCacheableAsset(new URL(r.url));
        // Opened at most once per request and reused for both match/put below
        // — same named cache either way, no need to reopen it a second time.
        const cachePromise = cacheable ? caches.open(CACHE_NAME) : null;

        event.respondWith(
            (cachePromise ? cachePromise.then((cache) => cache.match(request)) : Promise.resolve(undefined))
                .then((cached) => cached || fetch(request)
                    .then((response) => {
                        if (response.status === 0) {
                            return response;
                        }

                        const newHeaders = new Headers(response.headers);
                        newHeaders.set("Cross-Origin-Embedder-Policy",
                            coepCredentialless ? "credentialless" : "require-corp"
                        );
                        if (!coepCredentialless) {
                            newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                        }
                        newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                        const finalResponse = new Response(response.body, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: newHeaders,
                        });

                        // Store the already header-injected response, so future cache
                        // hits carry the right COOP/COEP headers with no extra work.
                        // Clone first — a Response body can only be read/consumed once,
                        // and finalResponse itself still needs to go back to the page.
                        // Wrapped in waitUntil so the browser can't tear the worker down
                        // mid-write — without it, the write raced the worker's teardown
                        // and could be silently dropped.
                        if (cachePromise && response.ok) {
                            event.waitUntil(cachePromise.then((cache) => cache.put(request, finalResponse.clone())));
                        }
                        return finalResponse;
                    })
                )
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        // You can customize the behavior of this script through a global `coi` variable.
        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;
        const controlling = n.serviceWorker && n.serviceWorker.controller;

        // Record the failure if the page is served by serviceWorker.
        if (controlling && !window.crossOriginIsolated) {
            window.sessionStorage.setItem("coiCoepHasFailed", "true");
        }
        const coepHasFailed = window.sessionStorage.getItem("coiCoepHasFailed");

        if (controlling) {
            // Reload only on the first failure.
            const reloadToDegrade = coi.coepDegrade() && !(
                coepDegrading || window.crossOriginIsolated
            );
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (reloadToDegrade || coepHasFailed && coi.coepDegrade())
                    ? false
                    : coi.coepCredentialless(),
            });
            if (reloadToDegrade) {
                !coi.quiet && console.log("Reloading page to degrade COEP.");
                window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                coi.doReload("coepdegrade");
            }

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        // If we're already coi: do nothing. Perhaps it's due to this script doing its job, or COOP/COEP are
        // already set from the origin server. Also if the browser has no notion of crossOriginIsolated, just give up here.
        if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        // In some environments (e.g. Firefox private mode) this won't be available
        if (!n.serviceWorker) {
            !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }

        n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                registration.addEventListener("updatefound", () => {
                    !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                    coi.doReload();
                });

                // If the registration is active, but it's not controlling the page
                if (registration.active && !n.serviceWorker.controller) {
                    !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                    coi.doReload();
                }
            },
            (err) => {
                !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
            }
        );
    })();
}
