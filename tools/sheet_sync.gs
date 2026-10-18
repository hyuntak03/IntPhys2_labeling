// IntPhys 2 라벨링 사이트 ↔ 공유 시트 (labels 탭).
// 시트에서 확장 프로그램 → Apps Script 에 이 파일 내용을 그대로 붙여넣고, 웹 앱으로 배포한다 (README 참고).
//
//   GET  ?a=B            → { ok, labels: { file: { s, e, note, occ, nf, t } } }   (B 의 라벨)
//   GET  ?format=csv     → 라벨이 있는 모든 행 (tools/merge_labels.py 입력)
//   GET  ?ping=1         → { ok, rows }
//   POST { labels: [ { file, annotator, s, e, note, occ, nf, t } ] }
//                        → { ok, saved: [file], stale: [file], errors: { file: msg } }
//
// 행은 미리 채워 둔 506 개뿐이고, 쓰는 칸은 F–K (라벨) 뿐이다.
// 같은 영상은 updated_at (t) 이 더 늦은 쪽이 이긴다: 시트 쪽이 더 늦으면 stale 로 돌려준다.

var SHEET_ID = '1OZduu13VvKCebp0YZuTc0WEoZaFaBzSxMOwmHNOrEZY';
var TAB = 'labels';
var C = { file: 0, annotator: 1, n: 4, s: 5, e: 6, note: 7, occ: 8, nf: 9, t: 10 };  // 0-based, A–K
var NCOL = 11;
var CSV_HEAD = ['file', 'annotator', 'violation_start_frame', 'violation_end_frame', 'note', 'occluded', 'not_found', 'updated_at'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  var rows = readRows_();
  if (p.ping) return json_({ ok: true, rows: rows.length });
  if (p.format === 'csv') return csv_(rows);
  var labels = {};
  rows.forEach(function (r) {
    if (r[C.annotator] !== p.a || !text_(r[C.t])) return;
    labels[r[C.file]] = {
      s: num_(r[C.s]), e: num_(r[C.e]), note: String(r[C.note]),
      occ: String(r[C.occ]) === '1', nf: String(r[C.nf]) === '1', t: text_(r[C.t]),
    };
  });
  return json_({ ok: true, labels: labels });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'JSON 이 아닙니다' });
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: '시트가 바쁩니다. 잠시 뒤 다시 보냅니다' });
  try {
    var sh = sheet_();
    var rows = readRows_(sh);
    var at = {};
    rows.forEach(function (r, i) { at[r[C.file]] = i; });
    var out = { ok: true, saved: [], stale: [], errors: {} };
    (body.labels || []).forEach(function (l) {
      var i = at[l.file];
      if (i === undefined) { out.errors[l.file] = '시트에 없는 영상'; return; }
      var r = rows[i];
      if (r[C.annotator] !== l.annotator) { out.errors[l.file] = '담당자가 ' + r[C.annotator] + ' 입니다'; return; }
      var bad = invalid_(l, Number(r[C.n]));
      if (bad) { out.errors[l.file] = bad; return; }
      if (text_(r[C.t]) > l.t) { out.stale.push(l.file); return; }
      sh.getRange(i + 2, C.s + 1, 1, 6).setValues([[
        l.s === null ? '' : l.s, l.e === null ? '' : l.e, plain_(l.note), l.occ ? 1 : '', l.nf ? 1 : '', l.t,
      ]]);
      out.saved.push(l.file);
    });
    return json_(out);
  } finally {
    lock.releaseLock();
  }
}

function invalid_(l, n) {
  var frame = function (x) { return x === null || (typeof x === 'number' && x % 1 === 0 && x >= 0 && x < n); };
  if (!frame(l.s) || !frame(l.e)) return '프레임은 0–' + (n - 1) + ' 정수';
  if (typeof l.note !== 'string' || l.note.length > 2000) return '메모가 너무 깁니다';
  if (typeof l.occ !== 'boolean' || typeof l.nf !== 'boolean') return 'occ · nf 형식';
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(String(l.t))) return 'updated_at 형식';
  return '';
}

function sheet_() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB);
}

function readRows_(sh) {
  sh = sh || sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, NCOL).getValues().filter(function (r) { return r[C.file] !== ''; });
}

// K 열은 서식이 일반 텍스트라 문자열로 남지만, 누가 서식을 바꿔 날짜가 되어도 비교가 되게
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

function csv_(rows) {
  var cell = function (x) {
    var s = String(x === null || x === undefined ? '' : x);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  var lines = [CSV_HEAD.join(',')];
  rows.forEach(function (r) {
    if (!text_(r[C.t])) return;
    lines.push([r[C.file], r[C.annotator], r[C.s], r[C.e], r[C.note], r[C.occ], r[C.nf], text_(r[C.t])].map(cell).join(','));
  });
  return ContentService.createTextOutput(lines.join('\r\n') + '\r\n').setMimeType(ContentService.MimeType.CSV);
}
