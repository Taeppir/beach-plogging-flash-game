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
    .trim().slice(0, 24); // 최장 자동 닉 '꼬물꼬물검붉은수지맨드라미123'이 16자 — 딱 맞추면 직접 입력·종 추가 시 뒤가 잘려 여유를 둔다
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

// 여기 없는 name은 400으로 거절된다. 프론트의 track()은 응답을 안 보므로(sendBeacon)
// 빠뜨리면 조용히 전부 유실된다 — 이벤트를 새로 쏘기 전에 반드시 여기부터 추가할 것.
const EVENT_NAMES = new Set([
  'visit', 'game_start', 'replay', 'game_end',
  'rank_submit', 'meis_click', 'svc_click', 'insight_view', 'like', 'reaction', 'share', 'quiz',
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

// uid당 1행만 남긴다 — likes()가 COUNT(DISTINCT uid)라 중복 행은 집계에 안 잡히면서
// D1 쓰기 한도만 갉아먹는다. 같은 uid의 재요청은 조용히 무시(응답은 동일).
async function like(req, env) {
  const b = await req.json().catch(() => ({}));
  const uid = typeof b.uid === 'string' ? b.uid.slice(0, 64) : 'anon';
  await env.DB.prepare(
    `INSERT INTO events (uid, sess, name, data, ts)
     SELECT ?1, '', 'like', NULL, ?2
     WHERE NOT EXISTS (SELECT 1 FROM events WHERE uid = ?1 AND name = 'like')`
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
    cardShares, cardShareUsers, linkShares, linkShareUsers,
    quizRows, quizUsers, quizFinishers,
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
    // 결과 카드 공유(inviteBtn)와 하단 링크 공유(linkShareBtn)는 track의 data 값으로만 갈린다.
    //   카드 = 'image'|'native'|'copy'   링크 = 'link_native'|'link_copy'
    // LIKE 'link_%' 대신 IN을 쓴다 — SQL LIKE에선 '_'가 한 글자 와일드카드라 의도보다 넓게 잡힌다.
    // 새 공유 종류를 추가하면 여기 목록에도 넣어야 한다. 안 넣으면 '공유 수(총)'과 둘의 합이 어긋나는 것으로 드러난다.
    q("SELECT COUNT(*) c FROM events WHERE name='share' AND data IN ('image','native','copy')"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='share' AND data IN ('image','native','copy')"),
    q("SELECT COUNT(*) c FROM events WHERE name='share' AND data IN ('link_native','link_copy')"),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='share' AND data IN ('link_native','link_copy')"),
    env.DB.prepare("SELECT data, COUNT(*) c FROM events WHERE name='quiz' GROUP BY data").all(),
    q("SELECT COUNT(DISTINCT uid) c FROM events WHERE name='quiz'"),
    // 3문항 완주자 — data 앞 2자가 문항 id('q1'…)라 substr로 뗀다. 같은 문항을 두 번 답할 수
    // 없으므로(프론트가 잠금) DISTINCT는 사실상 방어용. 문항이 늘면 이 3도 같이 올려야 한다.
    q("SELECT COUNT(*) c FROM (SELECT uid FROM events WHERE name='quiz' GROUP BY uid HAVING COUNT(DISTINCT substr(data, 1, 2)) >= 3)"),
  ]);

  const rx = {};
  for (const row of reactions.results || []) rx[row.data || '?'] = row.c;
  const g = (q, k) => rx[q + ':' + k] || 0;
  const qTot = (q) => g(q, 'new') + g(q, 'vague') + g(q, 'knew');
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

  // ===== 퀴즈 — payload는 'qid:choice:correct|wrong' 3단 =====
  // 정답 여부가 payload에 실려 오므로 여기서 '무엇이 정답인지' 알 필요가 없다.
  // 정답키는 index.html의 QUIZ.ans 한 곳에만 있고, 이 파일은 절대 그걸 복제하지 않는다.
  const qz = {}; // {q1:{tot, correct, wrong:{보기코드:건수}}}
  for (const row of quizRows.results || []) {
    const p = String(row.data || '').split(':');
    if (p.length !== 3) continue; // 3단이 아닌 건 옛 형식이거나 조작 — 집계에서 뺀다
    const [qid, choice, verdict] = p;
    if (!qz[qid]) qz[qid] = { tot: 0, correct: 0, wrong: {} };
    qz[qid].tot += row.c;
    if (verdict === 'correct') qz[qid].correct += row.c;
    else qz[qid].wrong[choice] = (qz[qid].wrong[choice] || 0) + row.c;
  }
  const qzOf = (id) => qz[id] || { tot: 0, correct: 0, wrong: {} };
  const qzRate = (id) => pct(qzOf(id).correct, qzOf(id).tot);
  const qzWrong = (id, c) => qzOf(id).wrong[c] || 0;
  const qzWrongTot = (id) => Object.values(qzOf(id).wrong).reduce((s, n) => s + n, 0);

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
    // 공유율의 분모가 둘로 갈리는 이유: 카드 공유는 결과 화면에만 있어 플레이어의 부분집합이지만,
    // 링크 공유 버튼은 하단 프로모 카드에 있어 게임을 안 해도 누를 수 있다. 둘을 합쳐 플레이어로
    // 나누면 100%를 넘을 수 있다 — 퀴즈 참여율이 방문을 분모로 두는 것과 같은 이유(아래 주석).
    engagement: {
      '재플레이 수': replays.c,
      '재플레이율 % (총 플레이 중)': pct(replays.c, starts.c),
      '랭킹 등록 수(세션 기준)': submits.c,
      '공유 수(총)': shares.c,
      '카드 공유 수 (결과 화면)': cardShares.c,
      '링크 공유 수 (하단 버튼)': linkShares.c,
      '공유한 사람(세션 기준)': shareUsers.c,
      '카드 공유율 % (플레이어→카드 공유)': pct(cardShareUsers.c, players.c),
      '링크 공유율 % (방문→링크 공유)': pct(linkShareUsers.c, uniqVisitors.c),
      '평균 점수': avgScore.c,
    },
    data_activation: {
      'MEIS 데이터 클릭(세션 기준)': meisUsers.c,
      '데이터 전환율 % (플레이어→MEIS 클릭)': pct(meisUsers.c, players.c),
      '예보 서비스 클릭(세션 기준)': svcUsers.c,
      '인사이트 카드 노출(세션)': insightSess.c,
    },
    // 분모는 키 이름에 적어둔다(기존 '데이터 전환율 % (플레이어→MEIS 클릭)'과 같은 방식).
    // 퀴즈는 게임을 안 해도 풀 수 있어 응답자가 플레이어의 부분집합이 아니다 — 플레이어를 분모로
    // 쓰면 참여율이 100%를 넘을 수 있어, 방문(모든 응답자를 포함하는 유일한 집합)을 분모로 둔다.
    quiz: {
      'Q1 정답률 %': qzRate('q1'),
      'Q2 정답률 %': qzRate('q2'),
      'Q3 정답률 %': qzRate('q3'),
      // 아래 두 줄만 q2의 보기 코드를 알고 있다(정답이 아니라 '선택지가 무엇인가'뿐).
      // q2 보기가 바뀌면 이 행이 0·—으로 떨어지는 것으로 드러난다.
      'Q2 오답-유리': qzWrong('q2', 'glass'),
      'Q2 오답-유리 % (오답 중)': pct(qzWrong('q2', 'glass'), qzWrongTot('q2')),
      'Q2 오답-고무': qzWrong('q2', 'rubber'),
      'Q2 오답-고무 % (오답 중)': pct(qzWrong('q2', 'rubber'), qzWrongTot('q2')),
      '퀴즈 응답(세션 기준)': quizUsers.c,
      '3문항 완주(세션 기준)': quizFinishers.c,
      '퀴즈 참여율 % (방문→응답)': pct(quizUsers.c, uniqVisitors.c),
      '퀴즈 완주율 % (응답자 중 3문항)': pct(quizFinishers.c, quizUsers.c),
    },
    // 설문은 1문항(q1 = 데이터 기반 게임 인지). 라벨의 'Q1'은 index.html RQ의 id를 따라간 것이라
    // 문항 내용을 바꾸면 이 괄호 설명도 같이 바꿔야 한다 — 여기 라벨이 유일한 '무엇을 물었나' 기록이다.
    reaction: {
      'Q1(데이터 기반 게임) 😲 처음 알았어': g('q1', 'new'),
      'Q1 🤔 어렴풋이': g('q1', 'vague'),
      'Q1 😎 알고 있었어': g('q1', 'knew'),
      'Q1 인지 변화율 %': pct(g('q1', 'new'), qTot('q1')),
      '👍 좋아요(세션 기준)': likesC.c,
    },
  });
}
