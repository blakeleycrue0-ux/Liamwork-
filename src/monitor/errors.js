/**
 * Dos lecturas del mismo fallo: la que ve cualquiera y la que ve quien lo va
 * a arreglar.
 *
 * `publicError` da la frase del panel: qué le pasa a la web, sin una sola
 * palabra de infraestructura. Un código HTTP, un nombre de servidor o un
 * ENOTFOUND no le dicen nada a quien vigila veintisiete clubes de golf, y en
 * cambio sí le dicen bastante a quien quiera sondear la instalación.
 *
 * `explainError` da el detalle técnico, y sigue existiendo entero: vive en
 * /api/diagnostics, que está detrás de la misma autenticación que el resto.
 *
 * Lo que NO hace ninguna de las dos es cambiar el veredicto. Una web que
 * falla falla, se cuente como se cuente.
 */

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
  // para https://…". Keep it, minus the URL the dashboard already shows, and
  // put a short label in front so the column reads like the HTTP ones.
  const withoutUrl = text
    .replace(/\s+para\s+https?:\/\/\S+$/i, '')
    .replace(/\s+for\s+https?:\/\/\S+$/i, '');
  const codes = { dns: 'DNS', tls: 'TLS', timeout: 'Tiempo agotado', network: 'Sin conexión' };
  const code = codes[kind] ?? 'Error';
  return { code, reason: withoutUrl, text: `${code} — ${withoutUrl}`, kind };
}


/* ---------------------------------------------------------------- público */

/**
 * Lo que se enseña en el panel: el estado de la WEB, no el de la petición.
 *
 * Tres estados y ni uno más, porque son los tres que cambian lo que alguien
 * puede hacer: la página está y responde, la página responde pero no nos deja
 * entrar, o no hemos conseguido hablar con ella. El código exacto, el nombre
 * del servidor y la causa del sistema operativo se quedan en diagnóstico.
 */
export function publicError(message, { consecutive = 0 } = {}) {
  if (!message) return null;
  const kind = errorKind(message);

  const label =
    kind === 'missing'
      ? 'Page not found'
      : kind === 'blocked' || kind === 'http' || kind === 'server'
        ? 'Unavailable'
        : kind === 'timeout'
          ? 'No response'
          : 'Could not connect';

  const note =
    consecutive > 1
      ? `${consecutive} checks in a row without success`
      : 'Last check failed';

  return { label, note, kind };
}

/**
 * El motivo de un intento de envío, dicho sin infraestructura.
 *
 * Los motivos que escribe sendDailyReport son casi todos de producto -"no hay
 * trabajadores activos", "no hubo cambios"- y salen tal cual. El único que no
 * lo es, el del correo, arrastra el mensaje del servidor SMTP: host, puerto y
 * a veces el usuario. Ese se resume. El texto literal sigue guardado en
 * report_attempts, que es donde hay que mirar para arreglarlo.
 */
export function publicAttemptReason(reason) {
  if (!reason) return null;
  const text = String(reason);
  if (/^el correo no salió/i.test(text)) return 'The mail server refused the message.';
  // Cualquier cosa que traiga rastros de máquina se resume igual.
  if (/smtp|:\d{2,5}\b|ECONN|ETIMEDOUT|EAUTH|certificate|socket/i.test(text)) {
    return 'The report could not be sent because of a technical problem.';
  }
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
}
