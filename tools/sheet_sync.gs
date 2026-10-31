// IntPhys 라벨링 사이트 ↔ 공유 시트.
// 시트에서 확장 프로그램 → Apps Script 에 이 파일 내용을 그대로 붙여넣고, 웹 앱으로 배포한다 (README 참고).
//
// set 은 데이터셋: ip2 (IntPhys 2, labels 탭, 기본값) · ip1 (IntPhys 1, labels_ip1 탭).
//   GET  ?set=ip1&a=B         → { ok, set, labels: { file: { mo, s, e, note, nf, t } } }   (B 의 라벨)
//   GET  ?set=ip1&format=csv  → 라벨이 있는 모든 행 (tools/merge_labels.py 입력)
//   GET  ?ping=1              → { ok, sets: { ip2: 행 수, ip1: 행 수 } }
//   POST { set, labels: [ { file, annotator, s, e, note, nf, t, (ip2) occ, (ip1) mo } ] }
//                             → { ok, set, saved: [file], stale: [file], errors: { file: msg } }
//
// 행은 미리 채워 둔 것뿐이고, 쓰는 칸은 라벨 칸 (ip2 F–K · ip1 H–M) 뿐이다.
// 같은 영상은 updated_at (t) 이 더 늦은 쪽이 이긴다: 시트 쪽이 더 늦으면 stale 로 돌려준다.
// 응답의 set 으로 사이트가 이 스크립트가 그 데이터셋을 아는지 확인한다 (예전 스크립트는 set 을 돌려주지 않음).

var SHEET_ID = '1OZduu13VvKCebp0YZuTc0WEoZaFaBzSxMOwmHNOrEZY';
var SETS = {
  ip2: {
    tab: 'labels',
    C: { file: 0, annotator: 1, n: 4, s: 5, e: 6, note: 7, occ: 8, nf: 9, t: 10 },  // 0-based, A–K
    fields: ['s', 'e', 'note', 'occ', 'nf'],  // 시트에서 이 순서로 붙어 있고 바로 뒤가 t
    csv: ['file', 'annotator', 'violation_start_frame', 'violation_end_frame', 'note', 'occluded', 'not_found', 'updated_at'],
  },
  ip1: {
    tab: 'labels_ip1',
    C: { file: 0, annotator: 1, n: 6, mo: 7, s: 8, e: 9, note: 10, nf: 11, t: 12 },  // A–M
    fields: ['mo', 's', 'e', 'note', 'nf'],
    csv: ['video_id', 'annotator', 'object_motion', 'start_frame', 'end_frame', 'note', 'not_found', 'updated_at'],
  },
};
var MOTIONS = ['', 'static', 'moving'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.ping) {
    var sets = {};
    Object.keys(SETS).forEach(function (k) { sets[k] = readRows_(SETS[k]).length; });
    return json_({ ok: true, sets: sets });
  }
  var key = p.set || 'ip2';
  var S = SETS[key];
  if (!S) return json_({ ok: false, error: '모르는 set: ' + key });
  var C = S.C;
  var rows = readRows_(S);
  if (p.format === 'csv') return csv_(S, rows);
  var labels = {};
  rows.forEach(function (r) {
    if (r[C.annotator] !== p.a || !text_(r[C.t])) return;
    var l = { t: text_(r[C.t]) };
    S.fields.forEach(function (f) { l[f] = fromCell_(f, r[C[f]]); });
    labels[r[C.file]] = l;
  });
  return json_({ ok: true, set: key, labels: labels });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'JSON 이 아닙니다' });
  }
  var key = body.set || 'ip2';
  var S = SETS[key];
  if (!S) return json_({ ok: false, error: '모르는 set: ' + key });
  var C = S.C;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: '시트가 바쁩니다. 잠시 뒤 다시 보냅니다' });
  try {
    var sh = sheet_(S);
    var rows = readRows_(S, sh);
    var at = {};
    rows.forEach(function (r, i) { at[r[C.file]] = i; });
    var out = { ok: true, set: key, saved: [], stale: [], errors: {} };
    (body.labels || []).forEach(function (l) {
      var i = at[l.file];
      if (i === undefined) { out.errors[l.file] = '시트에 없는 영상'; return; }
      var r = rows[i];
      if (r[C.annotator] !== l.annotator) { out.errors[l.file] = '담당자가 ' + r[C.annotator] + ' 입니다'; return; }
      var bad = invalid_(S, l, Number(r[C.n]));
      if (bad) { out.errors[l.file] = bad; return; }
      if (text_(r[C.t]) > l.t) { out.stale.push(l.file); return; }
      var cells = S.fields.map(function (f) { return toCell_(f, l[f]); });
      cells.push(l.t);
      sh.getRange(i + 2, C[S.fields[0]] + 1, 1, cells.length).setValues([cells]);
      out.saved.push(l.file);
    });
    return json_(out);
  } finally {
    lock.releaseLock();
  }
}

function invalid_(S, l, n) {
  var frame = function (x) { return x === null || (typeof x === 'number' && x % 1 === 0 && x >= 0 && x < n); };
  if (!frame(l.s) || !frame(l.e)) return '프레임은 0–' + (n - 1) + ' 정수';
  if (typeof l.note !== 'string' || l.note.length > 2000) return '메모가 너무 깁니다';
  if (typeof l.nf !== 'boolean') return 'nf 형식';
  if (S.C.occ !== undefined && typeof l.occ !== 'boolean') return 'occ 형식';
  if (S.C.mo !== undefined && MOTIONS.indexOf(l.mo) < 0) return 'mo 는 static · moving · 빈 값';
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(String(l.t))) return 'updated_at 형식';
  return '';
}

function toCell_(f, x) {
  if (f === 's' || f === 'e') return x === null ? '' : x;
  if (f === 'occ' || f === 'nf') return x ? 1 : '';
  if (f === 'note') return plain_(x);
  return x;
}

function fromCell_(f, v) {
  if (f === 's' || f === 'e') return num_(v);
  if (f === 'occ' || f === 'nf') return String(v) === '1';
  return String(v);
}

function sheet_(S) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(S.tab);
}

function readRows_(S, sh) {
  sh = sh || sheet_(S);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, S.C.t + 1).getValues().filter(function (r) { return r[S.C.file] !== ''; });
}

// updated_at 열은 서식이 일반 텍스트라 문자열로 남지만, 누가 서식을 바꿔 날짜가 되어도 비교가 되게
function text_(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

function num_(v) {
  return v === '' || v === null ? null : Number(v);
}

// = + - @ 로 시작하는 메모가 수식으로 들어가지 않게
function plain_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function csv_(S, rows) {
  var C = S.C;
  var cell = function (x) {
    var s = String(x === null || x === undefined ? '' : x);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var lines = [S.csv.join(',')];
  rows.forEach(function (r) {
    if (!text_(r[C.t])) return;
    var vals = [r[C.file], r[C.annotator]].concat(S.fields.map(function (f) { return r[C[f]]; }), [text_(r[C.t])]);
    lines.push(vals.map(cell).join(','));
  });
  return ContentService.createTextOutput(lines.join('\r\n') + '\r\n').setMimeType(ContentService.MimeType.CSV);
}
