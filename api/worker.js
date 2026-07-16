/**
 * 30초 해변 플로깅 — 랭킹 + 데이터 활성화 지표 백엔드
 * Cloudflare Worker + D1
 *
 * 바인딩 필요:
 *   - D1 데이터베이스: 변수명 DB
 *   - 환경 변수(Secret): STATS_KEY  (통계 대시보드 접근용 비밀키, 아무 문자열)
 *
 * 엔드포인트:
 *   POST /submit  {uid,nick,score,items,drift,dur}  → 최고 기록 갱신 + {rank,total,best}
 *   GET  /top                                        → 상위 10명
 *   POST /event   {uid,sess,name,data}               → 행동 이벤트 기록
 *   GET  /likes                                      → 좋아요 수(uid 기준 중복 제거)
 *   POST /like    {uid}                              → 좋아요
 *   GET  /stats?key=STATS_KEY                        → 발표용 집계 지표
 */

// 배포 후 Pages 주소가 확정되면 '*' 대신 해당 origin으로 고정 권장
// 예: 'https://beach-plogging.pages.dev'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// 30초 게임에서 물리적으로 가능한 상한 (플레이 검증용)
const MAX_ITEMS = 70;                 // 스폰 간격 최소 430ms → 30초에 ~70개가 절대 상한
const MAX_PER_ITEM = 2500 * 3 * 2;    // 최고 희귀템 2500점 × 드리프트 ×3 × 콤보 ×2
const MIN_DUR = 27000, MAX_DUR = 60000;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS')
      return new Response(null, { headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
    const url = new URL(req.url);
    const p = url.pathname;

    try {
      if (p === '/submit' && req.method === 'POST') return await submit(req, env);
      if (p === '/top' && req.method === 'GET') return await top(env);
      if (p === '/event' && req.method === 'POST') return await event(req, env);
      if (p === '/likes' && req.method === 'GET') return await likes(env);
      if (p === '/like' && req.method === 'POST') return await like(req, env);
      if (p === '/stats' && req.method === 'GET') return await stats(url, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

const BAD_WORDS = ['시발','씨발','씨빨','병신','새끼','개새','지랄','썅','니미','좆','자지','보지','섹스','성교','창녀','fuck','shit','sex'];
function cleanNick(n) {
  let s = String(n || '')
    .replace(/[<>&"']/g, '')
    .replace(/[\u0000-\u001f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim().slice(0, 16); // 최장 자동 닉 '꼬물꼬물검붉은수지맨드라미123' = 16자
  const low = s.toLowerCase();
  if (!s || BAD_WORDS.some((b) => low.includes(b))) s = '익명플로거';
  return s;
}
// 클라이언트와 동일한 표시 태그 (uid 복원 불가, 동명이인 구분용)
function tagOf(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 10 + (h % 90);
}

async function submit(req, env) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.uid !== 'string' || b.uid.length < 8 || b.uid.length > 64)
    return json({ error: 'bad uid' }, 400);

  const score = Math.floor(Number(b.score));
  const items = Math.floor(Number(b.items));
  const drift = Math.floor(Number(b.drift));
  const dur = Math.floor(Number(b.dur));

  // 타당성 검증: 조작된 제출 걸러내기
  if (!Number.isFinite(score) || score < 0) return json({ error: 'bad score' }, 400);
  if (!Number.isFinite(items) || items < 0 || items > MAX_ITEMS) return json({ error: 'implausible items' }, 400);
  if (!Number.isFinite(drift) || drift < 0 || drift > items) return json({ error: 'implausible drift' }, 400);
  if (!Number.isFinite(dur) || dur < MIN_DUR || dur > MAX_DUR) return json({ error: 'implausible duration' }, 400);
  if (score > items * MAX_PER_ITEM) return json({ error: 'implausible score' }, 400);
  if (score > 0 && items === 0) return json({ error: 'implausible' }, 400);

  const nick = cleanNick(b.nick);
  const now = Date.now();

  // 같은 세션의 연속 제출 제한 (15초) — 스크립트 도배 방지
  const prev = await env.DB.prepare('SELECT ts FROM scores WHERE uid = ?1').bind(b.uid).first();
  if (prev && now - prev.ts < 15000) return json({ error: 'too fast' }, 429);

  // 같은 uid의 최고 기록만 유지 (upsert)
  await env.DB.prepare(
    `INSERT INTO scores (uid, nick, score, ts) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(uid) DO UPDATE SET
       nick = ?2,
       score = CASE WHEN excluded.score > scores.score THEN excluded.score ELSE scores.score END,
       ts = ?4`
  ).bind(b.uid, nick, score, now).run();

  // 순위 계산 (최고 기록 기준)
  const me = await env.DB.prepare('SELECT score FROM scores WHERE uid = ?1').bind(b.uid).first();
  const best = me ? me.score : score;
  const r = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM scores WHERE score > ?1) + 1 AS rank, (SELECT COUNT(*) FROM scores) AS total'
  ).bind(best).first();

  return json({ rank: r.rank, total: r.total, best });
}

async function top(env) {
  const [{ results }, cnt] = await Promise.all([
    env.DB.prepare('SELECT uid, nick, score, ts FROM scores ORDER BY score DESC, ts ASC LIMIT 10').all(),
    env.DB.prepare('SELECT COUNT(*) c FROM scores').first(),
  ]);
  // uid는 절대 노출하지 않는다 — 노출되면 타인의 기록을 덮어쓸 수 있음
  const list = results.map((r) => ({ nick: r.nick, score: r.score, ts: r.ts, tag: tagOf(r.uid) }));
  return json({ list, total: cnt.c || 0 });
}

const EVENT_NAMES = new Set([
  'visit', 'game_start', 'replay', 'game_end',
  'rank_submit', 'meis_click', 'svc_click', 'insight_view', 'like', 'reaction', 'share',
]);

async function event(req, env) {
  // beacon은 text/plain으로 오므로 본문을 텍스트로 읽어 파싱 (/event 전용 — 다른 엔드포인트는 req.json() 유지)
  let b = null;
  try { b = JSON.parse(await req.text()); } catch (e) { b = null; }
  if (!b || !EVENT_NAMES.has(b.name)) return json({ error: 'bad event' }, 400);
  if (typeof b.uid !== 'string' || b.uid.length > 64) return json({ error: 'bad uid' }, 400);
  const data = b.data == null ? null : String(b.data).slice(0, 200);
  const sess = String(b.sess || '').slice(0, 32);
  // uid당 하루 300건 상한 — 도배로 인한 D1 쓰기 한도 소진 방지 (초과분은 조용히 무시)
  const dayAgo = Date.now() - 86400000;
  const n = await env.DB.prepare('SELECT COUNT(*) c FROM events WHERE uid = ?1 AND ts > ?2').bind(b.uid, dayAgo).first();
  if ((n.c || 0) >= 300) return json({ ok: true });
  await env.DB.prepare(
    'INSERT INTO events (uid, sess, name, data, ts) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(b.uid, sess, b.name, data, Date.now()).run();
  return json({ ok: true });
}

async function likes(env) {
  const r = await env.DB.prepare(
    "SELECT COUNT(DISTINCT uid) AS c FROM events WHERE name = 'like'"
  ).first();
  return json({ count: r.c || 0 });
}

async function like(req, env) {
  const b = await req.json().catch(() => ({}));
  const uid = typeof b.uid === 'string' ? b.uid.slice(0, 64) : 'anon';
  await env.DB.prepare(
    "INSERT INTO events (uid, sess, name, data, ts) VALUES (?1, '', 'like', NULL, ?2)"
  ).bind(uid, Date.now()).run();
  return json({ ok: true });
}

// ===== 발표용 집계 지표 =====
async function stats(url, env) {
  if (!env.STATS_KEY || url.searchParams.get('key') !== env.STATS_KEY)
    return json({ error: 'unauthorized' }, 401);

  const q = (sql) => env.DB.prepare(sql).first();
  const [
    visits, uniqVisitors,
    starts, ends, replays,
    players, meisUsers, svcUsers, insightSess,
    likesC, shares, shareUsers, submits, reactions, avgScore,
  ] = await Promise.all([
    q("SELECT COUNT(*) c FROM events WHERE name='visit'"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='visit'"),
    q("SELECT COUNT(*) c FROM events WHERE name IN ('game_start','replay')"),
    q("SELECT COUNT(*) c FROM events WHERE name='game_end'"),
    q("SELECT COUNT(*) c FROM events WHERE name='replay'"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='game_end'"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='meis_click'"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='svc_click'"),
    q("SELECT COUNT(DISTINCT sess) c FROM events WHERE name='insight_view'"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='like'"),
    q("SELECT COUNT(*) c FROM events WHERE name='share'"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='share'"),
    q('SELECT COUNT(*) c FROM scores'),
    env.DB.prepare("SELECT data, COUNT(*) c FROM events WHERE name='reaction' GROUP BY data").all(),
    q('SELECT ROUND(AVG(score)) c FROM scores'),
  ]);

  const rx = {};
  for (const row of reactions.results || []) rx[row.data || '?'] = row.c;
  const g = (q, k) => rx[q + ':' + k] || 0;
  const qTot = (q) => g(q, 'new') + g(q, 'vague') + g(q, 'knew');
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

  return json({
    updated: new Date().toISOString(),
    funnel: {
      '방문(페이지뷰)': visits.c,
      '순 방문(세션 기준)': uniqVisitors.c,
      '플레이 시작(총)': starts.c,
      '플레이 완주(총)': ends.c,
      '완주율 %': pct(ends.c, starts.c),
      '순 플레이어(세션 기준)': players.c,
    },
    engagement: {
      '재플레이 수': replays.c,
      '재플레이율 % (총 플레이 중)': pct(replays.c, starts.c),
      '랭킹 등록 수(세션 기준)': submits.c,
      '공유 수(총)': shares.c,
      '공유한 사람(세션 기준)': shareUsers.c,
      '공유율 % (플레이어→공유)': pct(shareUsers.c, players.c),
      '평균 점수': avgScore.c,
    },
    data_activation: {
      'MEIS 데이터 클릭(세션 기준)': meisUsers.c,
      '데이터 전환율 % (플레이어→MEIS 클릭)': pct(meisUsers.c, players.c),
      '예보 서비스 클릭(세션 기준)': svcUsers.c,
      '인사이트 카드 노출(세션)': insightSess.c,
    },
    reaction: {
      'Q1(플라스틱 87.4%) 😲 처음 알았어': g('q1', 'new'),
      'Q1 🤔 어렴풋이': g('q1', 'vague'),
      'Q1 😎 알고 있었어': g('q1', 'knew'),
      'Q1 인지 변화율 %': pct(g('q1', 'new'), qTot('q1')),
      'Q2(데이터 기반 게임) 😲 처음 알았어': g('q2', 'new'),
      'Q2 🤔 어렴풋이': g('q2', 'vague'),
      'Q2 😎 알고 있었어': g('q2', 'knew'),
      'Q2 인지 변화율 %': pct(g('q2', 'new'), qTot('q2')),
      '👍 좋아요(세션 기준)': likesC.c,
    },
  });
}
