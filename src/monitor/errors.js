/**
 * Turns a stored crawler error into a sentence a person can act on.
 *
 * The rule the dashboard follows: never hide a failure and never dress it up
 * as something else. A website that answers 403 is shown as a website that
 * answered 403 - the explanation is added next to the code, not instead of it.
 *
 * Applied at read time rather than at write time, so the rows already in the
 * database from before this existed read just as clearly as the new ones.
 */

const HTTP_REASONS = {
  400: 'petición rechazada por el servidor',
  401: 'la página exige iniciar sesión',
  403: 'el servidor rechazó la petición',
  404: 'la página ya no existe en esa dirección',
  405: 'el servidor no admite este tipo de petición',
  408: 'el servidor cerró la espera',
  410: 'la página fue retirada por el sitio',
  418: 'el servidor respondió con un rechazo genérico',
  429: 'demasiadas peticiones: el servidor pide esperar',
  500: 'error interno del servidor',
  502: 'la pasarela del sitio no respondió',
  503: 'el sitio está caído o en mantenimiento',
  504: 'el servidor tardó demasiado en responder',
};

/** What kind of failure this is, for the colour and the icon. */
export function errorKind(message) {
  if (!message) return null;
  const text = String(message);
  if (/^HTTP (\d{3})/.test(text)) {
    const status = Number(text.match(/^HTTP (\d{3})/)[1]);
    if (status === 403 || status === 401 || status === 429) return 'blocked';
    if (status === 404 || status === 410) return 'missing';
    return status >= 500 ? 'server' : 'http';
  }
  if (/^Timeout after/i.test(text) || /no respondió a tiempo/i.test(text)) return 'timeout';
  if (/certificado/i.test(text)) return 'tls';
  if (/dominio no existe|DNS/i.test(text)) return 'dns';
  return 'network';
}

/**
 * @param {string|null} message  what the crawler stored
 * @returns {{code: string, reason: string, text: string, kind: string}|null}
 */
export function explainError(message) {
  if (!message) return null;
  const text = String(message).trim();
  const kind = errorKind(text);

  const http = text.match(/^HTTP (\d{3})/);
  if (http) {
    const status = Number(http[1]);
    const reason = HTTP_REASONS[status] ?? 'respuesta inesperada del servidor';
    return { code: `HTTP ${status}`, reason, text: `HTTP ${status} — ${reason}`, kind };
  }

  const timeout = text.match(/^Timeout after (\d+)ms/i);
  if (timeout) {
    const seconds = Math.round(Number(timeout[1]) / 1000);
    return {
      code: 'Tiempo agotado',
      reason: `el servidor no respondió en ${seconds} s`,
      text: `Tiempo agotado — el servidor no respondió en ${seconds} s`,
      kind,
    };
  }

  // "fetch failed" is what Node says when it refuses to say anything. It only
  // reaches here from rows stored before the crawler learned to unwrap it.
  if (/^fetch failed$/i.test(text)) {
    return {
      code: 'Sin conexión',
      reason: 'no se pudo establecer la conexión (causa no registrada)',
      text: 'Sin conexión — no se pudo establecer la conexión (causa no registrada)',
      kind: 'network',
    };
  }

  // Already a sentence: NetworkError writes "El dominio no existe (ENOTFOUND)
  // para https://…". Keep it, minus the URL the dashboard already shows.
  const withoutUrl = text.replace(/\s+para\s+https?:\/\/\S+$/i, '').replace(/\s+for\s+https?:\/\/\S+$/i, '');
  return { code: 'Error', reason: withoutUrl, text: withoutUrl, kind };
}
