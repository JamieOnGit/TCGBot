// Admin: customers and plans (no access to customers' personal details).
import { $, api, h, toast, when } from './common.js';

const PAGE = 50;
let offset = 0;
let total = 0;

const date = (ts) => (ts ? new Date(ts).toLocaleDateString() : '—');

async function loadStats() {
  const s = await api('GET', '/api/admin/stats');
  const box = $('#stats');
  box.textContent = '';
  const stat = (label, n) => box.append(h('div', { class: 'card stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'muted small' }, label)));
  stat('Customers', s.users);
  stat('Paying', (s.plans.active || 0) + (s.plans.past_due || 0));
  stat('On trial', s.plans.trial || 0);
  stat('Free access', s.plans.comped || 0);
  stat('Sign-ups (7 days)', s.signups7d);
  stat('Watched pages', s.watchedPages);
}

function planText(u) {
  if (u.role === 'admin') return 'Admin';
  if (u.plan === 'trial') return u.trial_ends_at > Date.now() ? `Trial until ${date(u.trial_ends_at)}` : 'Trial ended';
  return { active: 'Subscribed', past_due: 'Payment failed', canceled: 'Cancelled', comped: 'Free access' }[u.plan] || u.plan;
}

async function act(u, body, label) {
  try {
    await api('PUT', `/api/admin/users/${u.id}`, body);
    toast(label, u.email, 'success');
    loadUsers();
    loadAudit();
  } catch (e) {
    toast("Couldn't do that", e.message, 'warn');
  }
}

function actions(u) {
  const plan = h('select', { 'aria-label': `Plan for ${u.email}` },
    ...['trial', 'active', 'past_due', 'canceled', 'comped'].map((p) => h('option', { value: p, selected: p === u.plan }, p)));
  plan.addEventListener('change', () => act(u, { plan: plan.value }, `Plan set to ${plan.value}`));
  return h('div', { class: 'acts status-row' },
    plan,
    h('button', { class: 'btn small', type: 'button', onclick: () => { const d = prompt(`Extend ${u.email}'s trial by how many days?`, '7'); if (d) act(u, { extendTrialDays: Number(d) }, `Trial extended by ${d} days`); } }, '+ Trial'),
    h('button', { class: 'btn small', type: 'button', onclick: () => act(u, { disabled: !u.disabled }, u.disabled ? 'Unsuspended' : 'Suspended') }, u.disabled ? 'Unsuspend' : 'Suspend'),
    h('button', {
      class: 'btn small', type: 'button',
      onclick: async () => { if (confirm(`Sign ${u.email} out everywhere (browsers and extensions)?`)) { await api('POST', `/api/admin/users/${u.id}/signout`); toast('Signed out', u.email, 'success'); loadAudit(); } },
    }, 'Sign out'),
    h('button', {
      class: 'btn small danger', type: 'button',
      onclick: async () => {
        const confirmEmail = prompt(`This deletes ${u.email}'s account and all their data, and cancels their subscription.\nType their email to confirm:`);
        if (confirmEmail === null) return;
        try {
          await api('DELETE', `/api/admin/users/${u.id}`, { confirm: confirmEmail });
          toast('Account deleted', u.email, 'success');
          loadUsers(); loadStats(); loadAudit();
        } catch (e) { toast("Couldn't delete", e.message, 'warn'); }
      },
    }, 'Delete'));
}

async function loadUsers() {
  const q = $('#q').value.trim();
  const r = await api('GET', `/api/admin/users?limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(q)}`);
  total = r.total;
  const body = $('#users');
  body.textContent = '';
  if (!r.users.length) body.append(h('tr', {}, h('td', { colspan: '6', class: 'empty' }, 'No customers found.')));
  for (const u of r.users) {
    body.append(h('tr', { dataset: { id: u.id } },
      h('td', {}, h('b', {}, u.email), u.name ? h('div', { class: 'muted small' }, u.name) : null, u.disabled ? h('span', { class: 'pill err' }, 'Suspended') : null),
      h('td', {}, planText(u), u.stripe_customer_id ? h('div', { class: 'muted small' }, u.stripe_customer_id) : null),
      h('td', {}, date(u.created_at)),
      h('td', {}, u.last_login_at ? when(u.last_login_at) : '—'),
      h('td', { class: 'small' }, `${u.products} products · ${u.watching} watching · ${u.devices} browsers`),
      h('td', {}, actions(u))));
  }
  $('#page-info').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '';
  $('#prev').disabled = offset === 0;
  $('#next').disabled = offset + PAGE >= total;
}

async function loadAudit() {
  const { entries } = await api('GET', '/api/admin/audit');
  const list = $('#audit');
  list.textContent = '';
  if (!entries.length) list.append(h('li', { class: 'empty' }, 'No admin changes yet.'));
  for (const a of entries) list.append(h('li', {}, h('time', {}, when(a.created_at)), h('span', {}, `${a.actor_email || 'system'} — ${a.action}: ${a.detail}`)));
}

$('#search').addEventListener('submit', (e) => { e.preventDefault(); offset = 0; loadUsers(); });
$('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); loadUsers(); });
$('#next').addEventListener('click', () => { offset += PAGE; loadUsers(); });

await Promise.all([loadStats(), loadUsers(), loadAudit()]);
