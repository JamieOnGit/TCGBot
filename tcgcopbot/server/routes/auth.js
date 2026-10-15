// Sign up, log in, log out, password reset, account settings.

import { dummyVerify, hashPassword, verifyPassword } from '../crypto.js';
import { cookie } from '../http.js';
import { STARTER_PRODUCTS } from '../presets.js';
import { HttpError, bad, email as checkEmail, password as checkPassword, product as checkProduct, str } from '../schema.js';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

export function sessionCookieName(cfg) {
  return cfg.secureCookies ? '__Host-tcb_session' : 'tcb_session';
}

export function startSession(ctx, req, user) {
  const token = ctx.repo.createSession(user.id, req.headers['user-agent'] || '');
  req.setCookie(cookie(sessionCookieName(ctx.cfg), token, { maxAge: ctx.cfg.sessionDays * 24 * 60 * 60, secure: ctx.cfg.secureCookies }));
  ctx.repo.updateUser(user.id, { last_login_at: ctx.repo.now() });
}

function clearSession(ctx, req) {
  req.setCookie(cookie(sessionCookieName(ctx.cfg), '', { maxAge: 0, secure: ctx.cfg.secureCookies }));
}

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at };
}

export function seedStarterList(repo, userId) {
  for (const p of STARTER_PRODUCTS) repo.addProduct(userId, checkProduct(p));
}

export function register(router, ctx) {
  const { cfg, repo, limiter } = ctx;

  router.post('/api/auth/signup', async (req) => {
    if (!cfg.signupsOpen) throw new HttpError(403, 'Sign-ups are closed at the moment');
    if (!limiter.hit(`signup:${req.ip}`, cfg.limits.signupsPerHour, 60 * MIN)) throw new HttpError(429, 'Too many sign-ups from your network — try again later');
    const email = checkEmail(req.body.email);
    const password = checkPassword(req.body.password);
    if (!req.body.acceptTerms) throw bad('Please accept the Terms of Service and Privacy Policy');
    if (repo.userByEmail(email)) throw new HttpError(409, 'An account with that email already exists — log in instead');
    const user = repo.createUser({
      email,
      name: str(req.body.name, 80),
      passwordHash: await hashPassword(password),
      role: cfg.adminEmails.includes(email) ? 'admin' : 'user',
      trialEndsAt: repo.now() + cfg.trialDays * DAY,
    });
    seedStarterList(repo, user.id);
    repo.addEvent(user.id, { type: 'account', level: 'success', message: `Welcome to ${cfg.appName}! Your ${cfg.trialDays}-day free trial has started.` });
    startSession(ctx, req, user);
    return { user: publicUser(user) };
  }, { auth: 'none' });

  router.post('/api/auth/login', async (req) => {
    const email = str(req.body.email, 254).toLowerCase();
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    if (limiter.peek(`login-ip:${req.ip}`) >= 30 || limiter.peek(`login-email:${email}`) >= 10) {
      throw new HttpError(429, 'Too many attempts — wait 15 minutes, or reset your password');
    }
    const user = repo.userByEmail(email);
    const ok = user ? await verifyPassword(pw, user.password_hash) : await dummyVerify(pw);
    if (!ok || !user) {
      limiter.hit(`login-ip:${req.ip}`, 30, 15 * MIN);
      limiter.hit(`login-email:${email}`, 10, 15 * MIN);
      throw new HttpError(401, 'Wrong email or password');
    }
    if (user.disabled) throw new HttpError(403, 'This account has been suspended — contact support');
    limiter.clear(`login-email:${email}`);
    let u = user;
    if (cfg.adminEmails.includes(user.email) && user.role !== 'admin') u = repo.updateUser(user.id, { role: 'admin' });
    startSession(ctx, req, u);
    return { user: publicUser(u) };
  }, { auth: 'none' });

  router.post('/api/auth/logout', async (req) => {
    repo.deleteSession(req.sessionToken);
    clearSession(ctx, req);
    return { ok: true };
  }, { auth: 'optional' });

  router.post('/api/auth/forgot', async (req) => {
    const email = str(req.body.email, 254).toLowerCase();
    const allowed = limiter.hit(`forgot-ip:${req.ip}`, 10, 60 * MIN) && limiter.hit(`forgot-email:${email}`, 3, 60 * MIN);
    const user = allowed ? repo.userByEmail(email) : null;
    if (user && !user.disabled) {
      const token = repo.createReset(user.id);
      await ctx.mailer.send({
        to: user.email,
        subject: `Reset your ${cfg.appName} password`,
        text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nChoose a new password here (the link works for 1 hour):\n${cfg.baseUrl}/reset?token=${token}\n\nIf it wasn't you, ignore this email — your password hasn't changed.`,
      });
    }
    // Same answer whether or not the email has an account.
    return { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  }, { auth: 'none' });

  router.post('/api/auth/reset', async (req) => {
    if (!limiter.hit(`reset-ip:${req.ip}`, 20, 60 * MIN)) throw new HttpError(429, 'Too many attempts — try again later');
    const password = checkPassword(req.body.password);
    const userId = repo.useReset(str(req.body.token, 200));
    if (!userId) throw bad('That reset link has expired or was already used — ask for a new one');
    const user = repo.updateUser(userId, { password_hash: await hashPassword(password) });
    // Sign out everywhere, including connected extensions.
    repo.deleteSessions(userId);
    repo.listDevices(userId).forEach((d) => repo.deleteDevice(userId, d.id));
    repo.addEvent(userId, { type: 'account', level: 'warn', message: 'Your password was reset. All browsers and extensions were signed out.' });
    startSession(ctx, req, user);
    return { ok: true };
  }, { auth: 'none' });

  // --- Account settings ------------------------------------------------------
  router.put('/api/me', async (req) => {
    const user = repo.updateUser(req.user.id, { name: str(req.body.name, 80) });
    return { user: publicUser(user) };
  });

  router.post('/api/me/password', async (req) => {
    if (!limiter.hit(`pw:${req.user.id}`, 10, 15 * MIN)) throw new HttpError(429, 'Too many attempts — try again later');
    if (!(await verifyPassword(req.body.current || '', req.user.password_hash))) throw bad('Your current password is wrong');
    const next = checkPassword(req.body.next);
    repo.updateUser(req.user.id, { password_hash: await hashPassword(next) });
    repo.deleteSessions(req.user.id, req.sessionHash);
    repo.addEvent(req.user.id, { type: 'account', level: 'info', message: 'Password changed. Other browsers were signed out.' });
    return { ok: true };
  });

  router.get('/api/me/export', async (req) => {
    const data = repo.exportUser(req.user.id);
    return {
      $raw: Buffer.from(JSON.stringify(data, null, 2)),
      type: 'application/json; charset=utf-8',
      headers: { 'content-disposition': `attachment; filename="${cfg.appName.toLowerCase()}-my-data.json"` },
    };
  });

  router.post('/api/me/delete', async (req) => {
    if (!(await verifyPassword(req.body.password || '', req.user.password_hash))) throw bad('Enter your password to delete your account');
    if (req.user.stripe_subscription_id && ['active', 'past_due'].includes(req.user.plan)) {
      await ctx.billing.cancelNow(req.user).catch(() => {
        throw new HttpError(502, "Couldn't cancel your subscription with the payment provider — try again, or cancel it under Billing first");
      });
    }
    ctx.hub.disconnectUser(req.user.id);
    repo.deleteUser(req.user.id);
    clearSession(ctx, req);
    return { ok: true };
  });
}
