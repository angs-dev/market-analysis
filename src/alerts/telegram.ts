/**
 * Telegram channel. Entirely optional — absent credentials mean the channel
 * reports itself unconfigured and the AlertEngine simply skips it.
 *
 * Credentials come from the environment only, are never logged, and are never
 * written to the database.
 */

import type { AlertChannel, AlertMessage } from './engine.ts';

export const TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';
export const CHAT_ENV = 'TELEGRAM_CHAT_ID';

export interface TelegramOptions {
  token?: string | undefined;
  chatId?: string | undefined;
  /** Injected for testing; defaults to global fetch. */
  fetcher?: typeof fetch;
}

/** Removes anything token-shaped from text before it can reach a log. */
export function redactTelegram(text: string, token?: string): string {
  let out = text;
  if (token && token.length > 0) out = out.split(token).join('[REDACTED]');
  return out
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/(bot)\d{6,}:[A-Za-z0-9_-]{20,}/gi, '$1[REDACTED]');
}

export class TelegramChannel implements AlertChannel {
  readonly name = 'telegram';
  readonly #token: string | undefined;
  readonly #chatId: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(opts: TelegramOptions = {}) {
    this.#token = opts.token ?? process.env[TOKEN_ENV];
    this.#chatId = opts.chatId ?? process.env[CHAT_ENV];
    this.#fetch = opts.fetcher ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.#token && this.#chatId);
  }

  async send(message: AlertMessage): Promise<void> {
    if (!this.isConfigured()) throw new Error('telegram channel is not configured');

    const url = `https://api.telegram.org/bot${this.#token}/sendMessage`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.#chatId,
        text: `${message.title}\n\n${message.body}`,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const detail = redactTelegram(await response.text().catch(() => ''), this.#token).slice(0, 200);
      throw new Error(`telegram send failed with HTTP ${response.status}: ${detail}`);
    }
  }
}
