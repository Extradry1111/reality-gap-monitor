// NYSE/Nasdaq full-day closures (YYYY-MM-DD, New York date).
const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04',
  '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24',
]);

// 1:00 pm early closes.
const EARLY_CLOSE = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26']);

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function newYorkParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Regular US equity session: 9:30–16:00 New York time, weekdays, minus exchange holidays. */
export function isUsEquityOpen(date = new Date()) {
  const { day, weekday, minutes } = newYorkParts(date);
  if (weekday === 'Sat' || weekday === 'Sun' || HOLIDAYS.has(day)) return false;
  const close = EARLY_CLOSE.has(day) ? 13 * 60 : 16 * 60;
  return minutes >= 9 * 60 + 30 && minutes < close;
}

/** mode: "us-equity" (default for stocks) or "always" (default for crypto). */
export function isMarketOpen(mode, date) {
  return mode === 'us-equity' ? isUsEquityOpen(date) : true;
}
