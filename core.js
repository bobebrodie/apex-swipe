// Apex Swipe to Match: shared core (Nov 25 2026).
// Used by the Mac wall (inlined by build-mac.sh) and the phone page (bobebrodie.github.io/apex-swipe, publish.sh).
// Relay: ntfy.sh topic, every message AES-256-GCM encrypted. The key lives only in the QR link's #fragment,
// which browsers never send to any server, so the relay only ever sees ciphertext.
// Deck algorithm: nextCard(). Tests: node tests/swipe-test.js
(function (root) {
  var RELAY = 'https://ntfy.sh/';

  // ---------- crypto ----------
  function b64u(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), o = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
  function newSession() {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', r = rand(22), t = 'apx';
    for (var i = 0; i < r.length; i++) t += abc[r[i] % 36];
    return { topic: t, key: b64u(rand(32)) };
  }
  function importKey(k) { return crypto.subtle.importKey('raw', unb64u(k), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
  function seal(key, obj) {
    var iv = rand(12), data = new TextEncoder().encode(JSON.stringify(obj));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data).then(function (ct) {
      var c = new Uint8Array(ct), all = new Uint8Array(12 + c.length); all.set(iv); all.set(c, 12); return b64u(all); });
  }
  function open(key, txt) {
    var all = unb64u(txt);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12))
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  // ---------- relay ----------
  // Link(topic, key, onMsg): replays the session so far (ntfy keeps 12 h), then streams. Duplicate ids are dropped.
  function Link(topic, key, onMsg, onState) {
    var self = this, seen = {}, es = null, ck = null, q = [], busy = false, dead = false;
    importKey(key).then(function (k) { ck = k; connect(); flush(); });
    function connect() {
      if (dead) return; if (es) es.close();
      es = new EventSource(RELAY + topic + '/sse?since=all');
      es.onopen = function () { onState && onState(true); };
      es.onerror = function () { onState && onState(false); };
      es.addEventListener('message', function (ev) {
        var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.event !== 'message' || !d.message || seen[d.id]) return; seen[d.id] = 1;
        open(ck, d.message).then(function (m) { if (m && typeof m === 'object') onMsg(m, d.time || 0); }, function () {});
      });
    }
    function flush() {
      if (busy || !ck || !q.length) return; busy = true; var m = q[0];
      seal(ck, m).then(function (txt) { return fetch(RELAY + topic, { method: 'POST', body: txt }); })
        .then(function (r) { if (!r.ok) throw new Error(r.status); q.shift(); busy = false; flush(); })
        .catch(function () { busy = false; setTimeout(flush, 3000); });
    }
    self.send = function (m) { q.push(m); flush(); };
    self.reconnect = connect;
    self.close = function () { dead = true; if (es) es.close(); };
  }

  // ---------- session state ----------
  // items: {i,k:'movie'|'tv'|'comedy',t,y,p,g:[genre ids],gn,o,r,rt,pv,who}
  function State() { this.items = []; this.byI = {}; this.names = []; this.votes = {}; this.who = {}; this.seq = 0; this.matchOrder = []; this.seed = 1; }
  State.prototype.apply = function (m) {
    var s = this;
    if (m.ty === 'deck') {
      if (m.seed) s.seed = m.seed; if (m.names) s.names = m.names; if (m.cap != null) s.cap = m.cap;
      (m.items || []).forEach(function (it) { if (it && typeof it.i === 'number' && !s.byI[it.i]) { s.byI[it.i] = it; s.items.push(it); } });
      return 'deck';
    }
    if ((m.ty === 'sw' || m.ty === 'hi') && typeof m.d === 'string') {
      var v = s.votes[m.d] = s.votes[m.d] || {};
      if (m.nm) s.who[m.d] = String(m.nm).slice(0, 20);
      var hit = null;
      for (var k in (m.v || {})) {
        var i = +k; if (!s.byI[i] || v[i]) continue;
        v[i] = { y: m.v[k] ? 1 : 0, n: ++s.seq };
        if (v[i].y && s.matchOrder.indexOf(i) < 0 && s.yesCount(i) >= 2) { s.matchOrder.push(i); hit = i; }
      }
      return hit != null ? { match: hit } : 'sw';
    }
    if (m.ty === 'end') return 'end';
    return null;
  };
  State.prototype.voters = function () { return Object.keys(this.votes); };
  State.prototype.yesCount = function (i) { var n = 0; for (var d in this.votes) if (this.votes[d][i] && this.votes[d][i].y) n++; return n; };
  State.prototype.matches = function () { var s = this; return s.matchOrder.map(function (i) { return s.byI[i]; }); };
  State.prototype.swiped = function (d) { return Object.keys(this.votes[d] || {}).length; };

  // ---------- similarity ----------
  var TV2M = { 10759: 28, 10765: 878, 10768: 10752, 10762: 10751 };
  function gset(it) { var o = {}; (it.g || []).forEach(function (g) { o[TV2M[g] || g] = 1; }); if (it.k === 'comedy') o[35] = 1; return o; }
  function sim(a, b) {
    if (a === b) return 1;
    if (a.k === 'comedy' || b.k === 'comedy') {
      if (a.k === b.k) return 0.7 + (a.who && a.who === b.who ? 0.3 : 0);
      var other = a.k === 'comedy' ? b : a; return gset(other)[35] ? 0.35 : 0;
    }
    var A = gset(a), B = gset(b), inter = 0, uni = 0, k;
    for (k in A) { uni++; if (B[k]) inter++; } for (k in B) if (!A[k]) uni++;
    var y = Math.abs((+a.y || 0) - (+b.y || 0));
    return (uni ? inter / uni : 0) * 0.65 + (a.k === b.k ? 0.2 : 0) + (a.y && b.y && y <= 6 ? 0.15 : 0);
  }
  // same "random" number for an item on every phone in a session, so both start with the same shuffle
  function noise(seed, i) { var h = (seed ^ Math.imul(i + 1, 2654435761)) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

  // ---------- the deck algorithm ----------
  // 1) Matches first: a card your partner already said yes to comes next (oldest yes first), so a match lands fast.
  // 2) Then similar picks: everything else is scored by how close it is to what's been liked (a match counts most,
  //    then your partner's yeses, then yours), minus how close it is to the noes, minus a little for being like the
  //    card you just saw. A card your partner said no to can't match, so it sinks to the bottom.
  // 3) Random titles: a shared seeded shuffle breaks ties and orders the start, and every 5th card is a pure random pick
  //    so the deck keeps throwing in something different.
  function nextCard(s, me, lastI) {
    var mine = s.votes[me] || {}, partners = s.voters().filter(function (d) { return d !== me; });
    var left = s.items.filter(function (it) { return !mine[it.i]; });
    if (!left.length) return null;
    var pYes = [];
    left.forEach(function (it) { partners.forEach(function (d) { var v = s.votes[d][it.i]; if (v && v.y) pYes.push({ it: it, n: v.n }); }); });
    if (pYes.length) { pYes.sort(function (a, b) { return a.n - b.n; }); return pYes[0].it; }
    function pNo(it) { return partners.some(function (d) { var v = s.votes[d][it.i]; return v && !v.y; }); }
    var alive = left.filter(function (it) { return !pNo(it); }), pool = alive.length ? alive : left;
    var nMine = Object.keys(mine).length;
    if (nMine % 5 === 4) return pool.slice().sort(function (a, b) { return noise(s.seed, b.i) - noise(s.seed, a.i); })[0];
    var liked = [], noes = [];
    s.matchOrder.forEach(function (i) { liked.push([s.byI[i], 1.5]); });
    for (var d in s.votes) for (var k in s.votes[d]) {
      var v = s.votes[d][k], it = s.byI[k]; if (!it || s.matchOrder.indexOf(+k) >= 0) continue;
      if (v.y) liked.push([it, d === me ? 0.8 : 1.0]); else noes.push([it, d === me ? 0.6 : 0.3]);
    }
    var last = lastI != null ? s.byI[lastI] : null, best = null, bs = -1e9;
    pool.forEach(function (it) {
      var aff = 0, neg = 0;
      liked.forEach(function (l) { aff = Math.max(aff, l[1] * sim(it, l[0])); });
      noes.forEach(function (n) { neg = Math.max(neg, n[1] * sim(it, n[0])); });
      var sc = aff - neg + noise(s.seed, it.i) * 0.45 - (last ? 0.3 * sim(it, last) : 0);
      if (sc > bs) { bs = sc; best = it; }
    });
    return best;
  }

  // Results: matches first (in the order they happened), then "close calls" one of you liked,
  // ranked by how similar they are to the matches (or to everything liked, before any match).
  function ranked(s) {
    var m = s.matches(), mset = {}; s.matchOrder.forEach(function (i) { mset[i] = 1; });
    var ones = s.items.filter(function (it) { return !mset[it.i] && s.yesCount(it.i) === 1; });
    var anchor = m.length ? m : s.items.filter(function (it) { return s.yesCount(it.i) > 0; });
    var nobody = function (it) { return s.voters().some(function (d) { var v = s.votes[d][it.i]; return v && !v.y; }); };
    ones.forEach(function (it) { var a = 0; anchor.forEach(function (x) { if (x !== it) a = Math.max(a, sim(it, x)); }); it._a = a - (nobody(it) ? 0.5 : 0); });
    ones.sort(function (a, b) { return b._a - a._a; });
    return { matches: m, close: ones };
  }

  var api = { newSession: newSession, Link: Link, State: State, sim: sim, noise: noise, nextCard: nextCard, ranked: ranked, b64u: b64u, unb64u: unb64u, seal: seal, open: open, importKey: importKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ApexSwipe = api;
})(this);
