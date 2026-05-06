type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = order.info;

export function setLogLevel(level: Level): void {
  threshold = order[level];
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < threshold) return;
  const out = { level, ts: new Date().toISOString(), msg, ...fields };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(out)}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
};
