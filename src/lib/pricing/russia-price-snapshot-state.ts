export type RussiaPriceSnapshotState = "pending" | "ready" | "stale" | "failed";

export type RussiaPriceSnapshotDetails = {
  status: RussiaPriceSnapshotState;
  lastErrorCode: string | null;
  calculatedAt: string | null;
  updatedAt: string;
};

export function russiaPriceStateLabel(status: RussiaPriceSnapshotState | null | undefined, hasCalculation = false) {
  switch (status) {
    case "pending": return "Расчёт поставлен в очередь";
    case "stale": return hasCalculation ? "Показана последняя цена; обновление не удалось, повтор запланирован" : "Расчёт обновляется после ошибки";
    case "failed": return "Цена пока не рассчитана; повторная попытка запланирована";
    case "ready": return hasCalculation ? "Расчёт готов" : "Расчёт сохранён некорректно — требуется проверка";
    default: return "Расчёт ещё не поставлен в очередь";
  }
}

export function russiaPriceErrorLabel(code: string | null | undefined) {
  const labels: Record<string, string> = {
    UPSTREAM_AUTH: "не прошла авторизация внешнего сервиса",
    UPSTREAM_RATE_LIMIT: "внешний сервис ограничил частоту запросов",
    UPSTREAM_TIMEOUT: "истекло время ожидания ответа",
    UPSTREAM_NOT_CONFIGURED: "не настроен доступ к сервису расчёта",
    UPSTREAM_INVALID_RESPONSE: "сервис вернул данные в неожиданном формате",
    INVALID_LISTING_INPUT: "не хватает параметров автомобиля для расчёта",
    CALCULATION_FAILED: "ошибка расчёта",
  };
  return code ? labels[code] ?? code.replace(/_/g, " ").toLowerCase() : null;
}
