// Log in, sign up, forgot password, reset password.
import { $, api, busy, setMsg } from './common.js';

const mode = location.pathname.replace(/^\/+|\/+$/g, '') || 'login';
const form = document.getElementById(mode);
if (form) form.hidden = false;
document.title = `${{ login: 'Log in', signup: 'Sign up', forgot: 'Reset password', reset: 'New password' }[mode] || 'Log in'} — ${document.title}`;

function next() {
  const n = new URLSearchParams(location.search).get('next') || '/app';
  return /^\/[^/\\]/.test(n) ? n : '/app'; // only our own pages
}

const values = (f) => Object.fromEntries(new FormData(f).entries());

$('#login').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      await api('POST', '/api/auth/login', values(e.target));
      location.href = next();
    } catch (err) {
      setMsg($('#li-msg'), err.message);
    }
  });
});

$('#signup').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      const v = values(e.target);
      await api('POST', '/api/auth/signup', { ...v, acceptTerms: $('#su-terms').checked });
      location.href = '/app?welcome=1';
    } catch (err) {
      setMsg($('#su-msg'), err.message);
    }
  });
});

$('#forgot').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      const r = await api('POST', '/api/auth/forgot', values(e.target));
      setMsg($('#fp-msg'), r.message, true);
    } catch (err) {
      setMsg($('#fp-msg'), err.message);
    }
  });
});

$('#reset').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.target, async () => {
    try {
      const token = new URLSearchParams(location.search).get('token') || '';
      await api('POST', '/api/auth/reset', { token, password: values(e.target).password });
      setMsg($('#rp-msg'), 'Password saved — taking you to your dashboard…', true);
      setTimeout(() => { location.href = '/app'; }, 800);
    } catch (err) {
      setMsg($('#rp-msg'), err.message);
    }
  });
});
