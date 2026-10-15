// Outgoing email (password resets, restock alerts) through Resend's HTTP API.
// Without RESEND_API_KEY, emails are written to the server log instead, which
// is handy on your own computer but means password resets won't reach people.

export class Mailer {
  constructor(cfg, fetchImpl = globalThis.fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
  }

  get configured() {
    return !!(this.cfg.email.resendApiKey && this.cfg.email.from) || !!this.cfg.email.outbox;
  }

  async send({ to, subject, text }) {
    const msg = { to, subject, text };
    if (this.cfg.email.outbox) {
      this.cfg.email.outbox.push(msg);
      return true;
    }
    if (!this.cfg.email.resendApiKey || !this.cfg.email.from) {
      this.cfg.log(`[email not sent — set RESEND_API_KEY and EMAIL_FROM] to=${to} subject="${subject}"\n${text}`);
      return false;
    }
    try {
      const res = await this.fetch(`${this.cfg.email.apiBase}/emails`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.email.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.cfg.email.from, to: [to], subject, text }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) this.cfg.log(`[email] Resend refused the message: HTTP ${res.status}`);
      return res.ok;
    } catch (e) {
      this.cfg.log(`[email] couldn't send: ${e.message}`);
      return false;
    }
  }
}
