// 로그인 문: ZZON 사이트(promm)와 같은 Supabase 계정으로 들어온다.
// 회원(members 표에 등급이 있는 계정)만 통과. 가입은 ZZON 사이트에서 초대 코드로 한다.
// 주의: 정적 사이트라 화면 잠금일 뿐, 공개 저장소의 코드 자체를 숨기지는 않는다.

const SUPABASE_URL = 'https://psmfizpqfpyxfbygoedo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_WGflck45xCAvjTbLOW8MVQ_-Ngle1cu';
const ROLE_NAMES = { owner: '쭌식', prima: 'ARCH PRIMA', vanguard: 'Vanguard', acolyte: 'Acolyte' };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let sb = null;
function client() {
  if (sb) return sb;
  if (!window.supabase?.createClient) throw new Error('로그인 모듈을 불러오지 못했어요. 새로고침해 주세요.');
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

function friendly(err) {
  const m = err?.message || String(err);
  if (/invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않아요.';
  if (/email not confirmed/i.test(m)) return '이메일 인증이 안 된 계정이에요.';
  if (/failed to fetch|network/i.test(m)) return '로그인 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  return m;
}

function show(html) {
  document.body.classList.add('locked');
  const gate = $('#gate');
  gate.hidden = false;
  gate.querySelector('.gate-body').innerHTML = html;
}

function loginForm(msg = '') {
  show(`<form id="login-form" class="gate-form" autocomplete="on">
      <label class="f">아이디 (이메일)<input type="text" inputmode="email" name="email" autocomplete="username" required></label>
      <label class="f">비밀번호<input type="password" name="password" autocomplete="current-password" required></label>
      <p class="gate-msg" role="alert">${esc(msg)}</p>
      <button type="submit" class="primary">로그인</button>
    </form>
    <p class="muted">ZZON 계정으로 로그인해요. 계정이 없으면 ZZON 사이트에서 초대 코드로 가입해 주세요.</p>`);
  const form = $('#login-form');
  form.email.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    form.classList.add('busy');
    form.querySelector('button').disabled = true;
    try {
      const { error } = await client().auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value });
      if (error) throw error;
      await enter();
    } catch (err) {
      loginForm(friendly(err));
    }
  };
}

function notMember(email) {
  show(`<p class="gate-msg">${esc(email || '이 계정')}은(는) 아직 회원이 아니에요.</p>
    <p class="muted">ZZON 사이트에서 초대 코드를 입력해 회원이 된 뒤 다시 로그인해 주세요.</p>
    <button type="button" class="btn" id="gate-other">다른 계정으로 로그인</button>`);
  $('#gate-other').onclick = logout;
}

async function enter() {
  const { data } = await client().auth.getSession();
  const session = data?.session;
  if (!session) return loginForm();
  const { data: role, error } = await client().rpc('my_role');
  if (error) return loginForm(friendly(error));
  if (!role) return notMember(session.user?.email);
  const nick = (session.user?.user_metadata?.nickname || '').trim();
  $('#who').textContent = nick || ROLE_NAMES[role] || role;
  $('#who').title = session.user?.email || '';
  $('#gate').hidden = true;
  document.body.classList.remove('locked');
  document.dispatchEvent(new CustomEvent('auth:granted', { detail: { role } }));
}

export async function logout() {
  try { await client().auth.signOut(); } catch { /* 무시 */ }
  location.reload();
}

export async function startAuth() {
  document.body.classList.add('locked');
  $('#logout-btn').addEventListener('click', () => { if (confirm('로그아웃할까요?')) logout(); });
  try {
    show('<p class="muted">확인하는 중…</p>');
    await enter();
  } catch (err) {
    loginForm(friendly(err));
  }
}
