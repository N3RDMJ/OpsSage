import type { Env } from '@opssage/config-schema';
import { slack as slackTools } from '@opssage/tools';
import { logger } from './log.js';
import type { TriageSummary } from './triage-schema.js';

export interface ChatTarget {
  channel: string;
  thread_ts?: string;
}

export interface ChatAdapter {
  /** Try to locate the Datadog→Slack alert message; return its thread anchor. */
  locateAlertThread(input: { channel: string; alertUrl: string }): Promise<ChatTarget | undefined>;
  /** Post the triage reply. No-op if not configured (logs a preview instead). */
  reply(input: { target: ChatTarget; summary: TriageSummary; alertUrl?: string }): Promise<void>;
}

export function buildChatAdapter(env: Env): ChatAdapter {
  if (!env.SLACK_BOT_TOKEN) {
    logger.warn('SLACK_BOT_TOKEN unset — chat adapter will log replies instead of sending.');
    return new ConsoleChatAdapter();
  }
  return new SlackChatAdapter(new slackTools.SlackClient({ botToken: env.SLACK_BOT_TOKEN }));
}

class SlackChatAdapter implements ChatAdapter {
  constructor(private readonly client: slackTools.SlackClient) {}

  async locateAlertThread({ channel, alertUrl }: { channel: string; alertUrl: string }) {
    const msg = await this.client.findMessageByLink(channel, alertUrl).catch((err) => {
      logger.warn('slack history lookup failed', { err: String(err) });
      return undefined;
    });
    if (!msg) return undefined;
    return { channel, thread_ts: msg.ts };
  }

  async reply({
    target,
    summary,
    alertUrl,
  }: { target: ChatTarget; summary: TriageSummary; alertUrl?: string }) {
    await this.client.postMessage({
      channel: target.channel,
      ...(target.thread_ts !== undefined ? { thread_ts: target.thread_ts } : {}),
      text: renderSummary(summary, alertUrl),
    });
  }
}

class ConsoleChatAdapter implements ChatAdapter {
  async locateAlertThread() {
    return undefined;
  }
  async reply({
    summary,
    alertUrl,
  }: { target: ChatTarget; summary: TriageSummary; alertUrl?: string }) {
    logger.info('[chat:console] triage reply', { summary, alertUrl });
  }
}

export function renderSummary(s: TriageSummary, alertUrl?: string): string {
  const lines: string[] = [];
  lines.push(`*OpsSage triage* — confidence: \`${s.confidence}\``);
  lines.push(`> ${s.hypothesis}`);
  if (s.evidence.length > 0) {
    lines.push('');
    lines.push('*Evidence*');
    for (const e of s.evidence.slice(0, 5)) {
      const link = e.link ? ` (<${e.link}|link>)` : '';
      lines.push(`• [${e.source}] ${e.summary}${link}`);
    }
  }
  lines.push('');
  lines.push(`*Suggested next step:* ${s.suggested_next_step}`);
  if (s.linked_artifacts.length > 0 || alertUrl) {
    const artifacts = [...s.linked_artifacts];
    if (alertUrl) artifacts.unshift({ label: 'Monitor', url: alertUrl });
    lines.push('');
    lines.push(artifacts.map((a) => `<${a.url}|${a.label}>`).join(' · '));
  }
  return lines.join('\n');
}
