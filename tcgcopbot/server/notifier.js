// Alerts for one user: their activity feed, their open dashboards, their own
// Discord webhook and their own email — never anyone else's.

import { DEFAULT_ALERTS } from './schema.js';

export class Notifier {
  constructor({ cfg, repo, hub, mailer, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { cfg, repo, hub, mailer, fetch: fetchImpl });
  }

  /**
   * ev: { type, level ('info'|'success'|'warn'|'urgent'), message, title?, name?, sku?, url?,
   *       channel?: 'restock' | 'checkout' — also send to Discord/email per the user's settings }
   */
  async notify(userId, ev) {
    const saved = this.repo.addEvent(userId, ev);
    this.hub.publish(userId, 'event', { ...saved, title: ev.title || null });
    if (!ev.channel) return saved;
    const settings = { ...DEFAULT_ALERTS, ...(this.repo.getData(userId, 'alerts', {}) || {}) };
    const jobs = [];
    if (settings.discordWebhook) jobs.push(this.discord(settings, ev));
    const wantsEmail = ev.channel === 'restock' ? settings.emailOnRestock : settings.emailOnCheckout;
    if (wantsEmail) {
      const user = this.repo.userById(userId);
      if (user) {
        jobs.push(this.mailer.send({
          to: user.email,
          subject: `${this.cfg.appName}: ${ev.title || ev.message}`,
          text: `${ev.title || ''}\n${ev.message}\n${ev.url || ''}\n\nOpen your dashboard: ${this.cfg.baseUrl}/app\nChange alert settings: ${this.cfg.baseUrl}/app#alerts`,
        }));
      }
    }
    await Promise.allSettled(jobs);
    return saved;
  }

  async discord(settings, ev) {
    const color = ev.level === 'urgent' ? 0xe11d48 : ev.level === 'success' ? 0x16a34a : 0x2563eb;
    const body = {
      username: this.cfg.appName,
      content: settings.discordMention ? settings.discordMention : undefined,
      allowed_mentions: { parse: ['users', 'roles'] },
      embeds: [{ title: String(ev.title || ev.message).slice(0, 250), description: String(ev.message).slice(0, 2000), url: ev.url || undefined, color, timestamp: new Date().toISOString() }],
    };
    try {
      await this.fetch(settings.discordWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* Discord down or webhook deleted — the alert is still in the activity feed */
    }
  }
}
