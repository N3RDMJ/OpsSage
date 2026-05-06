import { fetchJson, HttpError } from './http.js';

export interface SlackConfig {
  botToken: string;
}

export interface SlackMessage {
  ts: string;
  channel: string;
  text?: string;
  thread_ts?: string;
}

/**
 * Direct Slack Web API wrapper. The plan calls for chat-sdk.dev as the
 * abstraction; this is the underlying adapter it would call. Keeping it
 * direct now means dev with no adapter packages installed.
 */
export class SlackClient {
  private readonly headers: HeadersInit;

  constructor(cfg: SlackConfig) {
    this.headers = {
      Authorization: `Bearer ${cfg.botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  postMessage(input: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: unknown[];
  }): Promise<SlackPostMessageResponse> {
    return this.call<SlackPostMessageResponse>('chat.postMessage', input);
  }

  /** Find the Slack message Datadog posted by URL substring (the alert link). */
  async findMessageByLink(channel: string, alertUrl: string): Promise<SlackMessage | undefined> {
    const res = await fetchJson<SlackHistoryResponse>(
      `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=50`,
      { headers: this.headers },
    );
    if (!res.ok) throw new Error(`slack conversations.history: ${res.error}`);
    const needle = alertUrl.split('?')[0] ?? alertUrl;
    return res.messages?.find((m) => (m.text ?? '').includes(needle));
  }

  private async call<T extends { ok: boolean; error?: string }>(
    method: string,
    body: unknown,
  ): Promise<T> {
    const res = await fetchJson<T>(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new HttpError(200, `slack/${method}`, JSON.stringify(res));
    }
    return res;
  }
}

interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  message?: { text?: string; ts?: string };
}

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
}
