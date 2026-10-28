import { log } from './util.js';

const DEFAULT_EVENTS = ['gap_open', 'gap_widen', 'gap_close', 'stale_open', 'stale_close', 'feed_down', 'feed_up'];

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
}

function filtered(events, send) {
  const allow = new Set(events ?? DEFAULT_EVENTS);
  return async (ev) => {
    if (allow.has(ev.type)) await send(ev);
  };
}

/** Builds notifier functions from config; entries with empty credentials are skipped. */
export function buildNotifiers(alertsCfg = {}, publicUrl) {
  const out = [];
  const withLink = (text) => (publicUrl ? `${text}\n${publicUrl}` : text);

  const tg = alertsCfg.telegram;
  if (tg?.botToken && tg?.chatId) {
    const url = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
    out.push(filtered(tg.events, (ev) => post(url, { chat_id: tg.chatId, text: withLink(ev.message), disable_web_page_preview: true })));
    log.info('alerts: Telegram enabled');
  }

  for (const wh of alertsCfg.webhooks ?? []) {
    if (!wh?.url) continue;
    const body = (ev) => {
      const text = withLink(ev.message);
      if (wh.format === 'discord') return { content: text };
      if (wh.format === 'slack') return { text };
      return ev;
    };
    out.push(filtered(wh.events, (ev) => post(wh.url, body(ev))));
    log.info(`alerts: webhook enabled (${wh.format ?? 'json'})`);
  }
  return out;
}
