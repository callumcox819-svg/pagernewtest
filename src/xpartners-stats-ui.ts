import type { XPartnersCountry, XPartnersQuickStats } from "./xpartners-client.js";

export type StatsRefreshHours = 1 | 3 | 5;

export type PartnerStatsCache = Partial<
  Record<XPartnersCountry, XPartnersQuickStats>
> & {
  cachedAt?: string;
};

export function defaultRefreshHours(): StatsRefreshHours {
  return 3;
}

export function cacheStale(
  cachedAt: string | undefined,
  refreshHours: StatsRefreshHours,
): boolean {
  if (!cachedAt) {
    return true;
  }
  const ageMs = Date.now() - Date.parse(cachedAt);
  if (!Number.isFinite(ageMs)) {
    return true;
  }
  return ageMs >= refreshHours * 60 * 60 * 1000;
}

const COUNTRY_LABEL: Record<XPartnersCountry, string> = {
  CM: "Cameroon",
  EG: "Egypt",
  ZM: "Zambia",
};

export function formatPlayersIdsTxt(
  country: XPartnersCountry,
  dayKey: string,
  siteLabel: string,
  playerIds: string[],
): string {
  const label = COUNTRY_LABEL[country];
  const header = [
    `# 1xPartners · отчёт по игрокам · ${label}`,
    `# Дата регистрации: ${dayKey}`,
    `# Сайт: ${siteLabel}`,
    `# Всего ID: ${playerIds.length}`,
    "",
  ].join("\n");
  return `${header}${playerIds.join("\n")}\n`;
}

export function formatPlayersIdsMessage(
  country: XPartnersCountry,
  exportData: { dayKey: string; siteLabel: string; playerIds: string[] },
): string {
  const { dayKey, siteLabel, playerIds } = exportData;
  if (!playerIds.length) {
    return [
      `<b>1xPartners · ID игроков · ${COUNTRY_LABEL[country]}</b>`,
      `<b>Сайт:</b> <code>${escapeHtml(siteLabel)}</code>`,
      `<b>Дата:</b> ${dayKey}`,
      "",
      "За сегодня регистраций не найдено.",
    ].join("\n");
  }
  const preview = playerIds.slice(0, 35);
  const lines = [
    `<b>1xPartners · ID игроков · ${COUNTRY_LABEL[country]}</b>`,
    `<b>Сайт:</b> <code>${escapeHtml(siteLabel)}</code>`,
    `<b>Дата:</b> ${dayKey}`,
    `<b>Кол-во:</b> ${playerIds.length}`,
    "",
    `<code>${escapeHtml(preview.join("\n"))}</code>`,
  ];
  if (playerIds.length > preview.length) {
    lines.push(`<i>… и ещё ${playerIds.length - preview.length} (см. файл .txt)</i>`);
  }
  return lines.join("\n");
}

export function formatAllCountriesStats(
  byCountry: Partial<Record<XPartnersCountry, XPartnersQuickStats>>,
  refreshHours: StatsRefreshHours,
): string {
  const lines = [
    "<b>1xPartners · все страны · сегодня (USD)</b>",
    "",
  ];
  for (const country of ["CM", "EG", "ZM"] as const) {
    const stats = byCountry[country];
    if (!stats) {
      lines.push(`${COUNTRY_LABEL[country]}: <i>нет данных</i>`);
      continue;
    }
    lines.push(
      `<b>${COUNTRY_LABEL[country]}</b> · рег: ${stats.registrations} · FTD: ${stats.newAccountsWithDeposits}`,
    );
  }
  const latest = Object.values(byCountry)
    .map((s) => s?.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const when = latest ? new Date(latest) : new Date();
  const timeStr = Number.isFinite(when.getTime())
    ? when.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" })
    : "";
  lines.push("", `<i>Обновлено: ${escapeHtml(timeStr)} · авто-кэш: ${refreshHours} ч</i>`);
  return lines.join("\n");
}

export function formatStatsMessage(
  country: XPartnersCountry,
  stats: XPartnersQuickStats,
  refreshHours: StatsRefreshHours,
): string {
  const when = new Date(stats.fetchedAt);
  const timeStr = Number.isFinite(when.getTime())
    ? when.toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" })
    : stats.fetchedAt;
  return [
    `<b>1xPartners · ${COUNTRY_LABEL[country]}</b>`,
    `<b>Сайт:</b> <code>${escapeHtml(stats.siteLabel)}</code>`,
    `<b>Период:</b> Сегодня (USD)`,
    "",
    `<b>Регистрации:</b> ${stats.registrations}`,
    `<b>Новые с депозитом (FTD):</b> ${stats.newAccountsWithDeposits}`,
    "",
    `<i>Обновлено: ${escapeHtml(timeStr)} · авто-кэш: ${refreshHours} ч</i>`,
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function parseRefreshHours(value: string | undefined): StatsRefreshHours {
  const n = Number(value);
  if (n === 1 || n === 3 || n === 5) {
    return n;
  }
  return defaultRefreshHours();
}
