/*! LORPcade cloud saves.
 *
 * One tiny script shared by the home screen and every game (published at /arcade-assets/lorpcade-sync.js).
 * It copies a game's saved data to Firestore under a "sync code" and back, so the same progress follows a
 * player between devices. There is no login: the code is the key. See instruction.md for the Firebase setup.
 *
 * What gets synced for a game with folder name <slug> (every game on the site shares one localStorage):
 *     lorpcade:<slug>:<name>        e.g. lorpcade:lock_on:save      (<name>: letters, digits, _ and - only)
 *     lorpcade:hiscore:<slug>       the number the home screen's cabinet shows
 * so a game gets syncing just by saving under those keys and including this script. Nothing else is touched.
 *
 * Cloud layout (Firestore REST, no SDK):  saves/{CODE}/games/{slug} = { v, at, dev, data: { <name>: "<text>" } }
 * The native (Windows) build of Lock-On speaks exactly the same thing (src/sync.rs); keep the two in step.
 *
 * Rules of the road:
 *   - Nothing in here may ever throw into a game page: every public function catches its own errors.
 *   - Writes are conditional (Firestore's updateTime precondition), so a device never overwrites a cloud save
 *     it has not seen without noticing. A real conflict (both sides changed) keeps the newest, and the
 *     other one is parked in localStorage under lorpcade:backup:<slug>.
 */
