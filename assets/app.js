// IntPhys 위반 시점 라벨링 (IntPhys 2 · IntPhys 1).
// 프레임 k 는 clip 에서 pts = k / fps (tools/build_site.py 참고) 이라 currentTime = (k + 0.5) / fps 로 이동하고,
// 실제로 화면에 나온 프레임은 requestVideoFrameCallback 의 mediaTime 으로 읽는다.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
    },
  };

  // ---------------------------------------------------------------- 데이터셋
  // ip2: IntPhys 2 불가능 영상만. 위반 시작 · 끝 (+ 가림 뒤).
  // ip1: IntPhys 1 가림 샘플, 가능 · 불가능 쌍 모두. 물체 정지 / 움직임 + 시작 · 끝. 짝 영상을 나란히 본다.

  const COND = {
    permanence: { ko: '영속성', hint: '물체가 저절로 사라지거나 나타납니다. 사라지기 (나타나기) 시작하는 첫 프레임이 시작.' },
    immutability: { ko: '불변성', hint: '물체의 모양 · 색 · 크기가 저절로 바뀝니다. 바뀌기 시작하는 첫 프레임이 시작.' },
    continuity: { ko: '연속성', hint: '물체가 이어진 경로 없이 순간이동합니다. 순간이동한 첫 프레임이 시작 (보통 끝 = 시작).' },
    solidity: { ko: '고체성', hint: '물체가 다른 물체를 통과합니다. 겹치며 통과하기 시작하는 첫 프레임이 시작.' },
  };
  const PRIN = {
    O1: { ko: '영속성', en: 'permanence', hint: '가림막 뒤에서 물체가 사라지거나 새로 생깁니다. 드러났을 때 있어야 할 물체가 없거나, 없던 물체가 보이는 첫 프레임이 시작.' },
    O2: { ko: '모양 불변', en: 'shape constancy', hint: '가림막 뒤에서 물체의 모양이 바뀝니다. 바뀐 모양이 처음 보이는 프레임이 시작.' },
    O3: { ko: '연속성', en: 'continuity', hint: '물체가 이어진 경로 없이 다른 자리에 나타납니다 (가림막 뒤 순간이동). 엉뚱한 자리에 있는 게 처음 보이는 프레임이 시작.' },
  };
  const POS_HINT = '위반은 없습니다. 짝 불가능 영상에서 위반이 보이는 바로 그 사건 (가림막이 걷히거나 물체가 다시 나오는 순간) 의 구간을 같은 기준으로 시작 · 끝에 찍습니다.';
  const MO_KO = { static: '정지', moving: '움직임' };

  const SETS = {
    ip2: {
      m: window.MANIFEST, key: 'intphys2-vlabel-v1', name: 'IntPhys 2', what: '불가능 영상 · 위반 시작 · 끝',
      groups: COND, groupOf: (v) => v.cond, tick: 30, major: 120, pad: 45,
    },
    ip1: {
      m: window.MANIFEST_IP1, key: 'intphys1-vlabel-v1', name: 'IntPhys 1', what: '가림 장면 · 가능 / 불가능 쌍 · 물체 정지 여부 + 시작 · 끝',
      groups: PRIN, groupOf: (v) => v.prin, tick: 5, major: 25, pad: 12,
    },
  };

  // 예전 링크 (?a=A) 는 IntPhys 2
  const params = new URLSearchParams(location.search);
  const SET = params.get('d') || (params.get('a') ? 'ip2' : store.get('vlabel:set', null));
  const D = SETS[SET];
  if (!D || !D.m) return pickSet();
  store.set('vlabel:set', SET);

  const IP1 = SET === 'ip1';
  const M = D.m;
  const FPS = M.fps;
  const KEY = D.key;
  const GROUPS = D.groups;
  const GROUP_ORDER = Object.keys(GROUPS);
  const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const STRIP_R = 3;
  const SPEEDS = [0.1, 0.25, 0.5, 1];
  const SYNC_URL = (window.SYNC_URL || '').trim();

  const video = $('#video');
  const mateVideo = $('#mateVideo');
  const byId = new Map(M.videos.map((v) => [v.id, v]));

  const S = {
    who: null,
    list: [],          // 이 작업자의 영상 (정렬됨)
    idx: 0,
    labels: {},        // id → { s, e, occ, mo, nf, note, t }
    meta: { exportedAt: null, changed: [] },
    filter: 'all',
    group: 'all',
    compare: IP1 && store.get(`${KEY}:compare`, true),
    shown: 0,          // 화면에 실제로 나온 프레임
    target: null,      // 이동 요청 중인 프레임
    frameSeq: 0,
    seqAtSeek: 0,
    rangeStop: null,
    saveFailed: false,
  };

  const cur = () => S.list[S.idx];
  const mateOf = (v) => byId.get(v.mate);
  const comparing = () => IP1 && S.compare;
  const frameNow = () => (S.target ?? S.shown);
  const labelOf = (v) => S.labels[v.id] || { s: null, e: null, occ: false, mo: '', nf: false, note: '' };
  const plTag = (v, cls = '') => `<span class="pl ${v.pos ? 'pos' : 'imp'} ${cls}">${v.pos ? '가능' : '불가능'}</span>`;
  const png = (k) => `scene_${String(k + 1).padStart(3, '0')}`;

  function status(l) {
    if (!l) return 'todo';
    if (l.nf) return 'nf';
    if (l.s != null && l.e != null && l.s <= l.e && (!IP1 || l.mo)) return 'done';
    if (l.s != null || l.e != null || l.occ || l.mo || (l.note && l.note.trim())) return 'partial';
    return 'todo';
  }

  // ---------------------------------------------------------------- 데이터셋 · 작업자

  function pickSet() {
    $('#pickerTitle').textContent = '데이터셋을 고르세요';
    $('#pickerNote').textContent = '라벨은 데이터셋마다 따로 저장됩니다. 위쪽 탭으로 언제든 바꿀 수 있습니다.';
    for (const [k, d] of Object.entries(SETS)) {
      if (!d.m) continue;
      const b = document.createElement('button');
      b.innerHTML = `<b>${d.name}</b><span>${d.m.videos.length}개 · ${d.what}</span>`;
      b.addEventListener('click', () => { location.search = `?d=${k}`; });
      $('#pickerGrid').append(b);
    }
    $('#picker').hidden = false;
  }

  function renderSets() {
    const nav = $('#sets');
    nav.replaceChildren(...Object.entries(SETS).filter(([, d]) => d.m).map(([k, d]) => {
      const a = document.createElement('a');
      a.textContent = d.name;
      a.href = `?d=${k}${S.who ? `&a=${S.who}` : ''}`;
      if (k === SET) a.className = 'on';
      return a;
    }));
  }

  function initWho() {
    const sel = $('#who');
    const grid = $('#pickerGrid');
    for (const a of M.annotators) {
      const vs = M.videos.filter((v) => v.part === a);
      sel.add(new Option(`${a} · ${vs.length}개`, a));
      const by = GROUP_ORDER.map((g) => `${IP1 ? g : GROUPS[g].ko} ${vs.filter((v) => D.groupOf(v) === g).length}`).join(' · ');
      const b = document.createElement('button');
      b.innerHTML = `<b>${a}</b><span>${vs.length}개${IP1 ? ` (묶음 ${vs.length / 4}개)` : ''} · ${by}</span>`;
      b.addEventListener('click', () => setWho(a));
      grid.append(b);
    }
    sel.addEventListener('change', () => setWho(sel.value));

    const fromUrl = params.get('a');
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
      u.searchParams.set('d', SET);
      u.searchParams.set('a', a);
      history.replaceState(null, '', u);
    } catch { /* file:// 등 */ }
    renderSets();

    S.labels = store.get(`${KEY}:labels:${a}`, {});
    S.meta = store.get(`${KEY}:meta:${a}`, { exportedAt: null, changed: [] });
    sync.outbox = new Set(store.get(`${KEY}:outbox:${a}`, []));
    sync.ok = null;
    S.list = M.videos.filter((v) => v.part === a).sort(IP1
      ? (x, y) => x.prin.localeCompare(y.prin) || x.quad.localeCompare(y.quad) || x.pair - y.pair || x.pos - y.pos
      : (x, y) => GROUP_ORDER.indexOf(x.cond) - GROUP_ORDER.indexOf(y.cond) ||
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
    renderLabel();
  }

  function renderLabel() {
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
      if (sync.outdated) {
        el.textContent = `시트 스크립트 업데이트 필요 · ${q}개 대기`;
        el.title = `배포된 Apps Script 가 ${D.name} 을(를) 모릅니다. tools/sheet_sync.gs 를 붙여넣고 새 버전으로 배포하면 자동으로 보냅니다. 라벨은 이 브라우저에 저장돼 있습니다.`;
        el.classList.add('error');
      } else if (sync.ok === false) {
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
  // 응답의 set 이 이 데이터셋이 아니면 (예전 스크립트) 보내지 않고 기다린다. 예전 스크립트는 set 없이 ip2 만 안다.

  const sync = { outbox: new Set(), inflight: false, ok: null, outdated: false, timer: 0, delay: 0, pullTimer: 0, pulledAt: 0 };
  const knows = (r) => (r.set || 'ip2') === SET;

  const wire = (id) => {
    const l = S.labels[id];
    const w = { file: id, annotator: S.who, s: l.s ?? null, e: l.e ?? null, note: l.note || '', nf: !!l.nf, t: l.t };
    if (IP1) w.mo = l.mo || '';
    else w.occ = !!l.occ;
    return w;
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
      const res = await fetch(SYNC_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ set: SET, labels: sent }) });
      const r = await res.json();
      if (!r.ok) throw new Error(r.error || `HTTP ${res.status}`);
      sync.outdated = !knows(r);
      if (sync.outdated) throw new Error('outdated');
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
      const res = await fetch(`${SYNC_URL}?set=${SET}&a=${encodeURIComponent(who)}`);
      const r = await res.json();
      if (!r.ok) throw new Error(r.error || `HTTP ${res.status}`);
      sync.outdated = !knows(r);
      if (sync.outdated) throw new Error('outdated');
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
        renderLabel();
        renderMate();
        toast(`시트에서 라벨 ${took}개를 불러왔습니다`);
      }
      flush();
    } catch {
      sync.ok = false;
      sync.pullTimer = setTimeout(() => { if (who === S.who) pull(); }, sync.outdated ? 60000 : 15000);
    }
    renderSaveState();
  }

  // 탭을 닫거나 숨기거나 데이터셋을 바꿀 때 남은 것을 보낸다. 응답은 못 받으니 outbox 는 그대로 두고, 다음에 열 때 다시 맞춘다.
  function beacon() {
    if (!SYNC_URL || sync.outdated || !sync.outbox.size || !navigator.sendBeacon) return;
    const labels = [...sync.outbox].filter((id) => S.labels[id]?.t).map(wire);
    navigator.sendBeacon(SYNC_URL, new Blob([JSON.stringify({ set: SET, labels })], { type: 'text/plain;charset=utf-8' }));
  }

  window.addEventListener('online', () => pull());
  window.addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beacon();
    else if (S.who && Date.now() - sync.pulledAt > 60000) pull();
  });

  // ---------------------------------------------------------------- 목록

  function visible() {
    return S.list
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => {
        if (S.group !== 'all' && D.groupOf(v) !== S.group) return false;
        const st = status(S.labels[v.id]);
        if (S.filter === 'todo') return st === 'todo' || st === 'partial';
        if (S.filter === 'done') return st === 'done';
        if (S.filter === 'nf') return st === 'nf';
        return true;
      });
  }

  const finished = (vs) => vs.filter((x) => ['done', 'nf'].includes(status(S.labels[x.id]))).length;

  function rangeText(l) {
    const st = status(l);
    if (st === 'nf') return '못 찾음';
    const parts = [];
    if (l && (l.s != null || l.e != null)) parts.push(`${l.s ?? '?'}–${l.e ?? '?'}`);
    if (IP1 && l?.mo) parts.push(MO_KO[l.mo]);
    return parts.join(' · ');
  }

  function renderList() {
    const ol = $('#items');
    const rows = visible();
    const frag = document.createDocumentFragment();
    let lastGroup = null;
    let lastPair = null;
    for (const { v, i } of rows) {
      // IntPhys 1 은 묶음 (쌍 2 개) 마다, IntPhys 2 는 condition 마다 머리줄
      const gk = IP1 ? `${v.prin}_${v.quad}` : v.cond;
      if (gk !== lastGroup) {
        lastGroup = gk;
        lastPair = null;
        const all = S.list.filter((x) => (IP1 ? `${x.prin}_${x.quad}` : x.cond) === gk);
        const g = document.createElement('li');
        g.className = 'group';
        g.innerHTML = IP1
          ? `<span><i class="sw" style="--c: var(--c-${v.prin})"></i>${gk} · ${PRIN[v.prin].ko}</span><span class="n">${finished(all)} / ${all.length}</span>`
          : `<span>${COND[v.cond].ko} · ${v.cond}</span><span class="n">${finished(all)} / ${all.length}</span>`;
        frag.append(g);
      }
      const l = S.labels[v.id];
      const st = status(l);
      const li = document.createElement('li');
      li.dataset.i = i;
      if (IP1) {
        const first = v.pair !== lastPair;
        lastPair = v.pair;
        li.className = `item ip1 p${v.pair}${first ? ' pair-first' : ''} ${st}${i === S.idx ? ' active' : ''}`;
        li.innerHTML = `<span class="pairtag">${first ? `쌍 ${v.pair}` : ''}</span><span class="dot"></span><span class="name">${plTag(v)}<small>${v.id}</small></span><span class="rng">${rangeText(l)}</span>`;
      } else {
        li.className = `item ${st}${i === S.idx ? ' active' : ''}`;
        li.innerHTML = `<span class="dot"></span><span class="name"><b>s${v.scene} · p${v.pair}</b><small>${v.game}</small></span><span class="rng">${rangeText(l)}</span>`;
      }
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
    const fin = finished(S.list);
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
    if (IP1) mateVideo.src = mateOf(v).src;
    resetStrip(v);
    renderTicks();
    renderMeta();
    renderCompare();
    renderMate();
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
  mateVideo.addEventListener('loadedmetadata', () => mateSeek(frameNow()));

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
    mateSeek(k);
    renderFrame();
  }

  // 짝 영상은 늘 같은 프레임 번호에 둔다
  function mateSeek(k) {
    if (!comparing() || mateVideo.readyState < 1) return;
    if (!mateVideo.paused) mateVideo.pause();
    mateVideo.currentTime = (clamp(k, 0, mateOf(cur()).n - 1) + 0.5) / FPS;
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
      // 재생 중 짝 영상이 1 프레임 넘게 어긋나면 맞춘다 (멈추면 seekTo 로 정확히 맞춤)
      if (comparing() && !video.paused && !mateVideo.seeking && Math.abs(mateVideo.currentTime - video.currentTime) > 1.5 / FPS) {
        mateVideo.currentTime = video.currentTime;
      }
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

  video.addEventListener('play', () => {
    renderPlay();
    if (!comparing()) return;
    mateVideo.playbackRate = video.playbackRate;
    mateVideo.currentTime = video.currentTime;
    mateVideo.play().catch(() => {});
  });
  video.addEventListener('pause', () => {
    renderPlay();
    mateVideo.pause();
    // 재생 중 멈추면 프레임 가운데로 맞춰 둔다
    if (S.target == null) seekTo(S.shown);
  });
  video.addEventListener('ratechange', () => { mateVideo.playbackRate = video.playbackRate; });

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
    const a = Math.max(0, l.s - D.pad);
    const b = Math.min(cur().n - 1, (l.e ?? l.s) + D.pad);
    seekTo(a);
    S.rangeStop = b;
    video.play();
  }

  function setSpeed(x) {
    $('#speed').value = String(x);
    video.defaultPlaybackRate = video.playbackRate = x;
    store.set(`vlabel:speed:${SET}`, x);
  }

  // ---------------------------------------------------------------- 짝 영상 (IntPhys 1)

  function setCompare(on) {
    if (!IP1) return;
    S.compare = on;
    store.set(`${KEY}:compare`, on);
    renderCompare();
    renderMarkers();
    if (on) {
      mateSeek(frameNow());
      scheduleStrip();
    } else {
      mateVideo.pause();
    }
  }

  // 나란히 볼 때 자리는 고정: 왼쪽 (위) 가능, 오른쪽 (아래) 불가능. 지금 라벨하는 쪽에 테두리.
  function renderCompare() {
    const on = comparing();
    $('#stage').classList.toggle('compare', on);
    $('#paneMate').hidden = !on;
    $('#stripRowMate').hidden = !on;
    $('#bCompare').classList.toggle('on', on);
    if (!IP1) return;
    const v = cur();
    const m = mateOf(v);
    $('#paneMain').style.order = $('#stripRowMain').style.order = v.pos ? 0 : 1;
    $('#paneMate').style.order = $('#stripRowMate').style.order = v.pos ? 1 : 0;
    $('#tagMain').innerHTML = `${plTag(v)} ${v.id} <em>라벨 중</em>`;
    $('#tagMate').innerHTML = `${plTag(m)} ${m.id}`;
    $('#rowTagMain').innerHTML = plTag(v);
    $('#rowTagMate').innerHTML = plTag(m);
    $('#stripHint').textContent = on
      ? '위 · 왼쪽이 가능, 아래 · 오른쪽이 불가능. 같은 번호끼리 비교하세요.'
      : '경계 확인: 바로 앞 칸은 아직 가능, 표시한 칸부터 불가능';
  }

  function renderMate() {
    if (!IP1) return;
    const m = mateOf(cur());
    const l = labelOf(m);
    const vals = rangeText(S.labels[m.id]);
    $('#mateInfo').innerHTML = `${plTag(m)} <b>${m.id}</b><span class="mv">${vals || '아직 없음'}</span>`;
    $('#bMateCopy').disabled = l.s == null && l.e == null && !l.mo;
  }

  function goMate() {
    if (!IP1) return;
    const i = S.list.findIndex((v) => v.id === cur().mate);
    if (i >= 0) load(i);
  }

  function copyMate() {
    const l = labelOf(mateOf(cur()));
    const patch = { s: l.s, e: l.e, nf: false };
    if (l.mo && !labelOf(cur()).mo) patch.mo = l.mo;
    update(patch);
    toast('짝 영상의 값을 가져왔습니다. 화면에서 맞는지 확인하세요.');
  }

  // ---------------------------------------------------------------- 표시

  function renderFrame() {
    const v = cur();
    if (!v) return;
    const k = frameNow();
    $('#frameNow').textContent = k;
    $('#frameMax').textContent = v.n - 1;
    $('.fnum').classList.toggle('pending', S.target != null);
    $('#frameSub').textContent = IP1
      ? `${(k / FPS).toFixed(2)} s · ${png(k)}.png`
      : `${(k / FPS).toFixed(3)} s · 6fps ${(k / 10).toFixed(1)}`;
    $('#tlHead').style.left = pct(k);
    if (!video.paused) return;
    for (const row of stripRows()) for (const c of row.cells) c.el.classList.toggle('cur', c.frame === k);
  }

  function renderPlay() {
    $('#bPlay').textContent = video.paused ? '재생' : '정지';
  }

  const pct = (k) => `${(100 * k) / Math.max(1, cur().n - 1)}%`;

  function renderTicks() {
    const v = cur();
    const box = $('#ticks');
    const frag = document.createDocumentFragment();
    for (let k = 0; k < v.n; k += D.tick) {
      const major = k % D.major === 0;
      const i = document.createElement('i');
      i.style.left = pct(k);
      if (major) i.className = 'major';
      frag.append(i);
      if (major && k > 0 && k < v.n - D.major / 3) {
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
    // 짝 영상의 시작 · 끝은 점선으로
    const ml = comparing() ? labelOf(mateOf(cur())) : {};
    for (const [el, k] of [[$('#tlMateS'), ml.s], [$('#tlMateE'), ml.e]]) {
      el.style.display = k != null ? 'block' : 'none';
      if (k != null) el.style.left = pct(k);
    }
  }

  function renderMeta() {
    const v = cur();
    const dur = (v.n / FPS).toFixed(2);
    const hint = $('#hint');
    if (IP1) {
      const p = PRIN[v.prin];
      $('#meta').innerHTML = `
        <h2>${v.prin}_${v.quad} · 쌍 ${v.pair} ${plTag(v, 'big')}</h2>
        <div class="file">${v.src}</div>
        <div class="chips">
          <span class="chip cond" style="--c: var(--c-${v.prin})">${v.prin} ${p.ko} · ${p.en}</span>
          <span class="chip">짝 <b>${v.mate}</b></span>
          <span class="chip">${v.n} 프레임 · ${dur} s · ${FPS} fps</span>
        </div>`;
      hint.style.setProperty('--c', `var(--c-${v.prin})`);
      hint.innerHTML = v.pos
        ? `<b>${p.ko} · 가능 영상</b>${POS_HINT}`
        : `<b>${p.ko} 위반 · 불가능 영상</b>${p.hint}`;
      $('#lblStart').textContent = v.pos ? '시작 프레임 (짝의 위반 순간)' : '위반 시작 프레임';
      $('#lblEnd').textContent = v.pos ? '끝 프레임' : '위반 끝 프레임';
      $('#nfText').firstChild.textContent = v.pos ? '구간을 못 정함' : '위반을 못 찾음';
    } else {
      const c = COND[v.cond];
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
      hint.style.setProperty('--c', `var(--c-${v.cond})`);
      hint.innerHTML = `<b>${c.ko} 위반</b>${c.hint}`;
    }
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
    for (const b of document.querySelectorAll('#motionSeg button')) b.classList.toggle('on', b.dataset.mo === l.mo);

    const msg = [];
    if (l.s != null && l.e != null && l.e < l.s) msg.push('끝 프레임이 시작보다 앞입니다.');
    if (l.nf && !(l.note || '').trim()) msg.push('못 찾은 이유를 메모에 적어 주세요.');
    if (!l.nf && l.s != null && l.e == null) msg.push('끝 프레임이 비어 있습니다 (순간 사건이면 I).');
    if (IP1 && !l.mo && (l.s != null || l.e != null || l.nf)) msg.push('물체가 정지인지 움직임인지 골라 주세요.');
    $('#formMsg').textContent = msg.join(' ');

    $('#score').textContent = l.s == null ? ''
      : IP1
        ? `PNG ${png(l.s)}${l.e != null ? ` – ${png(l.e)} · 길이 ${l.e - l.s + 1} 프레임 (${((l.e - l.s + 1) / FPS).toFixed(2)} s)` : ''}`
        : `6 fps 채점 기준 (÷10)  시작 ${(l.s / 10).toFixed(1)}${l.e != null ? ` · 끝 ${(l.e / 10).toFixed(1)} · 길이 ${l.e - l.s + 1} 프레임` : ''}`;
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
  // 줄마다 화면 밖 video 하나로 프레임을 떠 온다. 나란히 볼 때는 짝 영상 줄이 하나 더 있다.

  let stripGen = 0;
  let stripTimer = 0;

  function makeRow(box, vid) {
    const row = { vid, cells: [], cache: new Map(), chain: Promise.resolve(), src: '', v: null };
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
      row.cells.push(c);
    }
    return row;
  }

  const stripMain = makeRow($('#strip'), $('#stripVideo'));
  const stripMate = IP1 ? makeRow($('#stripMate'), $('#stripMateVideo')) : null;
  const stripRows = () => (comparing() ? [stripMain, stripMate] : [stripMain]);

  function resetRow(row, v) {
    row.cache.clear();
    row.chain = Promise.resolve();
    row.v = v;
    row.src = v.src;
    row.vid.src = v.src;
    for (const c of row.cells) {
      c.frame = null;
      c.cv.getContext('2d').clearRect(0, 0, c.cv.width, c.cv.height);
    }
  }

  function resetStrip(v) {
    stripGen++;
    resetRow(stripMain, v);
    if (stripMate) resetRow(stripMate, mateOf(v));
  }

  function scheduleStrip() {
    if (!video.paused || scrubbing) return;
    clearTimeout(stripTimer);
    stripTimer = setTimeout(renderStrip, 70);
  }

  async function renderStrip() {
    const gen = ++stripGen;
    const center = frameNow();
    const rows = stripRows();
    for (const row of rows) {
      for (const c of row.cells) {
        c.frame = center + c.off;
        paintCell(row, c);
      }
    }
    renderStripMarks();
    await Promise.all(rows.map(async (row) => {
      for (const c of [...row.cells].sort((a, b) => Math.abs(a.off) - Math.abs(b.off))) {
        const k = c.frame;
        if (k < 0 || k >= row.v.n || row.cache.has(k)) continue;
        await grab(row, k);
        if (gen !== stripGen) return;
        for (const d of row.cells) if (d.frame === k) paintCell(row, d);
      }
    }));
  }

  function paintCell(row, c) {
    const k = c.frame;
    const out = k < 0 || k >= row.v.n;
    c.el.classList.toggle('out', out);
    if (out) return;
    const ctx = c.cv.getContext('2d');
    const img = row.cache.get(k);
    c.el.classList.toggle('loading', !img);
    if (img) ctx.drawImage(img, 0, 0, c.cv.width, c.cv.height);
    c.cap.innerHTML = `<b>${k}</b><span>${c.off > 0 ? '+' : ''}${c.off || '현재'}</span>`;
  }

  function renderStripMarks() {
    const k = frameNow();
    for (const row of stripRows()) {
      if (!row.v) continue;
      const l = labelOf(row.v);
      for (const c of row.cells) {
        c.el.classList.toggle('cur', c.frame === k);
        c.el.classList.toggle('is-start', c.frame != null && c.frame === l.s);
        c.el.classList.toggle('is-end', c.frame != null && c.frame === l.e);
        c.el.classList.toggle('in-range', c.frame != null && l.s != null && l.e != null && c.frame >= l.s && c.frame <= l.e);
      }
    }
  }

  // 줄마다 한 번에 하나씩: 겹치면 seeked 가 다른 프레임 것으로 섞인다
  function grab(row, k) {
    const p = row.chain.then(() => grabOne(row, k));
    row.chain = p.catch(() => {});
    return p;
  }

  function grabOne(row, k) {
    const src = row.src;
    const vid = row.vid;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        vid.removeEventListener('seeked', onSeeked);
        if (ok && src === row.src) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 192;
          cv.getContext('2d').drawImage(vid, 0, 0, 192, 192);
          row.cache.set(k, cv);
        }
        resolve();
      };
      const onSeeked = () => finish(true);
      const go = () => {
        if (src !== row.src) return finish(false);
        vid.addEventListener('seeked', onSeeked);
        vid.currentTime = (k + 0.5) / FPS;
      };
      setTimeout(() => finish(false), 3000);
      if (vid.readyState >= 1) go();
      else vid.addEventListener('loadedmetadata', go, { once: true });
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
  function setMotion(mo) {
    if (IP1) update({ mo: labelOf(cur()).mo === mo ? '' : mo });
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

  const COLS = IP1
    ? { file: 'video_id', s: 'start_frame', e: 'end_frame', head: ['video_id', 'annotator', 'quadruplet', 'pair_id', 'plausible', 'object_motion', 'start_frame', 'end_frame', 'note', 'not_found', 'updated_at'] }
    : { file: 'file', s: 'violation_start_frame', e: 'violation_end_frame', head: ['file', 'annotator', 'violation_start_frame', 'violation_end_frame', 'note', 'occluded', 'not_found', 'updated_at'] };

  function exportCsv() {
    const cell = (x) => {
      const s = String(x ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = S.list.map((v) => {
      const l = S.labels[v.id] || {};
      const s = l.nf ? '' : l.s ?? '';
      const e = l.nf ? '' : l.e ?? '';
      return IP1
        ? [v.id, S.who, `${v.prin}_${v.quad}`, v.pair, v.pos ? 1 : 0, l.mo || '', s, e, l.note || '', l.nf ? 1 : 0, l.t || '']
        : [v.id, S.who, s, e, l.note || '', l.occ ? 1 : 0, l.nf ? 1 : 0, l.t || ''];
    });
    const csv = '﻿' + [COLS.head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${IP1 ? 'intphys1' : 'intphys2'}_labels_${S.who}_${stamp}.csv`;
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
    if (col[COLS.file] == null || col[COLS.s] == null) return toast(`이 도구가 ${D.name} 에서 내보낸 CSV 가 아닙니다`, true);
    const mine = new Set(S.list.map((v) => v.id));
    const num = (x) => (x == null || x.trim() === '' ? null : Number(x));
    const incoming = {};
    let other = 0;
    for (const r of rows) {
      const id = r[col[COLS.file]];
      if (!mine.has(id)) { other++; continue; }
      const l = {
        s: num(r[col[COLS.s]]),
        e: num(r[col[COLS.e]]),
        note: r[col.note] || '',
        nf: r[col.not_found] === '1',
        t: r[col.updated_at] || new Date().toISOString(),
      };
      if (IP1) l.mo = MO_KO[r[col.object_motion]] ? r[col.object_motion] : '';
      else l.occ = r[col.occluded] === '1';
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
  on('#bCompare', 'click', () => setCompare(!S.compare));
  on('#speed', 'change', (e) => setSpeed(Number(e.target.value)));
  on('#bSetStart', 'click', () => setStart());
  on('#bSetEnd', 'click', () => setEnd());
  on('#bGoStart', 'click', () => { const l = labelOf(cur()); if (l.s != null) seekTo(l.s); });
  on('#bGoEnd', 'click', () => { const l = labelOf(cur()); if (l.e != null) seekTo(l.e); });
  on('#bInstant', 'click', instant);
  on('#motionSeg', 'click', (e) => { const b = e.target.closest('button'); if (b) setMotion(b.dataset.mo); });
  on('#bMateGo', 'click', goMate);
  on('#bMateCopy', 'click', copyMate);
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
  on('#groupFilter', 'change', (e) => { S.group = e.target.value; renderList(); scrollActiveIntoView(); });

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
    const keys = {
      ArrowLeft: () => step(e.shiftKey ? -10 : -1),
      ArrowRight: () => step(e.shiftKey ? 10 : 1),
      ' ': togglePlay,
      s: () => setStart(),
      e: () => setEnd(),
      i: instant,
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
      ...(IP1
        ? { z: () => setMotion('static'), m: () => setMotion('moving'), c: () => setCompare(!S.compare), x: goMate }
        : { o: () => update({ occ: !labelOf(cur()).occ }) }),
    };
    const handled = keys[k.length === 1 ? k.toLowerCase() : k];
    if (handled) {
      e.preventDefault();
      handled();
    }
  });

  // ---------------------------------------------------------------- 시작

  (function init() {
    document.title = `${D.name} 위반 라벨링`;
    // data-set 이 붙은 요소는 그 데이터셋에서만 보인다
    for (const el of document.querySelectorAll('[data-set]')) el.hidden = el.dataset.set !== SET;

    const gf = $('#groupFilter');
    gf.add(new Option(IP1 ? '모든 원리' : '모든 condition', 'all'));
    for (const g of GROUP_ORDER) gf.add(new Option(IP1 ? `${g} ${GROUPS[g].ko} · ${GROUPS[g].en}` : `${GROUPS[g].ko} · ${g}`, g));

    const dl = $(`#guideGroups${IP1 ? '1' : '2'}`);
    for (const g of GROUP_ORDER) {
      const dt = document.createElement('dt');
      dt.style.setProperty('--c', `var(--c-${g})`);
      dt.textContent = IP1 ? `${g} ${GROUPS[g].ko}` : `${GROUPS[g].ko} · ${g}`;
      const dd = document.createElement('dd');
      dd.textContent = GROUPS[g].hint;
      dl.append(dt, dd);
    }

    $('#pickerTitle').textContent = `${D.name} · 작업자를 고르세요`;
    const split = IP1
      ? '묶음 단위 (쌍 2 개 · 영상 4 개) 로 원리마다 고르게 4 명에게 나눴습니다. 같은 쌍의 가능 · 불가능 영상은 한 사람이 같이 봅니다.'
      : '장면 단위 (pair1 · pair2 함께) 로 condition 마다 고르게 4 명에게 나눴습니다.';
    $('#pickerNote').textContent = SYNC_URL
      ? `${split} 라벨은 공유 시트에 자동 저장되니, 다른 컴퓨터에서 열어도 이어서 작업할 수 있습니다.`
      : `${split} 라벨은 이 브라우저에만 자동 저장되니, 같은 브라우저에서 이어서 작업하세요.`;
    if (SYNC_URL) {
      for (const el of document.querySelectorAll('.guide-save')) {
        el.innerHTML = '라벨은 저장할 때마다 공유 시트로 보내집니다. 오른쪽 위가 <b>시트에 저장됨</b> 인지 확인하세요. 연결이 끊겨도 이 브라우저에 남아 있다가 다시 연결되면 보내집니다. CSV 내보내기는 백업용입니다.';
      }
    }

    $('#speed').value = String(store.get(`vlabel:speed:${SET}`, store.get('intphys2-vlabel-v1:speed', 0.5)));
    renderSets();
    if (!HAS_RVFC) toast('이 브라우저는 프레임 단위 표시를 지원하지 않습니다. 최신 Chrome 을 권장합니다.', true);
    initWho();
  })();
})();
