// IntPhys 2 위반 시점 라벨링.
// 프레임 k 는 clips/ 에서 pts = k / fps (tools/build_site.py 참고) 이라 currentTime = (k + 0.5) / fps 로 이동하고,
// 실제로 화면에 나온 프레임은 requestVideoFrameCallback 의 mediaTime 으로 읽는다.
(() => {
  'use strict';

  const M = window.MANIFEST;
  if (!M) {
    document.body.innerHTML = '<p style="padding:24px">data/manifest.js 가 없습니다. <code>python tools/build_site.py</code> 를 먼저 실행하세요.</p>';
    return;
  }
  const FPS = M.fps;
  const KEY = 'intphys2-vlabel-v1';
  const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const STRIP_R = 3;
  const RANGE_PAD = 45;
  const SPEEDS = [0.1, 0.25, 0.5, 1];
  const SYNC_URL = (window.SYNC_URL || '').trim();

  const COND = {
    permanence: { ko: '영속성', hint: '물체가 저절로 사라지거나 나타납니다. 사라지기 (나타나기) 시작하는 첫 프레임이 시작.' },
    immutability: { ko: '불변성', hint: '물체의 모양 · 색 · 크기가 저절로 바뀝니다. 바뀌기 시작하는 첫 프레임이 시작.' },
    continuity: { ko: '연속성', hint: '물체가 이어진 경로 없이 순간이동합니다. 순간이동한 첫 프레임이 시작 (보통 끝 = 시작).' },
    solidity: { ko: '고체성', hint: '물체가 다른 물체를 통과합니다. 겹치며 통과하기 시작하는 첫 프레임이 시작.' },
  };
  const COND_ORDER = Object.keys(COND);

  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  const stripVideo = $('#stripVideo');
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
    },
  };

  const S = {
    who: null,
    list: [],          // 이 작업자의 영상 (정렬됨)
    idx: 0,
    labels: {},        // id → { s, e, occ, nf, note, t }
    meta: { exportedAt: null, changed: [] },
    filter: 'all',
    cond: 'all',
    shown: 0,          // 화면에 실제로 나온 프레임
    target: null,      // 이동 요청 중인 프레임
    frameSeq: 0,
    seqAtSeek: 0,
    rangeStop: null,
    saveFailed: false,
  };

  const cur = () => S.list[S.idx];
  const frameNow = () => (S.target ?? S.shown);
  const labelOf = (v) => S.labels[v.id] || { s: null, e: null, occ: false, nf: false, note: '' };

  function status(l) {
    if (!l) return 'todo';
    if (l.nf) return 'nf';
    if (l.s != null && l.e != null && l.s <= l.e) return 'done';
    if (l.s != null || l.e != null || l.occ || (l.note && l.note.trim())) return 'partial';
    return 'todo';
  }

  // ---------------------------------------------------------------- 작업자

  function initWho() {
    const sel = $('#who');
    const grid = $('#pickerGrid');
    for (const a of M.annotators) {
      const vs = M.videos.filter((v) => v.part === a);
      sel.add(new Option(`${a} · ${vs.length}개`, a));
      const by = COND_ORDER.map((c) => `${COND[c].ko} ${vs.filter((v) => v.cond === c).length}`).join(' · ');
      const b = document.createElement('button');
      b.innerHTML = `<b>${a}</b><span>${vs.length}개 · ${by}</span>`;
      b.addEventListener('click', () => setWho(a));
      grid.append(b);
    }
    sel.addEventListener('change', () => setWho(sel.value));

    const fromUrl = new URLSearchParams(location.search).get('a');
    const who = M.annotators.includes(fromUrl) ? fromUrl : store.get(`${KEY}:who`, null);
    if (M.annotators.includes(who)) setWho(who);
    else $('#picker').hidden = false;
  }

  function setWho(a) {
    S.who = a;
    store.set(`${KEY}:who`, a);
    $('#who').value = a;
    $('#picker').hidden = true;
    try {
      const u = new URL(location.href);
      u.searchParams.set('a', a);
      history.replaceState(null, '', u);
    } catch { /* file:// 등 */ }

    S.labels = store.get(`${KEY}:labels:${a}`, {});
    S.meta = store.get(`${KEY}:meta:${a}`, { exportedAt: null, changed: [] });
    sync.outbox = new Set(store.get(`${KEY}:outbox:${a}`, []));
    sync.ok = null;
    S.list = M.videos.filter((v) => v.part === a).sort((x, y) =>
      COND_ORDER.indexOf(x.cond) - COND_ORDER.indexOf(y.cond) ||
      x.game.localeCompare(y.game) ||
      sceneKey(x.scene) - sceneKey(y.scene) ||
      x.pair - y.pair);

    const saved = store.get(`${KEY}:idx:${a}`, null);
    const firstTodo = S.list.findIndex((v) => status(S.labels[v.id]) === 'todo');
    load(saved != null && saved < S.list.length ? saved : Math.max(0, firstTodo));
    renderSaveState();
    pull();
  }

  function sceneKey(s) {
    const [h, t] = String(s).split('_');
    return Number(h) * 100 + (t == null ? 0 : Number(t) + 1);
  }

  // ---------------------------------------------------------------- 저장

  function update(patch) {
    const v = cur();
    const l = Object.assign({}, labelOf(v), patch, { t: new Date().toISOString() });
    S.labels[v.id] = l;
    if (!S.meta.changed.includes(v.id)) S.meta.changed.push(v.id);
    persist();
    queueSync(v.id);
    renderForm();
    renderMarkers();
    renderStripMarks();
    renderList();
    renderProgress();
  }

  function persist() {
    const ok = store.set(`${KEY}:labels:${S.who}`, S.labels) && store.set(`${KEY}:meta:${S.who}`, S.meta);
    S.saveFailed = !ok;
    renderSaveState();
  }

  function renderSaveState() {
    const el = $('#saveState');
    const n = S.meta.changed.length;
    el.className = 'save-state';
    el.title = '';
    if (S.saveFailed) {
      el.textContent = '브라우저 저장 실패 · 바로 CSV 내보내기 하세요';
      el.classList.add('error');
    } else if (SYNC_URL) {
      const q = sync.outbox.size;
      if (sync.ok === false) {
        el.textContent = `시트 연결 안 됨 · ${q}개 대기`;
        el.title = '이 브라우저에는 저장돼 있고, 연결되면 자동으로 다시 보냅니다.';
        el.classList.add('pending');
      } else if (q || sync.inflight) {
        el.textContent = `시트에 저장 중 · ${q}개`;
        el.classList.add('pending');
      } else {
        el.textContent = sync.ok ? '시트에 저장됨' : '시트 확인 중…';
      }
    } else if (n) {
      el.textContent = `자동 저장됨 · 내보내지 않은 변경 ${n}개`;
      el.classList.add('pending');
    } else {
      el.textContent = S.meta.exportedAt ? `내보냄 ${fmtTime(S.meta.exportedAt)}` : '자동 저장됨';
    }
  }

  const fmtTime = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // ---------------------------------------------------------------- 시트 동기화
  // SYNC_URL 은 tools/sheet_sync.gs 를 배포한 웹 앱 (data/config.js). 비어 있으면 브라우저 저장 + CSV 만 쓴다.
  // 브라우저 저장이 먼저고, 바뀐 영상은 outbox 에 쌓았다가 시트로 보낸다. 같은 영상은 t (저장 시각) 가 늦은 쪽이 이긴다.

  const sync = { outbox: new Set(), inflight: false, ok: null, timer: 0, delay: 0, pullTimer: 0, pulledAt: 0 };

  const wire = (id) => {
    const l = S.labels[id];
    return { file: id, annotator: S.who, s: l.s ?? null, e: l.e ?? null, note: l.note || '', occ: !!l.occ, nf: !!l.nf, t: l.t };
  };

  const saveOutbox = () => store.set(`${KEY}:outbox:${S.who}`, [...sync.outbox]);

  function queueSync(id) {
    if (!SYNC_URL) return;
    sync.outbox.add(id);
    saveOutbox();
    scheduleFlush(1200);
  }

  function scheduleFlush(ms) {
    clearTimeout(sync.timer);
    sync.timer = setTimeout(flush, ms);
  }

  async function flush() {
    if (!SYNC_URL || sync.inflight || !sync.outbox.size) return;
    const who = S.who;
    const sent = [...sync.outbox].filter((id) => S.labels[id]?.t).map(wire);
    sync.inflight = true;
    renderSaveState();
    try {
      // text/plain 이면 preflight 없이 Apps Script 로 바로 간다
      const res = await fetch(SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ labels: sent }) });
      const r = await res.json();
      if (!r.ok) throw new Error(r.error || `HTTP ${res.status}`);
      if (who === S.who) {
        // 보내는 사이 또 바뀐 영상은 남겨 둔다
        for (const l of sent) if (S.labels[l.file]?.t === l.t) sync.outbox.delete(l.file);
        const errs = Object.entries(r.errors || {});
        for (const [id] of errs) sync.outbox.delete(id);
        if (errs.length) toast(`시트가 ${errs.length}개를 받지 않았습니다 (${errs[0][0].split('/').pop()}: ${errs[0][1]})`, true);
        saveOutbox();
      }
      sync.ok = true;
      sync.delay = 0;
      if (r.stale && r.stale.length) pull();
    } catch {
      sync.ok = false;
      sync.delay = Math.min(60000, (sync.delay || 2500) * 2);
      scheduleFlush(sync.delay);
    } finally {
      sync.inflight = false;
      renderSaveState();
      if (sync.ok && sync.outbox.size) scheduleFlush(500);
    }
  }

  async function pull() {
    if (!SYNC_URL || !S.who) return;
    const who = S.who;
    clearTimeout(sync.pullTimer);
    sync.pulledAt = Date.now();
    try {
      const res = await fetch(`${SYNC_URL}?a=${encodeURIComponent(who)}`);
      const r = await res.json();
      if (!r.ok) throw new Error(r.error || `HTTP ${res.status}`);
      if (who !== S.who) return;
      const remote = r.labels || {};
      let took = 0;
      for (const v of S.list) {
        const mine = S.labels[v.id];
        const theirs = remote[v.id];
        if (theirs && (!mine?.t || theirs.t > mine.t)) {
          S.labels[v.id] = theirs;
          sync.outbox.delete(v.id);
          took++;
        } else if (mine?.t && (!theirs || mine.t > theirs.t)) {
          sync.outbox.add(v.id);
        } else if (theirs) {
          sync.outbox.delete(v.id);
        }
      }
      saveOutbox();
      sync.ok = true;
      if (took) {
        persist();
        renderForm();
        renderMarkers();
        renderStripMarks();
        renderList();
        renderProgress();
        toast(`시트에서 라벨 ${took}개를 불러왔습니다`);
      }
      flush();
    } catch {
      sync.ok = false;
      sync.pullTimer = setTimeout(() => { if (who === S.who) pull(); }, 15000);
    }
    renderSaveState();
  }

  // 탭을 닫거나 숨길 때 남은 것을 보낸다. 응답은 못 받으니 outbox 는 그대로 두고, 다음에 열 때 다시 맞춘다.
  function beacon() {
    if (!SYNC_URL || !sync.outbox.size || !navigator.sendBeacon) return;
    const labels = [...sync.outbox].filter((id) => S.labels[id]?.t).map(wire);
    navigator.sendBeacon(SYNC_URL, new Blob([JSON.stringify({ labels })], { type: 'text/plain;charset=utf-8' }));
  }

  window.addEventListener('online', () => pull());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beacon();
    else if (S.who && Date.now() - sync.pulledAt > 60000) pull();
  });

  // ---------------------------------------------------------------- 목록

  function visible() {
    return S.list
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => {
        if (S.cond !== 'all' && v.cond !== S.cond) return false;
        const st = status(S.labels[v.id]);
        if (S.filter === 'todo') return st === 'todo' || st === 'partial';
        if (S.filter === 'done') return st === 'done';
        if (S.filter === 'nf') return st === 'nf';
        return true;
      });
  }

  function renderList() {
    const ol = $('#items');
    const rows = visible();
    const frag = document.createDocumentFragment();
    let lastCond = null;
    for (const { v, i } of rows) {
      if (v.cond !== lastCond) {
        lastCond = v.cond;
        const all = S.list.filter((x) => x.cond === v.cond);
        const fin = all.filter((x) => ['done', 'nf'].includes(status(S.labels[x.id]))).length;
        const g = document.createElement('li');
        g.className = 'group';
        g.innerHTML = `<span>${COND[v.cond].ko} · ${v.cond}</span><span class="n">${fin} / ${all.length}</span>`;
        frag.append(g);
      }
      const l = S.labels[v.id];
      const st = status(l);
      const li = document.createElement('li');
      li.className = `item ${st}${i === S.idx ? ' active' : ''}`;
      li.dataset.i = i;
      const rng = st === 'nf' ? '못 찾음' : l && (l.s != null || l.e != null) ? `${l.s ?? '?'}–${l.e ?? '?'}` : '';
      li.innerHTML = `<span class="dot"></span><span class="name"><b>s${v.scene} · p${v.pair}</b><small>${v.game}</small></span><span class="rng">${rng}</span>`;
      frag.append(li);
    }
    ol.replaceChildren(frag);
    if (!rows.length) ol.innerHTML = '<li class="group"><span>해당하는 영상이 없습니다</span></li>';
  }

  function scrollActiveIntoView() {
    const el = $('#items .item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function renderProgress() {
    const fin = S.list.filter((v) => ['done', 'nf'].includes(status(S.labels[v.id]))).length;
    $('#progress span').textContent = `${fin} / ${S.list.length} 완료`;
    $('#progress i').style.width = `${(100 * fin) / Math.max(1, S.list.length)}%`;
  }

  // ---------------------------------------------------------------- 영상 불러오기

  function load(i) {
    S.idx = clamp(i, 0, S.list.length - 1);
    store.set(`${KEY}:idx:${S.who}`, S.idx);
    const v = cur();
    S.target = 0;
    S.shown = 0;
    S.rangeStop = null;
    hideWarn();
    video.src = v.src;
    video.defaultPlaybackRate = video.playbackRate = Number($('#speed').value);
    resetStrip(v);
    renderTicks();
    renderMeta();
    renderForm();
    renderMarkers();
    renderFrame();
    renderList();
    renderProgress();
    scrollActiveIntoView();
    $('#layout').classList.remove('list-open');
  }

  video.addEventListener('loadedmetadata', () => seekTo(S.target ?? 0));
  video.addEventListener('error', () => showWarn(`영상을 불러오지 못했습니다: ${cur()?.src}`));

  // ---------------------------------------------------------------- 프레임 이동

  function seekTo(k) {
    const v = cur();
    if (!v) return;
    k = clamp(Math.round(k), 0, v.n - 1);
    S.rangeStop = null;
    S.target = k;
    S.seqAtSeek = S.frameSeq;
    if (!video.paused) video.pause();
    if (video.readyState >= 1) video.currentTime = (k + 0.5) / FPS;
    renderFrame();
  }

  const step = (d) => seekTo(frameNow() + d);

  function setShown(k) {
    const v = cur();
    S.shown = clamp(k, 0, v.n - 1);
    if (S.rangeStop != null && S.shown >= S.rangeStop) {
      S.rangeStop = null;
      video.pause();
    }
    renderFrame();
  }

  if (HAS_RVFC) {
    const onFrame = (_, md) => {
      S.frameSeq++;
      setShown(Math.round(md.mediaTime * FPS));
      if (S.target != null && !video.seeking) resolveTarget();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    const tick = () => {
      if (!video.paused) setShown(Math.floor(video.currentTime * FPS + 1e-4));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  video.addEventListener('seeked', () => {
    // rVFC 가 seeked 보다 먼저 왔거나 아예 안 오는 경우를 정리한다
    setTimeout(() => { if (S.target != null && !video.seeking) resolveTarget(); }, 80);
  });

  function resolveTarget() {
    const want = S.target;
    S.target = null;
    if (HAS_RVFC && S.frameSeq > S.seqAtSeek) {
      if (S.shown !== want) showWarn(`요청한 프레임 ${want} 대신 ${S.shown} 이(가) 표시됨. 라벨은 화면의 F 번호로 남습니다.`);
    } else {
      S.shown = clamp(Math.floor(video.currentTime * FPS + 1e-4), 0, cur().n - 1);
    }
    renderFrame();
    scheduleStrip();
  }

  video.addEventListener('play', renderPlay);
  video.addEventListener('pause', () => {
    renderPlay();
    // 재생 중 멈추면 프레임 가운데로 맞춰 둔다
    if (S.target == null) seekTo(S.shown);
  });

  function togglePlay() {
    if (video.paused) {
      if (frameNow() >= cur().n - 1) seekTo(0);
      S.target = null;
      video.play();
    } else {
      video.pause();
    }
  }

  function playRange() {
    const l = labelOf(cur());
    if (l.s == null) return toast('시작 프레임을 먼저 표시하세요');
    const a = Math.max(0, l.s - RANGE_PAD);
    const b = Math.min(cur().n - 1, (l.e ?? l.s) + RANGE_PAD);
    seekTo(a);
    S.rangeStop = b;
    video.play();
  }

  function setSpeed(x) {
    $('#speed').value = String(x);
    video.defaultPlaybackRate = video.playbackRate = x;
    store.set(`${KEY}:speed`, x);
  }

  // ---------------------------------------------------------------- 표시

  function renderFrame() {
    const v = cur();
    if (!v) return;
    const k = frameNow();
    $('#frameNow').textContent = k;
    $('#frameMax').textContent = v.n - 1;
    $('.fnum').classList.toggle('pending', S.target != null);
    $('#frameSub').textContent = `${(k / FPS).toFixed(3)} s · 6fps ${(k / 10).toFixed(1)}`;
    $('#tlHead').style.left = pct(k);
    if (!video.paused) return;
    for (const c of cells) c.el.classList.toggle('cur', c.frame === k);
  }

  function renderPlay() {
    $('#bPlay').textContent = video.paused ? '재생' : '정지';
  }

  const pct = (k) => `${(100 * k) / Math.max(1, cur().n - 1)}%`;

  function renderTicks() {
    const v = cur();
    const box = $('#ticks');
    const frag = document.createDocumentFragment();
    for (let k = 0; k < v.n; k += 30) {
      const major = k % 120 === 0;
      const i = document.createElement('i');
      i.style.left = pct(k);
      if (major) i.className = 'major';
      frag.append(i);
      if (major && k > 0 && k < v.n - 40) {
        const s = document.createElement('span');
        s.style.left = pct(k);
        s.textContent = k;
        frag.append(s);
      }
    }
    box.replaceChildren(frag);
  }

  function renderMarkers() {
    const l = labelOf(cur());
    const ms = $('#tlStart');
    const me = $('#tlEnd');
    const r = $('#tlRange');
    ms.style.display = l.s != null ? 'block' : 'none';
    me.style.display = l.e != null ? 'block' : 'none';
    if (l.s != null) ms.style.left = pct(l.s);
    if (l.e != null) me.style.left = pct(l.e);
    if (l.s != null && l.e != null && l.e > l.s) {
      r.style.display = 'block';
      r.style.left = pct(l.s);
      r.style.width = `calc(${pct(l.e)} - ${pct(l.s)})`;
    } else {
      r.style.display = 'none';
    }
  }

  function renderMeta() {
    const v = cur();
    const c = COND[v.cond];
    const dur = (v.n / FPS).toFixed(2);
    $('#meta').innerHTML = `
      <h2>scene ${v.scene} · pair ${v.pair}</h2>
      <div class="file">${v.id}</div>
      <div class="chips">
        <span class="chip cond" style="--c: var(--c-${v.cond})">${c.ko} · ${v.cond}</span>
        <span class="chip"><b>${v.game}</b></span>
        <span class="chip">${v.env}</span>
        <span class="chip">가림막 ${v.occ}</span>
        <span class="chip">${v.diff}</span>
        <span class="chip">카메라 ${v.cam}</span>
        <span class="chip">${v.n} 프레임 · ${dur} s</span>
      </div>`;
    const hint = $('#hint');
    hint.style.setProperty('--c', `var(--c-${v.cond})`);
    hint.innerHTML = `<b>${c.ko} 위반</b>${c.hint}`;
    $('#inStart').max = $('#inEnd').max = v.n - 1;
  }

  function renderForm() {
    const v = cur();
    const l = labelOf(v);
    const setVal = (el, x) => { if (document.activeElement !== el) el.value = x ?? ''; };
    setVal($('#inStart'), l.s);
    setVal($('#inEnd'), l.e);
    setVal($('#note'), l.note);
    $('#chkOcc').checked = !!l.occ;
    $('#chkNf').checked = !!l.nf;
    $('#form').classList.toggle('nf', !!l.nf);

    const msg = [];
    if (l.s != null && l.e != null && l.e < l.s) msg.push('끝 프레임이 시작보다 앞입니다.');
    if (l.nf && !(l.note || '').trim()) msg.push('못 찾은 이유를 메모에 적어 주세요.');
    if (!l.nf && l.s != null && l.e == null) msg.push('끝 프레임이 비어 있습니다 (순간 사건이면 I).');
    $('#formMsg').textContent = msg.join(' ');

    $('#score').textContent = l.s != null
      ? `6 fps 채점 기준 (÷10)  시작 ${(l.s / 10).toFixed(1)}${l.e != null ? ` · 끝 ${(l.e / 10).toFixed(1)} · 길이 ${l.e - l.s + 1} 프레임` : ''}`
      : '';
  }

  function showWarn(t) {
    const w = $('#warn');
    w.textContent = t;
    w.hidden = false;
  }
  const hideWarn = () => { $('#warn').hidden = true; };

  let toastTimer = 0;
  function toast(t, error = false) {
    const el = $('#toast');
    el.textContent = t;
    el.className = `toast${error ? ' error' : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 2600);
  }

  // ---------------------------------------------------------------- 주변 프레임 줄

  const cells = [];
  const stripCache = new Map();
  let stripGen = 0;
  let stripTimer = 0;
  let grabChain = Promise.resolve();
  let stripSrc = '';

  (function buildStrip() {
    const box = $('#strip');
    for (let j = -STRIP_R; j <= STRIP_R; j++) {
      const el = document.createElement('div');
      el.className = 'cell';
      const cv = document.createElement('canvas');
      cv.width = cv.height = 192;
      const cap = document.createElement('div');
      cap.className = 'cap';
      el.append(cv, cap);
      const c = { el, cv, cap, off: j, frame: null };
      el.addEventListener('click', () => { if (c.frame != null) seekTo(c.frame); });
      box.append(el);
      cells.push(c);
    }
  })();

  function resetStrip(v) {
    stripGen++;
    stripCache.clear();
    grabChain = Promise.resolve();
    stripSrc = v.src;
    stripVideo.src = v.src;
    for (const c of cells) {
      c.frame = null;
      c.cv.getContext('2d').clearRect(0, 0, c.cv.width, c.cv.height);
    }
  }

  function scheduleStrip() {
    if (!video.paused || scrubbing) return;
    clearTimeout(stripTimer);
    stripTimer = setTimeout(renderStrip, 70);
  }

  async function renderStrip() {
    const gen = ++stripGen;
    const v = cur();
    const center = frameNow();
    for (const c of cells) {
      c.frame = center + c.off;
      paintCell(c);
    }
    renderStripMarks();
    for (const c of [...cells].sort((a, b) => Math.abs(a.off) - Math.abs(b.off))) {
      const k = c.frame;
      if (k < 0 || k >= v.n || stripCache.has(k)) continue;
      await grab(k);
      if (gen !== stripGen) return;
      for (const d of cells) if (d.frame === k) paintCell(d);
    }
  }

  function paintCell(c) {
    const v = cur();
    const k = c.frame;
    const out = k < 0 || k >= v.n;
    c.el.classList.toggle('out', out);
    if (out) return;
    const ctx = c.cv.getContext('2d');
    const img = stripCache.get(k);
    c.el.classList.toggle('loading', !img);
    if (img) ctx.drawImage(img, 0, 0, c.cv.width, c.cv.height);
    c.cap.innerHTML = `<b>${k}</b><span>${c.off > 0 ? '+' : ''}${c.off || '현재'}</span>`;
  }

  function renderStripMarks() {
    const l = labelOf(cur());
    const k = frameNow();
    for (const c of cells) {
      c.el.classList.toggle('cur', c.frame === k);
      c.el.classList.toggle('is-start', c.frame != null && c.frame === l.s);
      c.el.classList.toggle('is-end', c.frame != null && c.frame === l.e);
      c.el.classList.toggle('in-range', c.frame != null && l.s != null && l.e != null && c.frame >= l.s && c.frame <= l.e);
    }
  }

  // 한 번에 하나씩: 겹치면 seeked 가 다른 프레임 것으로 섞인다
  function grab(k) {
    const p = grabChain.then(() => grabOne(k));
    grabChain = p.catch(() => {});
    return p;
  }

  function grabOne(k) {
    const src = stripSrc;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        stripVideo.removeEventListener('seeked', onSeeked);
        if (ok && src === stripSrc) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 192;
          cv.getContext('2d').drawImage(stripVideo, 0, 0, 192, 192);
          stripCache.set(k, cv);
        }
        resolve();
      };
      const onSeeked = () => finish(true);
      const go = () => {
        if (src !== stripSrc) return finish(false);
        stripVideo.addEventListener('seeked', onSeeked);
        stripVideo.currentTime = (k + 0.5) / FPS;
      };
      setTimeout(() => finish(false), 3000);
      if (stripVideo.readyState >= 1) go();
      else stripVideo.addEventListener('loadedmetadata', go, { once: true });
    });
  }

  // ---------------------------------------------------------------- 타임라인

  let scrubbing = false;
  let scrubRaf = 0;
  const track = $('.track');
  const frameAt = (e) => {
    const r = track.getBoundingClientRect();
    return Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * (cur().n - 1));
  };
  track.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    track.setPointerCapture(e.pointerId);
    seekTo(frameAt(e));
  });
  track.addEventListener('pointermove', (e) => {
    const k = frameAt(e);
    const hv = $('#tlHover');
    hv.hidden = false;
    hv.style.left = pct(k);
    hv.textContent = k;
    if (!scrubbing) return;
    cancelAnimationFrame(scrubRaf);
    scrubRaf = requestAnimationFrame(() => seekTo(k));
  });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    scheduleStrip();
  };
  track.addEventListener('pointerup', endScrub);
  track.addEventListener('pointercancel', endScrub);
  track.addEventListener('pointerleave', () => { $('#tlHover').hidden = true; });

  // ---------------------------------------------------------------- 라벨 조작

  function setStart(k = frameNow()) { update({ s: k, nf: false }); }
  function setEnd(k = frameNow()) { update({ e: k, nf: false }); }
  function instant() {
    const l = labelOf(cur());
    if (l.s == null) return toast('시작 프레임을 먼저 표시하세요');
    update({ e: l.s });
  }

  function parseFrame(el) {
    const t = el.value.trim();
    if (t === '') return null;
    const k = Number(t);
    if (!Number.isInteger(k) || k < 0 || k > cur().n - 1) {
      toast(`0 – ${cur().n - 1} 사이 정수만 넣을 수 있습니다`, true);
      return undefined;
    }
    return k;
  }

  function go(delta) {
    const rows = visible();
    if (!rows.length) return;
    let pos = rows.findIndex((r) => r.i === S.idx);
    if (pos < 0) pos = delta > 0 ? -1 : rows.length;
    const nxt = rows[pos + delta];
    if (!nxt) return toast(delta > 0 ? '목록의 마지막 영상입니다' : '목록의 첫 영상입니다');
    load(nxt.i);
  }

  // ---------------------------------------------------------------- CSV

  const HEAD = ['file', 'annotator', 'violation_start_frame', 'violation_end_frame', 'note', 'occluded', 'not_found', 'updated_at'];

  function exportCsv() {
    const cell = (x) => {
      const s = String(x ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = S.list.map((v) => {
      const l = S.labels[v.id] || {};
      return [v.id, S.who, l.nf ? '' : l.s ?? '', l.nf ? '' : l.e ?? '', l.note || '', l.occ ? 1 : 0, l.nf ? 1 : 0, l.t || ''];
    });
    const csv = '﻿' + [HEAD, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `intphys2_labels_${S.who}_${stamp}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    S.meta = { exportedAt: d.toISOString(), changed: [] };
    persist();
    toast(`${a.download} 저장`);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let f = '';
    let q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => x !== ''));
  }

  async function importCsv(file) {
    const rows = parseCsv(await file.text());
    const head = rows.shift() || [];
    const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
    if (col.file == null || col.violation_start_frame == null) return toast('이 도구가 내보낸 CSV 가 아닙니다', true);
    const mine = new Set(S.list.map((v) => v.id));
    const num = (x) => (x == null || x.trim() === '' ? null : Number(x));
    const incoming = {};
    let other = 0;
    for (const r of rows) {
      const id = r[col.file];
      if (!mine.has(id)) { other++; continue; }
      const l = {
        s: num(r[col.violation_start_frame]),
        e: num(r[col.violation_end_frame]),
        note: r[col.note] || '',
        occ: r[col.occluded] === '1',
        nf: r[col.not_found] === '1',
        t: r[col.updated_at] || new Date().toISOString(),
      };
      if (status(l) !== 'todo') incoming[id] = l;
    }
    const ids = Object.keys(incoming);
    const clash = ids.filter((id) => status(S.labels[id]) !== 'todo' && JSON.stringify(S.labels[id]) !== JSON.stringify(incoming[id]));
    if (!ids.length) return toast(`가져올 라벨이 없습니다${other ? ` (다른 작업자 영상 ${other}개는 건너뜀)` : ''}`, true);
    if (clash.length && !confirm(`${ids.length}개를 가져옵니다. 이미 라벨이 다른 ${clash.length}개는 파일 내용으로 덮어씁니다. 계속할까요?`)) return;
    Object.assign(S.labels, incoming);
    persist();
    for (const id of ids) queueSync(id);
    load(S.idx);
    toast(`${ids.length}개 가져옴${other ? ` · 다른 작업자 영상 ${other}개는 건너뜀` : ''}`);
  }

  // ---------------------------------------------------------------- 이벤트

  const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);

  on('#bBack10', 'click', () => step(-10));
  on('#bBack1', 'click', () => step(-1));
  on('#bFwd1', 'click', () => step(1));
  on('#bFwd10', 'click', () => step(10));
  on('#bPlay', 'click', togglePlay);
  on('#bRange', 'click', playRange);
  on('#speed', 'change', (e) => setSpeed(Number(e.target.value)));
  on('#bSetStart', 'click', () => setStart());
  on('#bSetEnd', 'click', () => setEnd());
  on('#bGoStart', 'click', () => { const l = labelOf(cur()); if (l.s != null) seekTo(l.s); });
  on('#bGoEnd', 'click', () => { const l = labelOf(cur()); if (l.e != null) seekTo(l.e); });
  on('#bInstant', 'click', instant);
  on('#chkOcc', 'change', (e) => update({ occ: e.target.checked }));
  on('#chkNf', 'change', (e) => update(e.target.checked ? { nf: true, s: null, e: null } : { nf: false }));
  on('#note', 'input', (e) => update({ note: e.target.value }));
  on('#inStart', 'change', (e) => { const k = parseFrame(e.target); if (k !== undefined) update({ s: k, nf: false }); else renderForm(); });
  on('#inEnd', 'change', (e) => { const k = parseFrame(e.target); if (k !== undefined) update({ e: k, nf: false }); else renderForm(); });
  on('#bPrev', 'click', () => go(-1));
  on('#bNext', 'click', () => go(1));
  on('#btnExport', 'click', exportCsv);
  on('#btnImport', 'click', () => $('#fileImport').click());
  on('#fileImport', 'change', (e) => { const f = e.target.files[0]; if (f) importCsv(f); e.target.value = ''; });
  on('#btnGuide', 'click', () => $('#guide').showModal());
  on('#bGuideClose', 'click', () => $('#guide').close());
  on('#btnList', 'click', () => $('#layout').classList.toggle('list-open'));
  on('#items', 'click', (e) => {
    const li = e.target.closest('.item');
    if (li) load(Number(li.dataset.i));
  });
  on('#filterSeg', 'click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.filter = b.dataset.f;
    for (const x of document.querySelectorAll('#filterSeg button')) x.classList.toggle('on', x === b);
    renderList();
    scrollActiveIntoView();
  });
  on('#condFilter', 'change', (e) => { S.cond = e.target.value; renderList(); scrollActiveIntoView(); });

  // 클릭한 버튼이 포커스를 잡고 있으면 Space 가 그 버튼을 다시 누른다
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.blur();
  });

  document.addEventListener('keydown', (e) => {
    if ($('#guide').open || !$('#picker').hidden) return;
    if (e.target.matches('input, textarea, select')) {
      if (e.key === 'Escape' || (e.key === 'Enter' && e.target.matches('input'))) e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const handled = {
      ArrowLeft: () => step(e.shiftKey ? -10 : -1),
      ArrowRight: () => step(e.shiftKey ? 10 : 1),
      ' ': togglePlay,
      s: () => setStart(),
      e: () => setEnd(),
      i: instant,
      o: () => update({ occ: !labelOf(cur()).occ }),
      r: playRange,
      '[': () => $('#bGoStart').click(),
      ']': () => $('#bGoEnd').click(),
      Enter: () => go(1),
      n: () => go(1),
      p: () => go(-1),
      '1': () => setSpeed(SPEEDS[0]),
      '2': () => setSpeed(SPEEDS[1]),
      '3': () => setSpeed(SPEEDS[2]),
      '4': () => setSpeed(SPEEDS[3]),
      '?': () => $('#guide').showModal(),
    }[k.length === 1 ? k.toLowerCase() : k];
    if (handled) {
      e.preventDefault();
      handled();
    }
  });

  // ---------------------------------------------------------------- 시작

  (function init() {
    const cf = $('#condFilter');
    cf.add(new Option('모든 condition', 'all'));
    for (const c of COND_ORDER) cf.add(new Option(`${COND[c].ko} · ${c}`, c));

    const dl = $('#condList');
    for (const c of COND_ORDER) {
      const dt = document.createElement('dt');
      dt.style.setProperty('--c', `var(--c-${c})`);
      dt.textContent = `${COND[c].ko} · ${c}`;
      const dd = document.createElement('dd');
      dd.textContent = COND[c].hint;
      dl.append(dt, dd);
    }

    if (SYNC_URL) {
      $('#pickerNote').textContent = '장면 단위 (pair1 · pair2 함께) 로 condition 마다 고르게 4 명에게 나눴습니다. 라벨은 공유 시트에 자동 저장되니, 다른 컴퓨터에서 열어도 이어서 작업할 수 있습니다.';
      $('#guideSave').innerHTML = '라벨은 저장할 때마다 공유 시트로 보내집니다. 오른쪽 위가 <b>시트에 저장됨</b> 인지 확인하세요. 연결이 끊겨도 이 브라우저에 남아 있다가 다시 연결되면 보내집니다. CSV 내보내기는 백업용입니다.';
    }

    $('#speed').value = String(store.get(`${KEY}:speed`, 0.5));
    if (!HAS_RVFC) toast('이 브라우저는 프레임 단위 표시를 지원하지 않습니다. 최신 Chrome 을 권장합니다.', true);
    initWho();
  })();
})();