(() => {
  "use strict";
  if (window.LorpSync) return;

  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || "";
  const KEY_CODE = "lorpcade:sync:code";
  const KEY_DEV = "lorpcade:sync:dev";
  const stKey = (slug) => "lorpcade:sync:s:" + slug;
  const bakKey = (slug) => "lorpcade:backup:" + slug;

  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 symbols: no 0 O 1 I
  const CODE_RE = /^[2-9A-HJ-NP-Z]{12}$/;
  const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
  const RESERVED = new Set(["sync", "backup", "hiscore", "profile"]); // folder names that would collide with our own keys
  const MAX_VALUE = 200000; // characters per saved value
  const MAX_KEYS = 16;
  const DEBOUNCE_MS = 2500; // wait for the game to stop saving, then push
  const MAX_WAIT_MS = 20000; // ...but never hold a change back longer than this
  const REQUEST_MS = 8000;
  const REMOTE_POLL_MS = 60000;

  // ---------------------------------------------------------------- storage (never throws)
  const store = () => { try { return window.localStorage; } catch (_) { return null; } };
  const nativeSet = Storage.prototype.setItem;
  const nativeDel = Storage.prototype.removeItem;
  const rawGet = (k) => { try { return store().getItem(k); } catch (_) { return null; } };
  const rawSet = (k, v) => { try { nativeSet.call(store(), k, v); return true; } catch (_) { return false; } };
  const rawDel = (k) => { try { nativeDel.call(store(), k); } catch (_) {} };

  // ---------------------------------------------------------------- config
  let cfg = null; // { project, key, base }
  function configure(c) {
    const ok = (s) => typeof s === "string" && s.trim() !== "" && !/^YOUR_/i.test(s.trim());
    if (!c || !ok(c.projectId) || !ok(c.apiKey)) return false;
    cfg = {
      project: c.projectId.trim(),
      key: c.apiKey.trim(),
      base: (typeof c.baseUrl === "string" && c.baseUrl.trim() ? c.baseUrl.trim() : "https://firestore.googleapis.com").replace(/\/+$/, ""),
    };
    emit();
    return true;
  }
  // sync-config.json sits next to this script. Missing, unreadable or still holding the YOUR_... placeholders = sync off.
  const ready = (async () => {
    try {
      const r = await fetch(new URL("sync-config.json", SCRIPT_URL || location.href).href, { cache: "no-cache" });
      if (!r.ok) return false;
      return configure(await r.json());
    } catch (_) { return false; }
  })();

  // ---------------------------------------------------------------- the sync code
  const normalizeCode = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const validCode = (s) => CODE_RE.test(normalizeCode(s));
  const formatCode = (c) => (c ? c.replace(/(.{4})(?=.)/g, "$1-") : "");
  function newCode() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b); // 256 is a multiple of 32, so every symbol is equally likely
    return Array.from(b, (x) => ALPHABET[x % 32]).join("");
  }
  function getCode() { const c = rawGet(KEY_CODE); return c && CODE_RE.test(c) ? c : ""; }
  function setCode(raw) {
    const c = normalizeCode(raw);
    if (!CODE_RE.test(c)) return false;
    if (getCode() !== c) { forgetStates(); rawSet(KEY_CODE, c); } // a different code starts from scratch
    info.phase = "idle"; info.error = "";
    emit();
    return true;
  }
  function clearCode() {
    rawDel(KEY_CODE);
    forgetStates();
    info.phase = "off"; info.error = "";
    emit();
  }
  function forgetStates() {
    const s = store(); if (!s) return;
    const drop = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith("lorpcade:sync:s:")) drop.push(k); }
    drop.forEach(rawDel);
  }
  function deviceId() {
    let d = rawGet(KEY_DEV);
    if (!d || !/^web-[0-9a-f]{8}$/.test(d)) {
      const b = new Uint8Array(4); crypto.getRandomValues(b);
      d = "web-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      rawSet(KEY_DEV, d);
    }
    return d;
  }

  // ---------------------------------------------------------------- which keys belong to which game
  function parseKey(k) {
    const m = /^lorpcade:([A-Za-z0-9][A-Za-z0-9_-]{0,39}):(.+)$/.exec(k);
    if (!m) return null;
    if (m[1] === "hiscore") return SLUG_RE.test(m[2]) && !RESERVED.has(m[2]) ? { slug: m[2], name: "hiscore" } : null;
    if (RESERVED.has(m[1]) || m[2] === "hiscore" || !NAME_RE.test(m[2])) return null;
    return { slug: m[1], name: m[2] };
  }
  const keyFor = (slug, name) => (name === "hiscore" ? "lorpcade:hiscore:" + slug : "lorpcade:" + slug + ":" + name);

  function readLocal(slug) {
    const out = {}, s = store();
    if (!s) return out;
    for (let i = 0; i < s.length && Object.keys(out).length < MAX_KEYS; i++) {
      const k = s.key(i), p = k && parseKey(k);
      if (!p || p.slug !== slug) continue;
      const v = rawGet(k);
      if (typeof v === "string" && v.length <= MAX_VALUE) out[p.name] = v;
    }
    return out;
  }
  function localSlugs() {
    const out = new Set(), s = store();
    if (!s) return out;
    for (let i = 0; i < s.length; i++) { const p = parseKey(s.key(i) || ""); if (p) out.add(p.slug); }
    return out;
  }
  // A short fingerprint of a set of keys: "has this changed since the last sync?" (never compared across devices)
  function sigOf(map) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    const mix = (str) => {
      for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
      h1 = Math.imul(h1 ^ 0x1f, 2654435761); h2 = Math.imul(h2 ^ 0x1f, 1597334677);
    };
    const names = Object.keys(map).sort();
    names.forEach((n) => { mix(n); mix(map[n]); });
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ":" + names.length;
  }
  const loadSt = (slug) => { try { const o = JSON.parse(rawGet(stKey(slug))); return o && typeof o === "object" ? o : {}; } catch (_) { return {}; } };
  const saveSt = (slug, o) => rawSet(stKey(slug), JSON.stringify(o));

  // A game can register a check for what comes out of the cloud (LorpSync.validators[slug] = (name, text) => bool),
  // so a damaged cloud copy is never allowed to replace a good local one.
  const validators = {};
  function validData(slug, data) {
    const names = Object.keys(data);
    if (names.length === 0 || names.length > MAX_KEYS) return false;
    const check = validators[slug];
    return names.every((n) => NAME_RE.test(n) && typeof data[n] === "string" && data[n].length <= MAX_VALUE && (!check || check(n, data[n]) !== false));
  }

  // ---------------------------------------------------------------- status
  const info = { phase: getCode() ? "idle" : "off", error: "", lastOk: 0, applied: 0, busy: 0 };
  const listeners = new Set();
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  function emit() { listeners.forEach((f) => { try { f(info); } catch (_) {} }); }
  function label() {
    if (!cfg) return "";
    if (!getCode()) return "OFF";
    if (info.busy > 0) return "SYNCING";
    return { offline: "OFFLINE", error: "ERROR" }[info.phase] || "ON";
  }

  // ---------------------------------------------------------------- Firestore REST
  const docPath = (code, slug) => "/v1/projects/" + encodeURIComponent(cfg.project) + "/databases/(default)/documents/saves/" + code + "/games/" + encodeURIComponent(slug);
  const listPath = (code) => "/v1/projects/" + encodeURIComponent(cfg.project) + "/databases/(default)/documents/saves/" + code + "/games";
  const enc = encodeURIComponent;

  async function http(method, url, body, o = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_MS);
    if (o.signal) o.signal.addEventListener("abort", () => ctl.abort());
    try {
      const r = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        keepalive: !!o.keepalive,
        cache: "no-store",
      });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) {}
      return { status: r.status, json };
    } finally { clearTimeout(timer); }
  }
  function apiError(r) {
    const e = (r.json && r.json.error) || {};
    let msg = e.message || "HTTP " + r.status;
    if (r.status === 403) msg = "Refused by Firestore. Check the security rules and that the API key allows Cloud Firestore.";
    else if (r.status === 400 && /API key/i.test(msg)) msg = "The Firebase API key was rejected. Check sync-config.json.";
    else if (r.status === 404) msg = "Firestore database not found. Check the project id in sync-config.json.";
    const err = new Error(msg); err.status = r.status; err.code = e.status || ""; return err;
  }
  const isConflict = (r) => {
    const e = (r.json && r.json.error) || {};
    if (e.status === "NOT_FOUND") return !/database|project/i.test(e.message || ""); // the document vanished under us (a missing database is a setup error)
    return r.status === 409 || /^(ABORTED|ALREADY_EXISTS|FAILED_PRECONDITION)$/.test(e.status || "");
  };

  function fromDoc(slug, d) {
    const f = d.fields || {}, num = (v) => (v && v.integerValue != null ? Number(v.integerValue) : 0);
    const data = {}, m = (f.data && f.data.mapValue && f.data.mapValue.fields) || {};
    for (const [k, v] of Object.entries(m)) if (v && typeof v.stringValue === "string") data[k] = v.stringValue;
    const doc = { updateTime: d.updateTime || "", at: num(f.at), dev: (f.dev && f.dev.stringValue) || "", data };
    doc.bad = !validData(slug, data);
    return doc;
  }
  function toBody(data, at) {
    const fields = {};
    for (const [k, v] of Object.entries(data)) fields[k] = { stringValue: v };
    return { fields: { v: { integerValue: "1" }, at: { integerValue: String(at) }, dev: { stringValue: deviceId() }, data: { mapValue: { fields } } } };
  }
  async function getDoc(code, slug, o) {
    const r = await http("GET", cfg.base + docPath(code, slug) + "?key=" + enc(cfg.key), null, o);
    if (r.status === 404) return null; // no save in the cloud yet (also what "database missing" looks like; a write will say so)
    if (r.status !== 200) throw apiError(r);
    return fromDoc(slug, r.json);
  }
  async function listDocs(code, o) {
    const out = new Map();
    let token = "";
    for (let page = 0; page < 5; page++) {
      const r = await http("GET", cfg.base + listPath(code) + "?pageSize=100&key=" + enc(cfg.key) + (token ? "&pageToken=" + enc(token) : ""), null, o);
      if (r.status === 404) break;
      if (r.status !== 200) throw apiError(r);
      for (const d of (r.json && r.json.documents) || []) {
        const slug = decodeURIComponent(String(d.name || "").split("/").pop());
        if (SLUG_RE.test(slug) && !RESERVED.has(slug)) out.set(slug, fromDoc(slug, d));
      }
      token = (r.json && r.json.nextPageToken) || "";
      if (!token) break;
    }
    return out;
  }
  // Conditional write: only if the cloud copy is still the one we last saw (or still absent).
  async function put(code, slug, local, st, precondition, o) {
    const at = st.at || Date.now();
    const q = ["key=" + enc(cfg.key)].concat(["v", "at", "dev", "data"].map((f) => "updateMask.fieldPaths=" + f))
      .concat(precondition ? "currentDocument.updateTime=" + enc(precondition) : "currentDocument.exists=false").join("&");
    const r = await http("PATCH", cfg.base + docPath(code, slug) + "?" + q, toBody(local, at), o);
    if (r.status === 200 && r.json) {
      saveSt(slug, { base: r.json.updateTime, sig: sigOf(local), at });
      return { ok: true, result: { slug, outcome: "uploaded" } };
    }
    if (isConflict(r)) return { ok: false };
    throw apiError(r);
  }

  // ---------------------------------------------------------------- reconcile one game
  function backup(slug, from, data, at) { rawSet(bakKey(slug), JSON.stringify({ at: at || Date.now(), from, data })); }
  function adopt(slug, cloud, local, outcome) {
    if (Object.keys(local).length) backup(slug, "local", local);
    for (const [n, v] of Object.entries(cloud.data)) rawSet(keyFor(slug, n), v);
    saveSt(slug, { base: cloud.updateTime, sig: sigOf(readLocal(slug)), at: cloud.at });
    info.applied++;
    return { slug, outcome };
  }
  const prettyName = (slug) => slug.replace(/[_-]+/g, " ").toUpperCase();
  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (!ms) return "at an unknown time";
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  function askUser(slug, cloud, local) {
    const hi = (m) => (m.hiscore != null ? "best score " + m.hiscore : "no score yet");
    return confirm(
      prettyName(slug) + ": this device and the cloud both have saved progress, and they differ.\n\n" +
      "Cloud: saved " + ago(cloud.at) + ", " + hi(cloud.data) + ".\n" +
      "This device: " + hi(local) + ".\n\n" +
      "OK = use the CLOUD save.\nCancel = keep THIS DEVICE's save (it replaces the cloud one).\n\n" +
      "The one you don't pick is kept as a backup on this device."
    ) ? "cloud" : "local";
  }

  // opts: apply (false: never write cloud data into localStorage; used while a game is running), pushFirst,
  // interactive (may ask the player), signal, keepalive. cloudHint: undefined = fetch, null = known absent, doc = prefetched.
  async function reconcile(slug, opts, cloudHint) {
    const code = getCode();
    if (!cfg || !code || !SLUG_RE.test(slug) || RESERVED.has(slug)) return { slug, outcome: "off" };
    const o = { signal: opts.signal, keepalive: opts.keepalive };
    const apply = opts.apply !== false;
    const gone = () => { if (opts.signal && opts.signal.aborted) throw new DOMException("sync timed out", "AbortError"); };
    for (let attempt = 0; attempt < 3; attempt++) {
      const st = loadSt(slug);
      const local = readLocal(slug), hasLocal = Object.keys(local).length > 0;
      const lsig = sigOf(local), localChanged = hasLocal && lsig !== st.sig;
      let cloud = attempt === 0 ? cloudHint : undefined;

      if (cloud === undefined && opts.pushFirst && st.base && localChanged) { // the common case after a save: one request
        const w = await put(code, slug, local, st, st.base, o);
        if (w.ok) return w.result;
      }
      if (cloud === undefined) cloud = await getDoc(code, slug, o);
      gone();

      if (!cloud || cloud.bad) { // nothing usable up there: our copy becomes the cloud copy
        if (!hasLocal) return { slug, outcome: "none" };
        const w = await put(code, slug, local, st, cloud ? cloud.updateTime : null, o);
        if (w.ok) return w.result;
        continue;
      }
      if (!hasLocal) { if (!apply) return { slug, outcome: "none" }; return adopt(slug, cloud, local, "downloaded"); }
      if (sigOf(cloud.data) === lsig) { saveSt(slug, { base: cloud.updateTime, sig: lsig, at: cloud.at }); return { slug, outcome: "none" }; }

      const cloudChanged = cloud.updateTime !== st.base;
      if (!cloudChanged && !localChanged) return { slug, outcome: "none" };
      if (cloudChanged && !localChanged) { if (!apply) return { slug, outcome: "newer-in-cloud" }; return adopt(slug, cloud, local, "downloaded"); }
      if (!cloudChanged && localChanged) {
        const w = await put(code, slug, local, st, st.base, o);
        if (w.ok) return w.result;
        continue;
      }

      // both sides changed since they last agreed
      let pick;
      if (!apply) { // a running game: its own state is the truth, but never bury a cloud save this device has not seen
        if (!st.base) return { slug, outcome: "newer-in-cloud" };
        pick = "local";
      } else if (!st.base) pick = opts.interactive ? await (opts.ask || askUser)(slug, cloud, local) : "cloud"; // first meeting of this device and this cloud
      else pick = (st.at || 0) > cloud.at ? "local" : "cloud"; // newest save wins
      if (pick === "cloud") return adopt(slug, cloud, local, "kept-cloud");
      backup(slug, "cloud", cloud.data, cloud.at);
      const w = await put(code, slug, local, st, cloud.updateTime, o);
      if (w.ok) return { slug, outcome: "kept-local" };
    }
    return { slug, outcome: "busy" }; // the cloud copy kept changing under us; the next sync will settle it
  }

  // One request at a time per game, and never a rejected promise.
  const chains = new Map();
  function serial(slug, fn) {
    const prev = chains.get(slug) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(slug, run.catch(() => {}));
    return run;
  }
  function begin() { info.busy++; emit(); }
  function finish(err) {
    info.busy = Math.max(0, info.busy - 1);
    if (!getCode()) info.phase = "off";
    else if (err) {
      const offline = err.name === "AbortError" || err.name === "TypeError" || navigator.onLine === false; // fetch() rejects with a TypeError when it cannot connect
      info.phase = offline ? "offline" : "error";
      info.error = offline ? "" : err.message || "Sync failed.";
      if (!offline) console.warn("[LorpSync]", err);
    } else if (info.busy === 0) { info.phase = "ok"; info.error = ""; info.lastOk = Date.now(); }
    emit();
  }

  function syncGame(slug, opts = {}) {
    return serial(slug, async () => {
      await ready;
      if (!cfg || !getCode()) return { slug, outcome: "off" };
      const ctl = new AbortController();
      const timer = opts.timeout ? setTimeout(() => ctl.abort(), opts.timeout) : 0;
      begin();
      try {
        const res = await reconcile(slug, Object.assign({}, opts, { signal: ctl.signal }));
        finish(null);
        return res;
      } catch (e) {
        finish(e);
        return { slug, outcome: "error", error: e && e.message ? e.message : "Sync failed." };
      } finally { clearTimeout(timer); }
    });
  }

  // Everything this code has in the cloud plus everything this device has locally, one list request in all.
  async function syncAll(opts = {}) {
    await ready;
    if (!cfg || !getCode()) return { ok: false, results: [] };
    begin();
    try {
      const code = getCode();
      const cloud = await listDocs(code, opts);
      const slugs = new Set([...cloud.keys(), ...localSlugs(), ...(opts.slugs || [])].filter((s) => SLUG_RE.test(s) && !RESERVED.has(s)));
      const results = [];
      for (const slug of slugs) {
        results.push(await serial(slug, async () => {
          try { return await reconcile(slug, opts, cloud.get(slug) || null); }
          catch (e) { return { slug, outcome: "error", error: e && e.message ? e.message : "Sync failed." }; }
        }));
      }
      results.push(await syncProfile(opts));
      const bad = results.find((r) => r.outcome === "error");
      finish(bad ? new Error(bad.error) : null);
      return { ok: !bad, results };
    } catch (e) {
      finish(e);
      return { ok: false, results: [], error: e && e.message ? e.message : "Sync failed." };
    }
  }

  // ---------------------------------------------------------------- the player profile (name + colour)
  // One small profile per player, shared by every game: localStorage "lorpcade:profile" holds JSON
  //   { "multiplayer_name": "ACE", "mech_colour": 5, "updated_at": 1700000000000, ...keys other programs added }
  // and, with a sync code, the same two values live in the cloud at saves/{CODE}/games/profile = { v, at, dev,
  // data: { name, colour } } (`at` = updated_at). The newest change wins, on every platform (the Windows builds
  // do the same in src/sync/profile_sync.rs). "profile" is a reserved game name, so it never collides with a save.
  const PROFILE_SLUG = "profile";
  const KEY_PROFILE = "lorpcade:profile";
  const cleanName = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9 _-]/g, "").trim().slice(0, 12);
  const cleanColour = (c) => { c = Number(c); return Number.isInteger(c) && c >= 0 && c < 64 ? c : -1; };
  function readProfile() {
    try { const o = JSON.parse(rawGet(KEY_PROFILE)); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (_) { return {}; }
  }
  function getProfile() {
    const p = readProfile();
    return { name: cleanName(p.multiplayer_name) || "PILOT", colour: cleanColour(p.mech_colour) >= 0 ? Number(p.mech_colour) : 5, updatedAt: Number(p.updated_at) || 0 };
  }
  // Change the name and/or colour (the home screen's editor); the other keys in the profile are kept.
  function setProfile(change) {
    const p = readProfile();
    if (change && change.name != null) p.multiplayer_name = cleanName(change.name) || "PILOT";
    if (change && cleanColour(change.colour) >= 0) p.mech_colour = Number(change.colour);
    p.updated_at = Date.now();
    rawSet(KEY_PROFILE, JSON.stringify(p));
    scheduleProfilePush();
    return getProfile();
  }
  let profileTimer = 0;
  function scheduleProfilePush() {
    if (!cfg || !getCode()) return;
    clearTimeout(profileTimer);
    profileTimer = setTimeout(() => syncProfile({ keepalive: false }), 1500);
  }
  function syncProfile(opts = {}) {
    return serial(PROFILE_SLUG, async () => {
      await ready;
      const code = getCode();
      if (!cfg || !code) return { slug: PROFILE_SLUG, outcome: "off" };
      begin();
      try {
        const loc = readProfile(), lat = Number(loc.updated_at) || 0;
        const r = await http("GET", cfg.base + docPath(code, PROFILE_SLUG) + "?key=" + enc(cfg.key), null, opts);
        let cloud = null;
        if (r.status === 200) {
          const d = fromDoc(PROFILE_SLUG, r.json), n = cleanName(d.data.name), c = cleanColour(d.data.colour);
          if (n && c >= 0) cloud = { updateTime: d.updateTime, at: d.at, name: n, colour: c };
        } else if (r.status !== 404) throw apiError(r);
        let outcome = "none";
        if (cloud && cloud.at > lat) {
          rawSet(KEY_PROFILE, JSON.stringify(Object.assign({}, loc, { multiplayer_name: cloud.name, mech_colour: cloud.colour, updated_at: cloud.at })));
          outcome = "downloaded";
          try { window.dispatchEvent(new CustomEvent("lorpcade:profile")); } catch (_) {}
        } else if (lat > 0 && (!cloud || lat > cloud.at)) {
          const mine = getProfile();
          const q = ["key=" + enc(cfg.key)].concat(["v", "at", "dev", "data"].map((f) => "updateMask.fieldPaths=" + f))
            .concat(cloud ? "currentDocument.updateTime=" + enc(cloud.updateTime) : "currentDocument.exists=false").join("&");
          const w = await http("PATCH", cfg.base + docPath(code, PROFILE_SLUG) + "?" + q, toBody({ name: mine.name, colour: String(mine.colour) }, lat), opts);
          if (w.status === 200) outcome = "uploaded";
          else if (!isConflict(w)) throw apiError(w); // a conflict means another device wrote first: the next sync settles it
        }
        finish(null);
        return { slug: PROFILE_SLUG, outcome };
      } catch (e) {
        finish(e);
        return { slug: PROFILE_SLUG, outcome: "error", error: e && e.message ? e.message : "Sync failed." };
      }
    });
  }

  // ---------------------------------------------------------------- automatic syncing
  const watched = new Map(); // slug -> { timer, first, onRemote, polled }
  let hooked = false;
  function touch(slug) { const st = loadSt(slug); st.at = Date.now(); saveSt(slug, st); }
  function onLocalWrite(key) {
    if (key === KEY_PROFILE) { scheduleProfilePush(); return; }
    const p = parseKey(key), w = p && watched.get(p.slug);
    if (!w || !cfg || !getCode()) return;
    touch(p.slug);
    const now = Date.now();
    if (!w.first) w.first = now;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => push(p.slug, false), Math.max(0, Math.min(DEBOUNCE_MS, w.first + MAX_WAIT_MS - now)));
  }
  function push(slug, keepalive) {
    const w = watched.get(slug);
    if (w) { clearTimeout(w.timer); w.timer = 0; w.first = 0; }
    return syncGame(slug, { pushFirst: true, apply: false, keepalive });
  }
  const isDirty = (slug) => { const l = readLocal(slug), st = loadSt(slug); return Object.keys(l).length > 0 && sigOf(l) !== st.sig; };
  function flush() { // page hidden or closing: send whatever is waiting
    if (!cfg || !getCode()) return;
    watched.forEach((w, slug) => { if (w.timer || isDirty(slug)) push(slug, true); });
  }
  async function checkRemote(slug) {
    try {
      const code = getCode();
      if (!cfg || !code) return false;
      const cloud = await getDoc(code, slug, {});
      return !!cloud && !cloud.bad && cloud.updateTime !== loadSt(slug).base && sigOf(cloud.data) !== sigOf(readLocal(slug));
    } catch (_) { return false; }
  }
  function pollRemote() {
    watched.forEach(async (w, slug) => {
      if (!w.onRemote || w.told || document.hidden || Date.now() - w.polled < 15000) return;
      w.polled = Date.now();
      if (await checkRemote(slug)) { w.told = true; try { w.onRemote(slug); } catch (_) {} }
    });
  }
  function hook() {
    if (hooked) return;
    hooked = true;
    Storage.prototype.setItem = function (k, v) {
      nativeSet.call(this, k, v); // same behaviour as before (including a quota error reaching the caller)
      try { if (this === window.localStorage) onLocalWrite(String(k)); } catch (_) {}
    };
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); else pollRemote(); });
    addEventListener("pagehide", flush);
    addEventListener("focus", pollRemote);
    setInterval(pollRemote, REMOTE_POLL_MS);
  }
  // A game page calls this once: its saves are pushed shortly after the game writes them, and onRemote(slug) fires
  // (once) if the cloud copy changes on another device while the game is open.
  function watch(slug, opts = {}) {
    if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return;
    const w = watched.get(slug) || { timer: 0, first: 0, polled: 0, told: false };
    if (opts.onRemote) w.onRemote = opts.onRemote;
    watched.set(slug, w);
    hook();
  }
  // The home screen: sync everything now, then again whenever the page comes back into view.
  function autoSync(opts = {}) {
    let last = 0;
    const go = async (force) => {
      if (document.hidden || (!force && Date.now() - last < 15000)) return;
      last = Date.now();
      const slugs = opts.slugs || [];
      slugs.forEach((s) => watch(s));
      const r = await syncAll({ slugs });
      if (opts.onSynced) { try { opts.onSynced(r); } catch (_) {} }
    };
    hook();
    document.addEventListener("visibilitychange", () => go(false));
    addEventListener("focus", () => go(false));
    addEventListener("pageshow", () => go(false));
    addEventListener("online", () => go(true));
    setInterval(() => go(false), 90000);
    addEventListener("storage", (e) => { if (e.key && parseKey(e.key) && opts.onSynced) { try { opts.onSynced(null); } catch (_) {} } });
    return go(true);
  }

  function restoreBackup(slug) { // console helper: LorpSync.restoreBackup("lock_on")
    try {
      const b = JSON.parse(rawGet(bakKey(slug)));
      Object.entries(b.data).forEach(([n, v]) => rawSet(keyFor(slug, n), v));
      touch(slug);
      return true;
    } catch (_) { return false; }
  }

  // ---------------------------------------------------------------- the setup dialog
  const CSS = `
.lsync{max-width:min(92vw,460px);width:100%;max-height:92vh;overflow:auto;box-sizing:border-box;padding:18px 20px;border:3px solid #ff2e97;border-radius:0;background:#170a3c;color:#f3e9ff;font:15px/1.45 ui-monospace,"Courier New",monospace;box-shadow:0 0 30px rgba(255,46,151,.5)}
.lsync::backdrop{background:rgba(5,1,15,.8)}
.lsync h2{margin:0 0 10px;font:13px/1.4 "Press Start 2P",ui-monospace,monospace;color:#2de2ff;letter-spacing:.04em}
.lsync p{margin:8px 0}.lsync small{color:#b4a6dc}
.lsync .code{display:block;margin:12px 0;padding:10px;text-align:center;background:#05010f;color:#ffe14d;font:700 22px/1.2 ui-monospace,"Courier New",monospace;letter-spacing:.12em;user-select:all;-webkit-user-select:all}
.lsync .row{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0}
.lsync button,.lsync input{font:inherit;color:#f3e9ff;background:#241058;border:2px solid #7a6ac0;border-radius:0;padding:8px 12px}
.lsync button{cursor:pointer;text-transform:uppercase;letter-spacing:.05em}.lsync button:hover,.lsync button:focus-visible{border-color:#ffe14d;outline:none}
.lsync button.go{background:#ff2e97;border-color:#ff2e97;color:#12002a;font-weight:700}
.lsync button[disabled]{opacity:.5;cursor:default}
.lsync input{flex:1;min-width:0;text-transform:uppercase;letter-spacing:.1em}
.lsync .note{min-height:1.4em;color:#ffe14d}.lsync .bad{color:#ff8a8a}
`;
  function injectStyle() {
    if (document.getElementById("lsync-style")) return;
    const s = document.createElement("style"); s.id = "lsync-style"; s.textContent = CSS; document.head.appendChild(s);
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function summarize(r) {
    if (!r || !r.results) return { text: (r && r.error) || "Could not reach the cloud.", bad: true };
    const names = (...o) => r.results.filter((x) => o.includes(x.outcome)).map((x) => prettyName(x.slug)).join(", ");
    const down = names("downloaded", "kept-cloud"), up = names("uploaded", "kept-local"), err = r.results.find((x) => x.outcome === "error");
    const parts = [];
    if (down) parts.push("Loaded from the cloud: " + down + ".");
    if (up) parts.push("Saved to the cloud: " + up + ".");
    if (!parts.length && !err) parts.push("Everything is up to date.");
    if (err) parts.push(err.error);
    return { text: parts.join(" "), bad: !!err };
  }

  // opts: onApplied() - called when the dialog closes after cloud data replaced this device's save (a game page
  // reloads itself then, because the running game still holds the old one); slugs - games to include.
  function openDialog(opts = {}) {
    try {
      injectStyle();
      const dlg = document.createElement("dialog");
      dlg.className = "lsync";
      dlg.setAttribute("aria-label", "Cloud save");
      document.body.appendChild(dlg);
      const applied0 = info.applied;
      let note = "", bad = false, busy = false, revealed = true;

      const render = () => {
        const code = getCode();
        let body;
        if (!cfg) {
          body = `<p>Cloud save is not set up on this site yet.</p><p><small>The site owner needs to add the Firebase details to sync-config.json (see instruction.md).</small></p>`;
        } else if (!code) {
          body = `<p>Keep your progress in the cloud and play on any device. No account: you get a code, and anything that has the code shares the same saves.</p>
            <div class="row"><button class="go" data-act="new"${busy ? " disabled" : ""}>Create my code</button></div>
            <p><small>Already have a code from another device?</small></p>
            <div class="row"><input id="lsync-in" placeholder="XXXX-XXXX-XXXX" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Sync code"><button data-act="link"${busy ? " disabled" : ""}>Link</button></div>`;
        } else {
          const when = info.lastOk ? "Last synced " + ago(info.lastOk) + "." : "Not synced yet this visit.";
          body = `<p>This device is linked. Enter the same code on your other devices (here, or in the game's SYNC screen).</p>
            <span class="code" id="lsync-code">${revealed ? esc(formatCode(code)) : "XXXX-XXXX-XXXX"}</span>
            <p><small>${esc(busy ? "Syncing..." : info.phase === "offline" ? "Offline. Changes are kept and sent when you are back online." : info.phase === "error" ? "Problem: " + info.error : when)}</small></p>
            <div class="row"><button data-act="copy">Copy</button><button data-act="show">${revealed ? "Hide" : "Show"}</button><button class="go" data-act="sync"${busy ? " disabled" : ""}>Sync now</button></div>
            <p><small>Anyone who has this code can read and replace your saves, so keep it to yourself.</small></p>
            <div class="row"><button data-act="unlink">Unlink this device</button></div>`;
        }
        dlg.innerHTML = `<h2>CLOUD SAVE</h2>${body}<p class="note${bad ? " bad" : ""}" role="status">${esc(note)}</p><div class="row"><button data-act="close">Close</button></div>`;
      };
      const run = async () => {
        busy = true; note = ""; bad = false; render();
        const r = await syncAll({ interactive: true, slugs: opts.slugs });
        busy = false;
        const s = summarize(r); note = s.text; bad = s.bad;
        render();
      };
      dlg.addEventListener("click", async (e) => {
        const act = e.target && e.target.dataset && e.target.dataset.act;
        if (!act) return;
        e.stopPropagation();
        if (act === "close") { if (typeof dlg.close === "function") dlg.close(); else { dlg.removeAttribute("open"); dlg.dispatchEvent(new Event("close")); } }
        else if (act === "new") { setCode(newCode()); await run(); }
        else if (act === "link") {
          const v = (dlg.querySelector("#lsync-in") || {}).value || "";
          if (!setCode(v)) { note = "That is not a valid code. Codes have 12 letters and numbers (no 0, O, 1 or I)."; bad = true; render(); }
          else await run();
        } else if (act === "sync") await run();
        else if (act === "show") { revealed = !revealed; render(); }
        else if (act === "copy") {
          try { await navigator.clipboard.writeText(formatCode(getCode())); note = "Code copied."; } catch (_) { note = "Select the code and copy it by hand."; }
          bad = false; render();
        } else if (act === "unlink") {
          if (confirm("Unlink this device? Your saves stay on this device and in the cloud; they just stop syncing until you enter a code again.")) { clearCode(); note = "Unlinked."; bad = false; render(); }
        }
      });
      dlg.addEventListener("click", (e) => e.stopPropagation());
      dlg.addEventListener("close", () => { dlg.remove(); if (info.applied > applied0 && opts.onApplied) { try { opts.onApplied(); } catch (_) {} } });
      render();
      ready.then(render); // the config may still be loading when the dialog is opened right at page start
      if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    } catch (e) { console.warn("[LorpSync] dialog failed", e); }
  }

  window.LorpSync = {
    ready, configure, get enabled() { return !!cfg; },
    getCode, setCode, newCode, clearCode, validCode, formatCode, normalizeCode,
    info, on, label, validators,
    syncGame, syncAll, watch, autoSync, flush, checkRemote,
    profile: { get: getProfile, set: setProfile, sync: syncProfile },
    openDialog, restoreBackup,
  };
})();
