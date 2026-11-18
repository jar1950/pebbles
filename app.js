// Pebble gift site. Runs entirely in the phone's browser; there is no server.
// Plan A: not connected -> open the Pebble's playlist on the maker's Spotify.
// Plan B: connected tester -> fresh mix into a playlist in THEIR Spotify, then play it.
(function () {
  "use strict";
  const ROOT = new URL(document.body.dataset.page === "tap" ? "../../" : "./", location.href);
  const API = "https://api.spotify.com/v1/";
  const SCOPES = "playlist-modify-private playlist-modify-public user-modify-playback-state";
  const MIX = 25;            // songs per tap
  const AVOID = 40;          // don't repeat the last 40 songs of this Pebble on this phone
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("pebble." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("pebble." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem("pebble." + k); } catch (e) { /* */ } },
  };
  const say = (text, state) => { if ($("msg")) $("msg").textContent = text; if (state && $("state")) $("state").textContent = state; };

  async function config() {
    const r = await fetch(new URL("gifts.json", ROOT), { cache: "no-store" });
    if (!r.ok) throw new Error("gift list missing");
    return r.json();
  }
  const redirectUri = (cfg) => cfg.site.replace(/\/$/, "") + "/connect.html";

  // ------------------------------------------------------------ Spotify login (PKCE)
  function randomText(n) {
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.from(a, (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
  }
  async function challenge(verifier) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function login(cfg, back) {
    const verifier = randomText(64);
    store.set("verifier", verifier);
    store.set("back", back || "");
    const q = new URLSearchParams({
      response_type: "code", client_id: cfg.client_id, scope: SCOPES,
      redirect_uri: redirectUri(cfg), code_challenge_method: "S256",
      code_challenge: await challenge(verifier), state: randomText(16),
    });
    store.set("state", q.get("state"));
    location.href = "https://accounts.spotify.com/authorize?" + q;
  }
  async function tokenCall(cfg, params) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.assign({ client_id: cfg.client_id }, params)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || "login failed");
    const old = store.get("token", {});
    const token = { access: j.access_token, refresh: j.refresh_token || old.refresh,
                    expires: Date.now() + (j.expires_in - 60) * 1000 };
    store.set("token", token);
    return token;
  }
  async function accessToken(cfg) {
    const t = store.get("token", null);
    if (!t || !t.refresh) return null;
    if (t.access && Date.now() < t.expires) return t.access;
    try { return (await tokenCall(cfg, { grant_type: "refresh_token", refresh_token: t.refresh })).access; }
    catch (e) { store.del("token"); return null; }   // login expired: back to Plan A
  }
  async function spotify(token, method, path, body) {
    const r = await fetch(API + path, {
      method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || "Spotify " + r.status); e.status = r.status; throw e; }
    return j;
  }

  // ------------------------------------------------------------------- tap page
  function pick(pool, pid) {
    const recent = new Set(store.get("recent." + pid, []));
    let fresh = pool.filter((s) => !recent.has(s.u));
    if (fresh.length < MIX) fresh = pool.slice();
    for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; }
    const mix = fresh.slice(0, MIX);
    store.set("recent." + pid, [...recent, ...mix.map((s) => s.u)].slice(-AVOID));
    return mix;
  }

  async function freshMix(cfg, token, pid, gift) {
    const lists = store.get("lists", {});
    const body = { uris: pick(gift.pool, pid).map((s) => s.u) };
    let id = lists[pid];
    if (id) {
      try { await spotify(token, "PUT", "playlists/" + id + "/items", body); }
      catch (e) { if (e.status === 401 || e.status === 403) throw e; id = null; }   // deleted: make a new one
    }
    if (!id) {
      const made = await spotify(token, "POST", "me/playlists",
        { name: "Pebble · " + gift.name, description: (gift.intent || "A Pebble.").slice(0, 280), public: false });
      id = made.id;
      await spotify(token, "POST", "playlists/" + id + "/items", body);
      lists[pid] = id; store.set("lists", lists);
    }
    let playing = false;
    try { await spotify(token, "PUT", "me/player/play", { context_uri: "spotify:playlist:" + id }); playing = true; }
    catch (e) { /* no open Spotify on any device: the button opens it */ }
    return { id, playing };
  }

  function openButton(playlist, go) {
    const url = "https://open.spotify.com/playlist/" + playlist;
    $("open").href = url; $("open").classList.remove("hidden");
    if (go) setTimeout(() => location.replace(url), 500);
  }

  async function tapPage() {
    const parts = location.pathname.split("/").filter((x) => x && x !== "index.html");
    const pid = decodeURIComponent(parts.pop() || "").toLowerCase();
    let cfg;
    try { cfg = await config(); } catch (e) { return say("This Pebble's page isn't ready yet. Try again in a minute.", "Error"); }
    const gift = cfg.gifts[pid];
    if (!gift) return say("Unknown Pebble.", "Error");
    document.title = gift.name + " · Pebble";
    $("name").textContent = gift.name;
    if (gift.cover) { const img = new Image(); img.alt = ""; img.src = new URL(gift.cover, ROOT).href; $("cover").textContent = ""; $("cover").appendChild(img); }
    $("connect").href = new URL("connect.html?back=" + encodeURIComponent(pid), ROOT).href;

    const token = await accessToken(cfg);
    if (token && gift.pool && gift.pool.length) {
      say("Making a fresh mix in your Spotify…", "Mixing");
      try {
        const r = await freshMix(cfg, token, pid, gift);
        say(r.playing ? "Playing a fresh mix on your Spotify." : "Fresh mix ready. Open Spotify and press play.", r.playing ? "Playing" : "Ready");
        openButton(r.id, !r.playing);
        return;
      } catch (e) {
        if (e.status === 401 || e.status === 403) store.del("token");
        say("Your Spotify isn't connected as a tester (" + e.message + "). Opening the shared playlist instead.", "Shared");
      }
    }
    if (gift.playlist) {
      if (!token) say("Opening in Spotify…", "Opening");
      $("tester").classList.remove("hidden");
      openButton(gift.playlist, true);
    } else {
      say("This Pebble has no shared playlist yet.", "Error");
      $("tester").classList.remove("hidden");
    }
  }

  // --------------------------------------------------------------- connect page
  async function connectPage() {
    let cfg;
    try { cfg = await config(); } catch (e) { return say("Gift site isn't ready yet.", "Error"); }
    const q = new URLSearchParams(location.search);
    const back = q.get("back") || "";
    const connected = (yes) => {
      $("go").classList.toggle("hidden", yes); $("forget").classList.toggle("hidden", !yes);
      $("title").textContent = yes ? "Connected ✓" : "Connect your Spotify";
      $("step").textContent = yes ? "Done" : "Step 1 of 1";
      say(yes ? "This phone is connected. Now tap a Pebble (or open its link): a fresh mix plays in your Spotify." :
                "Do this once. Then every Pebble you tap makes a fresh mix in your own Spotify (Premium) and starts playing.",
          yes ? "Connected" : "Tester");
    };
    $("forget").onclick = () => { store.del("token"); store.del("lists"); connected(false); };
    connected(!!store.get("token", null));
    $("go").onclick = () => login(cfg, back);

    if (q.get("error")) return say("Spotify said: " + q.get("error") + ". Try again.", "Error");
    if (q.get("code")) {
      if (q.get("state") !== store.get("state", "")) return say("Login didn't match. Press Connect again.", "Error");
      say("Connecting…", "Wait");
      try {
        await tokenCall(cfg, { grant_type: "authorization_code", code: q.get("code"),
                               redirect_uri: redirectUri(cfg), code_verifier: store.get("verifier", "") });
        store.del("verifier"); store.del("state");
        const to = store.get("back", ""); store.del("back");
        history.replaceState(null, "", location.pathname);
        if (to) { location.replace(new URL("p/" + to + "/", ROOT).href); return; }
        connected(true);
      } catch (e) { say("Couldn't connect: " + e.message, "Error"); }
    }
  }

  (document.body.dataset.page === "connect" ? connectPage : tapPage)();
})();
