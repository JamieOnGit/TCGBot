// Admin: run the business. Admins see accounts, plans and counts — never
// anyone's address, product list, watchlist or activity. Every change is
// written to the audit log.

import { HttpError, bad, num } from '../schema.js';

const DAY = 24 * 60 * 60 * 1000;
const PLANS = ['trial', 'active', 'past_due', 'canceled', 'comped'];

export function register(router, ctx) {
  const { repo } = ctx;
  const target = (id) => {
    const u = repo.userById(id);
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  };

  router.get('/api/admin/stats', async () => repo.stats(), { auth: 'admin' });

  router.get('/api/admin/users', async (req) => repo.listUsers({
    q: String(req.query.get('q') || '').slice(0, 100),
    limit: num(req.query.get('limit'), { min: 1, max: 200, def: 50, int: true }),
    offset: num(req.query.get('offset'), { min: 0, def: 0, int: true }),
  }), { auth: 'admin' });

  router.put('/api/admin/users/:id', async (req) => {
    const u = target(req.params.id);
    const fields = {};
    const changes = [];
    if (req.body.plan !== undefined) {
      if (!PLANS.includes(req.body.plan)) throw bad('Unknown plan');
      fields.plan = req.body.plan;
      changes.push(`plan ${u.plan} → ${req.body.plan}`);
    }
    if (req.body.extendTrialDays !== undefined) {
      const days = num(req.body.extendTrialDays, { min: 1, max: 365, int: true });
      if (!days) throw bad('Days must be 1–365');
      fields.trial_ends_at = Math.max(repo.now(), u.trial_ends_at || 0) + days * DAY;
      if (u.plan === 'canceled' || u.plan === 'trial') fields.plan = 'trial';
      changes.push(`trial +${days} days`);
    }
    if (req.body.disabled !== undefined) {
      if (u.id === req.user.id) throw bad("You can't suspend your own account");
      fields.disabled = req.body.disabled ? 1 : 0;
      changes.push(req.body.disabled ? 'suspended' : 'unsuspended');
    }
    if (req.body.role !== undefined) {
      if (!['user', 'admin'].includes(req.body.role)) throw bad('Unknown role');
      if (u.id === req.user.id && req.body.role !== 'admin') throw bad("You can't remove your own admin access");
      fields.role = req.body.role;
      changes.push(`role ${u.role} → ${req.body.role}`);
    }
    if (!changes.length) throw bad('Nothing to change');
    const updated = repo.updateUser(u.id, fields);
    if (fields.disabled) {
      repo.deleteSessions(u.id);
      ctx.hub.disconnectUser(u.id);
    }
    repo.audit(req.user.id, u.id, 'update-user', `${u.email}: ${changes.join(', ')}`);
    return { user: { id: updated.id, email: updated.email, plan: updated.plan, role: updated.role, disabled: !!updated.disabled, trial_ends_at: updated.trial_ends_at } };
  }, { auth: 'admin' });

  router.post('/api/admin/users/:id/signout', async (req) => {
    const u = target(req.params.id);
    repo.deleteSessions(u.id);
    repo.listDevices(u.id).forEach((d) => repo.deleteDevice(u.id, d.id));
    ctx.hub.disconnectUser(u.id);
    repo.audit(req.user.id, u.id, 'sign-out-user', u.email);
    return { ok: true };
  }, { auth: 'admin' });

  router.delete('/api/admin/users/:id', async (req) => {
    const u = target(req.params.id);
    if (u.id === req.user.id) throw bad('Delete your own account from Account settings instead');
    if (req.body.confirm !== u.email) throw bad('Type the email address to confirm');
    if (u.stripe_subscription_id && ['active', 'past_due'].includes(u.plan)) await ctx.billing.cancelNow(u);
    ctx.hub.disconnectUser(u.id);
    repo.deleteUser(u.id);
    repo.audit(req.user.id, u.id, 'delete-user', u.email);
    return { ok: true };
  }, { auth: 'admin' });

  router.get('/api/admin/audit', async () => ({ entries: repo.listAudit(200) }), { auth: 'admin' });
}
