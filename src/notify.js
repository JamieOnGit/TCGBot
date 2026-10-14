// Alerts: dashboard (sound + desktop notification via the browser) and Discord.

const COLORS = { urgent: 0x22c55e, success: 0x22c55e, warning: 0xf59e0b, error: 0xef4444, info: 0x3b82f6 };

export class Notifier {
  /**
   * @param {{bus: import('./log.js').Bus, getSettings: () => object, fetchImpl?: Function}} opts
   */
  constructor({ bus, getSettings, fetchImpl = globalThis.fetch }) {
    this.bus = bus;
    this.getSettings = getSettings;
    this.fetchImpl = fetchImpl;
    this.queue = Promise.resolve();
  }

  /**
   * @param {{level?: 'urgent'|'success'|'warning'|'error'|'info', title: string, message?: string, url?: string, itemId?: string, fields?: Array<{name:string,value:string}>}} a
   */
  alert(a) {
    const alert = { level: 'info', message: '', ...a, ts: Date.now() };
    this.bus.log(alert.level === 'error' ? 'error' : alert.level === 'warning' ? 'warn' : alert.level === 'info' ? 'info' : 'success',
      `${alert.title}${alert.message ? ` — ${alert.message}` : ''}`, { itemId: alert.itemId });
    this.bus.emit('alert', alert);
    const { discordWebhook } = this.getSettings();
    if (discordWebhook) this.queue = this.queue.then(() => this.sendDiscord(alert)).catch(() => {});
    return alert;
  }

  async sendDiscord(alert) {
    const { discordWebhook, discordMention } = this.getSettings();
    if (!discordWebhook) return { ok: false, reason: 'no webhook' };
    const ping = (alert.level === 'urgent' || alert.level === 'warning') && discordMention ? `${discordMention} ` : '';
    const body = {
      username: 'TCGBot',
      content: `${ping}${alert.title}`.slice(0, 1900),
      embeds: [{
        title: alert.title.slice(0, 250),
        description: (alert.message || '').slice(0, 2000),
        url: alert.url || undefined,
        color: COLORS[alert.level] ?? COLORS.info,
        fields: (alert.fields || []).slice(0, 10).map((f) => ({ name: String(f.name).slice(0, 250), value: String(f.value || '-').slice(0, 1000), inline: true })),
        timestamp: new Date(alert.ts || Date.now()).toISOString(),
      }],
      allowed_mentions: { parse: ['users', 'roles', 'everyone'] },
    };
    try {
      const res = await this.fetchImpl(discordWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        this.bus.log('warn', `Discord webhook returned HTTP ${res.status}`);
        return { ok: false, status: res.status };
      }
      return { ok: true };
    } catch (e) {
      this.bus.log('warn', `Discord webhook failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  }
}
