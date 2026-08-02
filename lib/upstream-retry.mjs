const TRANSIENT_OVERLOAD_STATUSES = new Set([429, 503, 529]);

export function isDeterministicQuotaError(value) {
  const text = String(value || "");
  return /AccountQuotaExceeded/i.test(text)
    || /weekly usage quota/i.test(text)
    || /monthly usage quota/i.test(text)
    || /quota (?:has been |is )?exhausted/i.test(text);
}

export async function shouldRetryUpstreamResponse(response) {
  if (!response || !TRANSIENT_OVERLOAD_STATUSES.has(Number(response.status))) return false;
  if (Number(response.status) !== 429) return true;
  try {
    const text = await response.clone().text();
    return !isDeterministicQuotaError(text);
  } catch {
    return true;
  }
}
