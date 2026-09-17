/* Web Monitor dashboard - vanilla ES modules, no build step. */
import { accessToken, authConfig, clearSession, storedUser } from '/auth.js';

const state = {
  csrfToken: null,
  provider: 'local',
  user: null,
  websites: [],
  workers: [],
  users: [],
  settings: {},
  digest: null,
  attempts: [],
  activity: [],
  page: 'summary',
};

/* ---------------------------------------------------------------- helpers */
const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child === '' || child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * One of the symbols defined once at the top of index.html.
 *
 * Built as real SVG nodes rather than innerHTML, because an <svg> created with
 * document.createElement lands in the HTML namespace and renders as nothing.
 */
function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

async function authHeaders() {
  if (state.provider !== 'supabase') {
    return state.csrfToken ? { 'x-csrf-token': state.csrfToken } : {};
  }
  const token = await accessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(await authHeaders()),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    clearSession();
    showBanner('La API ha rechazado la petición (401). Revisa AUTH_PROVIDER en Netlify.');
    throw new Error('No autenticado');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

/** Persistent notice at the top of the dashboard, for problems that are not
 *  transient (the API being down, for instance). */
function showBanner(message) {
  let banner = document.getElementById('banner');
  if (!banner) {
    banner = el('div', { id: 'banner', className: 'banner' });
    banner.append(icon('alert', 'icon icon-sm'), el('span', { className: 'banner-text' }));
    document.querySelector('main.content')?.prepend(banner);
  }
  banner.querySelector('.banner-text').textContent = message;
  banner.hidden = false;
}

function toast(message, kind = '') {
  const node = el('div', { className: `toast ${kind}` }, [
    icon(kind === 'err' ? 'x-circle' : kind === 'ok' ? 'check-circle' : 'pulse', 'icon icon-sm'),
    el('span', { textContent: message }),
  ]);
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 4500);
}

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-ES');
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('es-ES');
};

function fmtAgo(iso) {
  if (!iso) return 'nunca';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 0) return `en ${fmtDuration(-seconds)}`;
  if (seconds < 5) return 'ahora mismo';
  return `hace ${fmtDuration(seconds)}`;
}

function fmtDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

const DOT_COLOURS = { ok: 'var(--ok)', err: 'var(--bad)', warn: 'var(--warn)', off: 'var(--off)' };
const dot = (kind) =>
  el('span', { className: 'dot', style: `background:${DOT_COLOURS[kind] ?? 'var(--off)'}` });

/** Fecha larga: "16 de septiembre de 2026", para títulos y cabeceras. */
const fmtLongDay = (value) => {
  if (!value) return '—';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
};

/** Short date, for a column that has to stay one line wide. */
const fmtDay = (value) => {
  if (!value) return '—';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
};

/**
 * "hoy a las 07:00", "mañana a las 07:00", o la fecha cuando está más lejos.
 *
 * Siempre en la zona horaria DEL INFORME, no en la del navegador. El informe
 * sale a las 07:00 de Madrid tanto si se mira desde Madrid como desde un
 * portátil configurado en UTC, y decir "05:00" ahí sería mentir.
 */
function fmtWhen(iso, timeZone) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const zone = timeZone || undefined;
  const dayOf = (value) => value.toLocaleDateString('en-CA', { timeZone: zone });

  const time = date.toLocaleTimeString('es-ES', {
    timeZone: zone, hour: '2-digit', minute: '2-digit',
  });
  const days = Math.round(
    (new Date(`${dayOf(date)}T12:00:00Z`) - new Date(`${dayOf(new Date())}T12:00:00Z`)) / 86400000,
  );
  if (days === 0) return `hoy a las ${time}`;
  if (days === 1) return `mañana a las ${time}`;
  if (days === -1) return `ayer a las ${time}`;
  return `${date.toLocaleDateString('es-ES', { timeZone: zone, day: 'numeric', month: 'long' })} a las ${time}`;
}

/** Two lines in one cell: the relative time on top, the exact one below. */
const timeCell = (iso) =>
  el('td', { className: 'cell-time' }, [
    el('div', { textContent: fmtAgo(iso) }),
    el('span', { className: 'abs', textContent: iso ? fmtDateTime(iso) : '' }),
  ]);

/** A state, always as icon + word: the colour alone is never the message. */
function stateChip(kind, label) {
  const icons = { ok: 'check-circle', bad: 'x-circle', warn: 'alert', off: 'pause' };
  return el('span', { className: `state ${kind}` }, [
    icon(icons[kind] ?? 'pulse', 'icon icon-sm'),
    el('span', { textContent: label }),
  ]);
}

/**
 * The error, spelled out.
 *
 * The API sends `error_detail` next to the raw `last_error`, so the code the
 * server really returned stays visible and the sentence explains it. Nothing
 * is hidden and nothing is repainted green.
 */
function errorCell(website) {
  if (!website.last_error) return el('td', { className: 'muted', textContent: '—' });
  const detail = website.error_detail ?? { code: 'Error', reason: website.last_error };
  return el('td', {}, [
    el('div', { className: 'err' }, [
      el('span', { className: 'code', textContent: detail.code }),
      el('span', { className: 'why', textContent: detail.reason }),
      website.consecutive_errors > 1
        ? el('span', {
            className: 'cell-sub',
            textContent: `${website.consecutive_errors} intentos seguidos`,
          })
        : '',
    ]),
  ]);
}

/** Name plus address, the pair that identifies a website everywhere. */
const websiteCell = (website) =>
  el('td', {}, [
    el('div', { className: 'cell-main' }, [
      el('span', { className: 'name', textContent: website.name }),
      el('a', {
        href: website.url,
        target: '_blank',
        rel: 'noopener',
        className: 'cell-url mono',
        title: website.url,
        textContent: (website.url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      }),
    ]),
  ]);

/** How a website is doing right now, in one word. */
function websiteState(website) {
  if (!website.active) return { kind: 'off', label: 'Desactivada' };
  if (website.consecutive_errors) return { kind: 'bad', label: 'Con error' };
  if (!website.last_checked_at) return { kind: 'warn', label: 'Sin comprobar' };
  return { kind: 'ok', label: 'Correcta' };
}

/* ------------------------------------------------------------------ modal */
function openModal({ title, fields, submitLabel = 'Guardar', onSubmit, secondary = null }) {
  const form = el('form');
  for (const field of fields) {
    if (field.type === 'checkbox') {
      const wrap = el('div', { className: 'field checkbox' });
      const input = el('input', { type: 'checkbox', id: `f-${field.name}`, name: field.name, checked: !!field.value });
      wrap.append(input, el('label', { htmlFor: `f-${field.name}`, style: 'margin:0', textContent: field.label }));
      form.append(wrap);
      continue;
    }
    const wrap = el('div', { className: 'field' });
    wrap.append(el('label', { htmlFor: `f-${field.name}`, textContent: field.label }));
    let input;
    if (field.type === 'select') {
      input = el('select', { id: `f-${field.name}`, name: field.name });
      for (const option of field.options) {
        input.append(el('option', { value: option.value, textContent: option.label, selected: option.value === field.value }));
      }
    } else if (field.type === 'textarea') {
      input = el('textarea', {
        id: `f-${field.name}`,
        name: field.name,
        rows: 10,
        placeholder: field.placeholder ?? '',
        style: 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px',
      });
      input.value = field.value ?? '';
    } else {
      input = el('input', {
        id: `f-${field.name}`,
        name: field.name,
        type: field.type || 'text',
        value: field.value ?? '',
        placeholder: field.placeholder ?? '',
      });
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
      if (field.required) input.required = true;
    }
    wrap.append(input);
    if (field.hint) wrap.append(el('div', { className: 'hint', textContent: field.hint }));
    form.append(wrap);
  }

  const error = el('div', { className: 'error-text', hidden: true });
  const output = el('div', { className: 'preview-box', hidden: true });
  const submit = el('button', { className: 'btn-primary', type: 'submit', textContent: submitLabel });
  const cancel = el('button', { type: 'button', textContent: 'Cancelar' });

  const readValues = () =>
    Object.fromEntries(
      fields.map((field) => {
        const input = form.elements[field.name];
        return [field.name, field.type === 'checkbox' ? input.checked : input.value];
      }),
    );

  const actions = [cancel];
  for (const action of [].concat(secondary ?? [])) {
    const button = el('button', { type: 'button', textContent: action.label });
    button.addEventListener('click', async () => {
      button.disabled = true;
      error.hidden = true;
      output.hidden = false;
      output.replaceChildren(
        el('div', { className: 'muted', textContent: action.pending ?? 'Comprobando…' }),
      );
      try {
        await action.onClick(readValues(), output, form);
      } catch (err) {
        output.replaceChildren(el('div', { className: 'error-text', textContent: err.message }));
      } finally {
        button.disabled = false;
      }
    });
    actions.push(button);
  }
  actions.push(submit);
  form.append(error, output, el('div', { className: 'modal-actions' }, actions));

  const modal = el('div', { className: 'modal' }, [el('h2', { textContent: title }), form]);
  const backdrop = el('div', { className: 'modal-backdrop' }, [modal]);
  const close = () => backdrop.remove();
  cancel.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    const values = readValues();
    try {
      await onSubmit(values);
      close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  $('#modal-root').append(backdrop);
  form.querySelector('input, select')?.focus();
}

function confirmDialog(message) {
  return window.confirm(message);
}

/* ------------------------------------------------------------ summary tab */

const CRAWLER_STATES = {
  running: { kind: 'ok', label: 'Comprobando', badge: 'ok' },
  idle: { kind: 'ok', label: 'Funcionando', badge: 'ok' },
  paused: { kind: 'warn', label: 'En pausa', badge: 'warn' },
  stopped: { kind: 'off', label: 'Detenido', badge: 'mute' },
};

/**
 * "Hola, Crue" — el nombre de pila de quien tiene el panel delante.
 *
 * De la sesión cuando la hay. Sin sesión (AUTH_PROVIDER=none) no existe un
 * nombre que sacar, así que se usa el de la configuración en lugar de saludar
 * a la parte izquierda de un correo, que es cómo salía "Hola, Acceso".
 */
const GENERIC = new Set(['acceso', 'admin', 'administrador', 'info', 'no-reply', 'noreply', 'user']);

function greetingName(brand) {
  const raw = state.user?.name || (state.user?.email ?? '').split('@')[0] || '';
  const first = raw.split(/[.\-_\s]+/)[0];
  if (first && !GENERIC.has(first.toLowerCase()) && !/^\d+$/.test(first)) {
    return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return brand?.owner ?? '';
}

async function refreshStatus() {
  let data;
  try {
    data = await api('/status');
  } catch {
    return;
  }
  state.status = data;

  const name = greetingName(data.brand);
  $('#greeting').textContent = name ? `Hola, ${name}` : 'Resumen';

  const crawler = data.crawler;
  const key = !crawler.alive ? 'stopped' : (crawler.status in CRAWLER_STATES ? crawler.status : 'idle');
  const look = CRAWLER_STATES[key];

  /* --- la línea de estado, debajo del saludo --- */
  const failing = data.websites.failing ?? 0;
  const stateLine = $('#system-state');
  stateLine.replaceChildren(
    stateChip(look.kind, look.label),
    el('span', { className: 'sep', textContent: '·' }),
    el('span', {
      textContent: `${data.websites.active} webs vigiladas, ${failing === 0 ? 'todas respondiendo' : `${failing} con error`}`,
    }),
    el('span', { className: 'sep', textContent: '·' }),
    el('span', { textContent: `última comprobación ${fmtAgo(data.checks.last_checked_at)}` }),
  );

  $('#sidebar-foot').replaceChildren(
    stateChip(look.kind, look.label),
    el('div', {
      style: 'margin-top:4px',
      textContent: crawler.last_run_at ? `Última pasada ${fmtAgo(crawler.last_run_at)}` : 'Sin pasadas registradas',
    }),
  );

  /* --- las ocho cifras --- */
  $('#stat-crawler').className = `card stat tight is-${look.kind === 'off' ? 'info' : look.kind}`;
  $('#s-crawler').replaceChildren(
    el('span', { className: `badge ${look.badge}` }, [
      el('span', { className: `dot${crawler.status === 'running' && crawler.alive ? ' pulse' : ''}` }),
      look.label,
    ]),
  );
  $('#s-crawler-sub').textContent = crawler.alive
    ? `Pasada de ${fmtTime(crawler.last_run_at)} en ${fmtDuration(Math.round((crawler.last_run_duration_ms ?? 0) / 1000))}`
    : 'Sin señal del crawler: arranca el servidor o espera al cron';

  $('#s-websites').textContent = String(data.websites.active);
  $('#s-websites-sub').textContent = `${data.websites.total} en la lista fijada en el código`;

  $('#s-ok').textContent = String(data.websites.ok ?? 0);
  $('#s-ok-sub').textContent = 'Respondieron en la última pasada';

  $('#s-bad').textContent = String(failing);
  $('#s-bad-sub').textContent = failing
    ? 'El motivo está en la tabla de abajo'
    : 'Ninguna web rechaza la lectura';
  $('#stat-bad').className = `card stat tight is-${failing ? 'bad' : 'ok'}`;

  $('#s-workers').textContent = String(data.workers.active);
  $('#s-workers-sub').textContent = `${data.workers.total} dados de alta · reciben el informe`;

  $('#s-last-check').textContent = fmtTime(data.checks.last_checked_at);
  $('#s-last-check-sub').textContent = fmtAgo(data.checks.last_checked_at);

  $('#s-news').textContent = String(data.report.pending_changes);
  $('#s-news-sub').textContent = `del ${fmtDay(data.report.covers_date)}, esperando al informe`;

  $('#s-errors').textContent = String(data.checks.errors_24h);
  $('#s-errors-sub').textContent =
    `${data.usage_7d.analyses} análisis en 7 días · ` +
    `${(data.usage_7d.input_tokens + data.usage_7d.output_tokens).toLocaleString('es-ES')} tokens`;

  /* --- actividad reciente --- */
  $('#recent-posts').replaceChildren(
    ...(data.recent_changes.length
      ? data.recent_changes.map((change) => changeRow(change))
      : [emptyRow(6, 'Todavía no se ha detectado ningún cambio')]),
  );

  $('#mail-info').textContent = `Transporte: ${data.mail.transport} · Remitente: ${data.mail.from}`;
  if (data.brand?.credit) $('#footer-credit').textContent = data.brand.credit;

  await Promise.all([refreshDigest().catch(() => {}), refreshSummaryWebsites().catch(() => {})]);
}

const emptyRow = (columns, message) =>
  el('tr', {}, [el('td', { colSpan: columns, className: 'empty', textContent: message })]);

/**
 * Las 27 webs en el Resumen, con las que fallan arriba.
 *
 * Es la misma verdad que la página de Webs, sin los botones: quien abre el
 * panel por la mañana ve de una vez qué respondió y qué no.
 */
async function refreshSummaryWebsites() {
  const { websites } = await api('/websites');
  state.websites = websites;

  const ordered = websites.slice().sort((a, b) => {
    const rank = (site) => (site.last_error ? 0 : site.active ? 2 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, 'es');
  });

  $('#summary-websites').replaceChildren(
    ...(ordered.length
      ? ordered.map((website) => {
          const look = websiteState(website);
          return el('tr', {}, [
            websiteCell(website),
            el('td', {}, [stateChip(look.kind, look.label)]),
            timeCell(website.last_checked_at),
            el('td', {}, [
              el('div', { className: 'cell-main' }, [
                el('span', { textContent: website.last_new_item_title || 'Sin novedades' }),
                el('span', {
                  className: 'cell-sub',
                  textContent: website.last_new_item_at ? fmtAgo(website.last_new_item_at) : '',
                }),
              ]),
            ]),
            errorCell(website),
          ]);
        })
      : [emptyRow(5, 'La lista de webs está vacía')]),
  );
}

/** Colour and wording for a verdict, used everywhere a change is listed. */
const PRIORITY = {
  HIGH: { dot: 'err', kind: 'bad', label: 'Alta' },
  MEDIUM: { dot: 'warn', kind: 'warn', label: 'Media' },
  LOW: { dot: 'off', kind: 'off', label: 'Baja' },
};

const CHANGE_TYPES = {
  NEW: { label: 'Nuevo', badge: 'accent' },
  UPDATED: { label: 'Actualizado', badge: 'info' },
  UNCHANGED: { label: 'Sin cambios', badge: 'mute' },
  IGNORED: { label: 'Irrelevante', badge: 'mute' },
};

/** Una fila de la lista compacta: web, tipo, resumen, fecha, prioridad, estado. */
function changeRow(change) {
  const priority = PRIORITY[change.priority] ?? PRIORITY.LOW;
  const type = CHANGE_TYPES[change.change_type] ?? { label: change.change_type, badge: 'mute' };
  const reportable = ['NEW', 'UPDATED'].includes(change.change_type);

  const row = el('tr', { className: 'clickable' }, [
    el('td', { className: 'strong', textContent: change.website_name }),
    el('td', {}, [el('span', { className: `badge ${type.badge}`, textContent: type.label })]),
    el('td', {}, [
      el('div', { className: 'cell-main' }, [
        el('span', { className: 'name', textContent: change.title || '—' }),
        change.summary ? el('span', { className: 'cell-sub', textContent: change.summary }) : '',
      ]),
    ]),
    el('td', { className: 'muted', textContent: fmtDay(change.change_date) }),
    el('td', {}, [el('span', { className: `state ${priority.kind}` }, [dot(priority.dot), priority.label])]),
    el('td', {}, [
      change.reported_in
        ? stateChip('ok', 'Informado')
        : reportable
          ? stateChip('warn', 'Pendiente')
          : stateChip('off', 'Descartado'),
    ]),
  ]);
  row.addEventListener('click', () => showChangeAudit(change.id).catch((error) => toast(error.message, 'err')));
  return row;
}

/**
 * Why the system decided this. Requirement 13: what the model was shown and
 * what it answered, readable without opening the database.
 */
async function showChangeAudit(id) {
  const { change, audit, versions } = await api(`/reports/changes/${id}`);
  const modal = el('div', { className: 'modal' }, [
    el('h2', { textContent: change.title || 'Cambio detectado' }),
    el('div', {
      className: 'hint',
      textContent:
        `${change.website_name} · ${fmtLongDay(change.change_date)} · ` +
        `${(CHANGE_TYPES[change.change_type] ?? { label: change.change_type }).label} · ` +
        `prioridad ${(PRIORITY[change.priority] ?? PRIORITY.LOW).label.toLowerCase()}`,
    }),
    change.summary ? el('p', { textContent: change.summary }) : '',
    change.what_changed ? el('p', {}, [el('strong', { textContent: 'Qué cambió: ' }), change.what_changed]) : '',
    change.previous_value && change.new_value
      ? el('div', { className: 'preview-box mono' }, [
          el('div', { textContent: `Antes: ${change.previous_value}` }),
          el('div', { textContent: `Ahora: ${change.new_value}` }),
        ])
      : '',
    el('h2', { style: 'margin-top:22px', textContent: 'Auditoría' }),
    el('div', { className: 'hint', textContent:
      `Modelo: ${audit.model ?? 'ninguno'} · ${audit.input_tokens} tokens de entrada (${audit.cached_tokens} en caché), ${audit.output_tokens} de salida` }),
    change.reasoning ? el('p', { className: 'muted', textContent: change.reasoning }) : '',
    el('div', { className: 'hint', style: 'margin-top:14px', textContent: 'Lo que vio el modelo:' }),
    el('pre', { className: 'preview-box mono', textContent: audit.input || '—' }),
    versions.before
      ? el('details', {}, [
          el('summary', { className: 'hint', textContent: `Versión anterior (${fmtDateTime(versions.before.captured_at)})` }),
          el('pre', { className: 'preview-box mono', textContent: versions.before.text.slice(0, 4000) }),
        ])
      : '',
  ]);

  const close = el('button', { textContent: 'Cerrar' });
  modal.append(el('div', { className: 'modal-actions' }, [close]));
  const backdrop = el('div', { className: 'modal-backdrop' }, [modal]);
  close.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) backdrop.remove(); });
  $('#modal-root').append(backdrop);
}

/* ---------------------------------------------------------- daily report */

/**
 * La tarjeta del informe.
 *
 * Contesta sin rodeos las cuatro preguntas que se hace quien abre el panel por
 * la mañana: cuándo sale el próximo, qué lleva dentro, cuándo salió el último
 * y - la que faltaba - qué hace el sistema un día sin cambios. Ese último dato
 * era una suposición hasta ahora, y una suposición equivocada es lo que hace
 * que alguien espere un correo que nunca iba a salir.
 */
async function refreshDigest() {
  const { digest } = await api('/digest');
  state.digest = digest;

  const pending = digest.pending_changes;
  $('#digest-headline').textContent = pending
    ? `${pending} cambio${pending === 1 ? '' : 's'} esperando el informe`
    : 'Sin cambios pendientes';

  $('#digest-meta').textContent =
    `Cubre el ${fmtDay(digest.covers_date)} · se envía a las ` +
    `${String(digest.hour).padStart(2, '0')}:00 (${digest.timezone})`;

  $('#digest-next').replaceChildren(
    icon('calendar', 'icon icon-sm'),
    el('span', { textContent: fmtWhen(digest.next_report_at, digest.timezone) }),
  );

  $('#digest-pending').replaceChildren(
    el('span', {
      textContent: pending
        ? `${pending} del ${fmtDay(digest.covers_date)}`
        : `Ninguno del ${fmtDay(digest.covers_date)}`,
    }),
  );

  $('#digest-last').replaceChildren(
    el('span', {
      textContent: digest.last_sent_date
        ? `El del ${fmtDay(digest.last_sent_date)}`
        : 'Todavía ninguno',
    }),
  );

  // El interruptor que decide si un día tranquilo genera correo o silencio.
  const on = Boolean(digest.send_when_empty);
  $('#digest-empty').replaceChildren(
    el('span', { className: `switch ${on ? 'on' : 'off'}` }, [
      el('span', { className: 'track' }),
      el('span', { textContent: on ? 'ACTIVADO' : 'DESACTIVADO' }),
    ]),
    el('span', {
      className: 'cell-sub switch-note',
      textContent: on ? 'un día sin cambios sale igualmente' : 'un día sin cambios no genera correo',
    }),
  );

  renderAttempt(digest.last_attempt);
}

const ATTEMPT_LOOK = {
  enviado: { className: 'ok', icon: 'check-circle' },
  fallido: { className: 'bad', icon: 'x-circle' },
  omitido: { className: 'mute', icon: 'pause' },
};

/**
 * Qué pasó la última vez que el sistema intentó enviar.
 *
 * Sale de report_attempts, que no se sobrescribe nunca: un envío manual
 * posterior ya no borra el fallo automático de esa mañana, como hacía antes.
 */
function renderAttempt(attempt) {
  const box = $('#digest-attempt');
  if (!attempt) {
    box.hidden = true;
    return;
  }
  const look = ATTEMPT_LOOK[attempt.outcome] ?? ATTEMPT_LOOK.omitido;
  const origin = attempt.origin === 'manual' ? 'a mano' : 'automático';
  const verb =
    attempt.outcome === 'enviado'
      ? `Enviado ${origin}`
      : attempt.outcome === 'fallido'
        ? `Falló el envío ${origin}`
        : `No se envió (${origin})`;

  box.className = `attempt ${look.className}`;
  box.hidden = false;
  box.replaceChildren(
    icon(look.icon, 'icon icon-sm'),
    el('div', {}, [
      el('div', {}, [
        el('span', { className: 'strong', textContent: verb }),
        ` · informe del ${fmtDay(attempt.date)} · ${fmtAgo(attempt.at)}`,
      ]),
      attempt.reason ? el('div', { className: 'cell-sub', textContent: attempt.reason }) : '',
      attempt.outcome === 'enviado' && attempt.recipients?.length
        ? el('div', {
            className: 'cell-sub',
            textContent: `${attempt.recipients.length} destinatario(s) · ${attempt.changes} cambio(s)`,
          })
        : '',
    ]),
  );
}

/** Shows the exact report that would be emailed, without sending it. */
async function showDigestPreview() {
  const { report, date } = await api('/digest/preview');

  const groups = [
    { key: 'HIGH', label: 'Prioridad alta', dot: 'err' },
    { key: 'MEDIUM', label: 'Prioridad media', dot: 'warn' },
    { key: 'LOW', label: 'Prioridad baja', dot: 'ok' },
  ];

  const modal = el('div', { className: 'modal' }, [
    el('h2', { textContent: `Informe del ${fmtLongDay(date)}` }),
    el('div', { className: 'hint' }, [
      `Así saldría el correo · ${report.total_changes} cambio(s): ` +
        `${report.high_priority} de prioridad alta, ${report.medium_priority} media, ${report.low_priority} baja`,
    ]),
    el('p', { textContent: report.daily_summary }),
    ...groups
      .map((group) => ({ ...group, items: report.changes.filter((change) => change.priority === group.key) }))
      .filter((group) => group.items.length)
      .map((group) =>
        el('div', { className: 'digest-section' }, [
          el('div', { className: 'digest-title' }, [dot(group.dot), ` ${group.label}`]),
          ...group.items.map((item) =>
            el('div', { className: 'digest-item' }, [
              el('div', { className: 'what', textContent: item.title }),
              item.summary ? el('div', { className: 'where', textContent: item.summary }) : '',
              item.what_changed ? el('div', { className: 'where', textContent: `Qué cambió: ${item.what_changed}` }) : '',
              item.previous_value && item.new_value
                ? el('div', { className: 'where mono', textContent: `${item.previous_value} → ${item.new_value}` })
                : '',
              el('div', { className: 'where' }, [
                item.website,
                item.url ? el('a', { href: item.url, target: '_blank', rel: 'noopener', textContent: ' · abrir' }) : '',
              ]),
            ]),
          ),
        ]),
      ),
    report.total_changes ? '' : el('div', { className: 'empty', textContent: 'Nada que contar ese día.' }),
  ]);

  const close = el('button', { textContent: 'Cerrar' });
  modal.append(el('div', { className: 'modal-actions' }, [close]));
  const backdrop = el('div', { className: 'modal-backdrop' }, [modal]);
  close.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) backdrop.remove(); });
  $('#modal-root').append(backdrop);
}

/* ----------------------------------------------------------- websites tab */
const websiteFields = (website = {}) => [
  { name: 'name', label: 'Nombre', value: website.name, required: true, placeholder: 'FFSP' },
  { name: 'url', label: 'URL', type: 'url', value: website.url, required: true, placeholder: 'https://ffsp.info' },
  {
    name: 'check_interval',
    label: 'Intervalo de comprobación (segundos)',
    type: 'number',
    min: 10,
    max: 86400,
    value: website.check_interval ?? state.settings.default_check_interval ?? 60,
  },
  {
    name: 'detection_method',
    label: 'Método de detección',
    type: 'select',
    value: website.detection_method ?? 'auto',
    options: [
      { value: 'auto', label: 'Auto (RSS si existe, si no HTML)' },
      { value: 'rss', label: 'RSS / Atom' },
      { value: 'html', label: 'Scraping HTML' },
      { value: 'browser', label: 'Navegador headless (Playwright)' },
    ],
  },
  {
    name: 'feed_url',
    label: 'URL del RSS (opcional)',
    value: website.selector_config?.feed_url ?? '',
    hint: 'Si la web tiene RSS, se usa siempre antes que el scraping.',
  },
  { name: 'list', label: 'Selector CSS del listado (opcional)', value: website.selector_config?.list ?? '', placeholder: '.news-list article' },
  { name: 'title', label: 'Selector del título (opcional)', value: website.selector_config?.title ?? '', placeholder: 'h2 a' },
  { name: 'link', label: 'Selector del enlace (opcional)', value: website.selector_config?.link ?? '', placeholder: 'a' },
  { name: 'date', label: 'Selector de la fecha (opcional)', value: website.selector_config?.date ?? '', placeholder: 'time' },
  { name: 'active', label: 'Activa', type: 'checkbox', value: website.id ? website.active : true },
];

const toWebsitePayload = (values) => ({
  name: values.name,
  url: values.url,
  active: values.active,
  check_interval: Number(values.check_interval),
  detection_method: values.detection_method,
  selector_config: {
    feed_url: values.feed_url,
    list: values.list,
    title: values.title,
    link: values.link,
    date: values.date,
  },
});

/** Runs the detector against the values in the form, without saving anything.
 *  Turns "no detecta nada" into something you can actually see. */
async function previewDetection(values, output) {
  const payload = toWebsitePayload({ ...values, name: values.name || 'Prueba' });
  const { preview } = await api('/websites/preview', { method: 'POST', body: payload });

  if (!preview.total) {
    output.replaceChildren(
      el('div', { style: 'font-weight:600', textContent: 'No se ha detectado ninguna publicación' }),
      el('div', { className: 'hint', textContent: `Método usado: ${preview.method} · ${preview.source}` }),
      el('div', {
        className: 'hint',
        textContent:
          'Esta web no publica un RSS reconocible y su listado no encaja con la detección automática. ' +
          'Rellena "Selector CSS del listado" (y opcionalmente título y enlace) con las clases del bloque ' +
          'de cada noticia, y vuelve a probar.',
      }),
    );
    return;
  }

  output.replaceChildren(
    el('div', { style: 'font-weight:600', textContent: `Detectadas ${preview.total} publicaciones` }),
    el('div', { className: 'hint', textContent: `Método usado: ${preview.method} · ${preview.source}` }),
    el(
      'ul',
      { style: 'margin:8px 0 0;padding-left:18px' },
      preview.items.slice(0, 5).map((item) =>
        el('li', { style: 'margin-bottom:4px' }, [
          el('div', { textContent: item.title }),
          item.url ? el('div', { className: 'mono hint', textContent: item.url }) : '',
        ]),
      ),
    ),
  );
}

/**
 * Asks Claude to read the page and describe its listing. The selectors it
 * returns are written straight into the form, so from then on the checks are
 * ordinary scraping: the model is used once, not every minute.
 */
async function detectWithAi(values, output, form) {
  const payload = toWebsitePayload({ ...values, name: values.name || 'Prueba' });
  const { detection } = await api('/websites/ai-detect', { method: 'POST', body: payload });

  for (const field of ['list', 'title', 'link', 'date']) {
    if (detection.selectors?.[field]) form.elements[field].value = detection.selectors[field];
  }
  if (detection.total) form.elements.detection_method.value = 'html';

  output.replaceChildren(
    el('div', { style: 'font-weight:600', textContent: `La IA ha encontrado ${detection.total} publicaciones` }),
    el('div', { className: 'hint', textContent: detection.notes }),
    el(
      'ul',
      { style: 'margin:8px 0 0;padding-left:18px' },
      detection.items.slice(0, 5).map((item) => el('li', { textContent: item.title })),
    ),
    el('div', {
      className: 'hint',
      style: 'margin-top:8px',
      textContent: detection.total
        ? 'Los selectores ya están rellenados arriba. Guarda y las próximas comprobaciones no usarán la IA.'
        : 'Si la web carga su contenido con JavaScript, no hay nada que leer en el HTML.',
    }),
  );
}

/** Shows what the page contains, so a broken listing can be configured. */
async function inspectSite(values, output) {
  const payload = toWebsitePayload({ ...values, name: values.name || 'Diagnóstico' });
  const { inspection } = await api('/websites/inspect', { method: 'POST', body: payload });

  const line = (label, value) =>
    el('div', {}, [el('span', { className: 'hint', textContent: `${label}: ` }), String(value)]);

  const nodes = [
    el('div', { style: 'font-weight:600', textContent: 'Qué contiene la página' }),
    line('Descargado', `${Math.round(inspection.bytes / 1024)} KB`),
    line('Texto visible', `${inspection.visible_text_length} caracteres`),
    line('Enlaces con texto', inspection.total_links),
  ];

  if (inspection.likely_javascript) {
    nodes.push(
      el('div', {
        className: 'error-text',
        textContent:
          'Esta web carga su contenido con JavaScript: el HTML viene casi vacío, así que no hay nada que leer.',
      }),
    );
  }

  if (inspection.feeds.length) {
    nodes.push(line('RSS encontrado', inspection.feeds.join(', ')));
  }

  if (inspection.candidates.length) {
    nodes.push(
      el('div', { style: 'font-weight:600;margin-top:8px', textContent: 'Bloques que se repiten' }),
      el(
        'ul',
        { style: 'margin:4px 0 0;padding-left:18px' },
        inspection.candidates.map((candidate) =>
          el('li', {}, [
            el('span', { className: 'mono', textContent: candidate.selector }),
            ` — ${candidate.count} (${candidate.withLink} con enlace)`,
          ]),
        ),
      ),
    );
  }

  if (inspection.links.length) {
    nodes.push(
      el('div', { style: 'font-weight:600;margin-top:8px', textContent: 'Primeros enlaces' }),
      el(
        'ul',
        { style: 'margin:4px 0 0;padding-left:18px' },
        inspection.links.slice(0, 12).map((link) =>
          el('li', {}, [link.text, el('div', { className: 'mono hint', textContent: link.href })]),
        ),
      ),
    );
  }

  output.replaceChildren(...nodes);
}

/** Paste a list of clubs and create them all at once. */
/**
 * Editing only. Websites are published from src/config/sites.js, so there is
 * no "new website" branch here and no endpoint that would accept one.
 */
function websiteModal(website) {
  openModal({
    title: `Editar ${website.name}`,
    fields: websiteFields(website),
    submitLabel: 'Guardar cambios',
    secondary: [
      { label: 'Probar detección', onClick: previewDetection },
      { label: 'Diagnóstico', onClick: inspectSite, pending: 'Leyendo la página…' },
    ],
    onSubmit: async (values) => {
      await api(`/websites/${website.id}`, { method: 'PUT', body: toWebsitePayload(values) });
      toast('Web actualizada', 'ok');
      await loadWebsites();
      refreshStatus();
    },
  });
}

async function loadWebsites() {
  const { websites } = await api('/websites');
  state.websites = websites;
  renderWebsites();
}

/**
 * Filtrado en el propio navegador, sobre las webs que ya están cargadas.
 *
 * No hay endpoint nuevo ni consulta nueva: es la misma lista de siempre,
 * mostrada de otra forma. Por eso la búsqueda es instantánea.
 */
function renderWebsites() {
  const term = ($('#web-search')?.value ?? '').trim().toLowerCase();
  const filter = $('#web-filter')?.value ?? 'all';

  const rows = state.websites.filter((website) => {
    const look = websiteState(website);
    if (filter === 'ok' && look.kind !== 'ok') return false;
    if (filter === 'error' && look.kind !== 'bad') return false;
    if (filter === 'off' && website.active) return false;
    if (!term) return true;
    return `${website.name} ${website.url}`.toLowerCase().includes(term);
  });

  const count = $('#web-count');
  if (count) {
    count.textContent =
      rows.length === state.websites.length
        ? `${state.websites.length} webs`
        : `${rows.length} de ${state.websites.length} webs`;
  }

  const body = $('#websites-body');
  if (!state.websites.length) return body.replaceChildren(emptyRow(6, 'La lista de webs está vacía.'));
  if (!rows.length) return body.replaceChildren(emptyRow(6, 'Ninguna web encaja con este filtro.'));

  body.replaceChildren(
    ...rows.map((website) => {
      const look = websiteState(website);

      const checkBtn = el('button', { className: 'btn-sm' }, [
        el('span', { textContent: 'Comprobar' }),
      ]);
      checkBtn.addEventListener('click', async () => {
        const label = checkBtn.querySelector('span');
        checkBtn.disabled = true;
        label.textContent = 'Comprobando…';
        try {
          const { result } = await api(`/websites/${website.id}/check`, { method: 'POST' });
          if (result.ok) {
            toast(
              `${website.name}: ${result.itemsFound} página(s), ${result.newItems} con cambios` +
                (result.baseline ? ' · línea base' : '') +
                (result.note ? ` · ${result.note}` : ''),
              result.itemsFound ? 'ok' : '',
            );
          } else {
            toast(`${website.name}: ${result.error}`, 'err');
          }
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          checkBtn.disabled = false;
          label.textContent = 'Comprobar';
          await loadWebsites();
          refreshStatus();
        }
      });

      // Las tres acciones secundarias van como icono con su título: son las
      // mismas de siempre, pero cuatro botones de texto por fila dejaban la
      // tabla más ancha que la pantalla y escondían la última tras el scroll.
      const iconAction = (name, label, onClick) => {
        const button = el('button', {
          className: 'btn-ghost icon-btn',
          title: label,
          ariaLabel: label,
          type: 'button',
        }, [icon(name, 'icon icon-sm')]);
        button.addEventListener('click', onClick);
        return button;
      };

      const historyBtn = iconAction('file', 'Ver el historial', () =>
        showHistory(website).catch((error) => toast(error.message, 'err')),
      );

      const editBtn = iconAction('settings', 'Editar cómo se lee', () => websiteModal(website));

      const toggleBtn = iconAction(
        website.active ? 'pause' : 'check',
        website.active ? 'Dejar de vigilarla' : 'Volver a vigilarla',
        async () => {
          await api(`/websites/${website.id}/toggle`, { method: 'POST', body: { active: !website.active } });
          await loadWebsites();
          refreshStatus();
        },
      );

      return el('tr', {}, [
        el('td', {}, [
          el('div', { className: 'cell-main' }, [
            el('span', { className: 'name', textContent: website.name }),
            el('a', {
              href: website.url,
              target: '_blank',
              rel: 'noopener',
              className: 'cell-url mono',
              title: website.url,
              textContent: (website.url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
            }),
            el('span', {
              className: 'cell-sub',
              title: `Método: ${website.detection_method} · ${website.posts_count} página(s) seguidas`,
              textContent:
                `${website.detection_method} · ${website.posts_count} págs · cada ${fmtDuration(website.check_interval)}`,
            }),
          ]),
        ]),
        el('td', {}, [stateChip(look.kind, look.label)]),
        timeCell(website.last_checked_at),
        el('td', {}, [
          el('div', { className: 'cell-main' }, [
            el('span', { textContent: website.last_new_item_title || 'Sin novedades' }),
            el('span', {
              className: 'cell-sub',
              textContent: website.last_new_item_at ? fmtDateTime(website.last_new_item_at) : '',
            }),
          ]),
        ]),
        errorCell(website),
        el('td', { className: 'actions' }, [
          el('div', { className: 'row-actions' }, [checkBtn, historyBtn, editBtn, toggleBtn]),
        ]),
      ]);
    }),
  );
}

async function showHistory(website) {
  const [{ posts }, { logs }] = await Promise.all([
    api(`/websites/${website.id}/posts?limit=50`),
    api(`/websites/${website.id}/logs?limit=30`),
  ]);

  const postRows = posts.length
    ? posts.map((post) =>
        el('tr', {}, [
          el('td', {}, [
            post.url ? el('a', { href: post.url, target: '_blank', rel: 'noopener', textContent: post.title }) : post.title,
          ]),
          el('td', { className: 'muted', textContent: fmtDateTime(post.first_seen_at) }),
          el('td', {}, [post.notified_at ? dot('ok') : dot('off'), post.notified_at ? 'Enviado' : 'No enviado']),
        ]),
      )
    : [el('tr', {}, [el('td', { colSpan: 3, className: 'empty', textContent: 'Sin publicaciones detectadas' })])];

  const logRows = logs.map((log) =>
    el('tr', {}, [
      el('td', { className: 'muted', textContent: fmtDateTime(log.checked_at) }),
      el('td', {}, [dot(log.success ? 'ok' : 'err'), log.success ? 'OK' : 'Error']),
      el('td', { className: 'mono', textContent: log.success ? `${log.items_found} items / ${log.new_items} nuevos` : log.error_message || '' }),
    ]),
  );

  const modal = el('div', { className: 'modal' }, [
    el('h2', { textContent: `Historial · ${website.name}` }),
    el('h2', { className: 'muted', textContent: 'Publicaciones detectadas' }),
    el('div', { className: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { textContent: 'Título' }), el('th', { textContent: 'Detectada' }), el('th', { textContent: 'Email' })])]),
        el('tbody', {}, postRows),
      ]),
    ]),
    el('h2', { className: 'muted', style: 'margin-top:16px', textContent: 'Comprobaciones' }),
    el('div', { className: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { textContent: 'Cuándo' }), el('th', { textContent: 'Resultado' }), el('th', { textContent: 'Detalle' })])]),
        el('tbody', {}, logRows),
      ]),
    ]),
  ]);

  const closeBtn = el('button', { textContent: 'Cerrar' });
  modal.append(el('div', { className: 'modal-actions' }, [closeBtn]));
  const backdrop = el('div', { className: 'modal-backdrop' }, [modal]);
  closeBtn.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) backdrop.remove(); });
  $('#modal-root').append(backdrop);
}

/* ------------------------------------------------------------ workers tab */
function workerModal(worker) {
  openModal({
    title: worker ? `Editar ${worker.name}` : 'Añadir trabajador',
    fields: [
      { name: 'name', label: 'Nombre', value: worker?.name, required: true },
      { name: 'email', label: 'Email', type: 'email', value: worker?.email, required: true },
      { name: 'active', label: 'Activo', type: 'checkbox', value: worker ? worker.active : true },
    ],
    submitLabel: worker ? 'Guardar cambios' : 'Añadir',
    onSubmit: async (values) => {
      const payload = { name: values.name, email: values.email, active: values.active };
      if (worker) await api(`/workers/${worker.id}`, { method: 'PUT', body: payload });
      else await api('/workers', { method: 'POST', body: payload });
      toast(worker ? 'Trabajador actualizado' : 'Trabajador añadido', 'ok');
      await loadWorkers();
      refreshStatus();
    },
  });
}

async function loadWorkers() {
  // Los intentos de envío son los únicos datos reales de "actividad" que tiene
  // un trabajador: cuándo le llegó por última vez el informe. No se inventa
  // nada - si nunca ha recibido uno, la columna lo dice.
  const [{ workers }, attempts] = await Promise.all([
    api('/workers'),
    api('/digest/attempts?limit=100').then((data) => data.attempts).catch(() => []),
  ]);
  state.workers = workers;
  state.attempts = attempts;

  const lastFor = (email) =>
    attempts.find(
      (attempt) => attempt.outcome === 'enviado' && (attempt.recipients ?? []).includes(email),
    ) ?? null;

  const body = $('#workers-body');
  if (!workers.length) {
    return body.replaceChildren(emptyRow(5, 'No hay trabajadores configurados.'));
  }

  body.replaceChildren(
    ...workers.map((worker) => {
      const testBtn = el('button', { className: 'btn-ghost btn-sm' }, [
        icon('mail', 'icon icon-sm'),
        el('span', { textContent: 'Probar' }),
      ]);
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        try {
          await api(`/workers/${worker.id}/test-email`, { method: 'POST' });
          toast(`Email de prueba enviado a ${worker.email}`, 'ok');
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          testBtn.disabled = false;
        }
      });

      const editBtn = el('button', { className: 'btn-ghost btn-sm', textContent: 'Editar' });
      editBtn.addEventListener('click', () => workerModal(worker));

      const toggleBtn = el('button', {
        className: 'btn-ghost btn-sm',
        textContent: worker.active ? 'Desactivar' : 'Activar',
      });
      toggleBtn.addEventListener('click', async () => {
        await api(`/workers/${worker.id}/toggle`, { method: 'POST', body: { active: !worker.active } });
        await loadWorkers();
        refreshStatus();
      });

      const deleteBtn = el('button', { className: 'btn-sm btn-danger', textContent: 'Eliminar' });
      deleteBtn.addEventListener('click', async () => {
        if (!confirmDialog(`¿Eliminar a ${worker.name}? Dejará de recibir el informe diario.`)) return;
        try {
          await api(`/workers/${worker.id}`, { method: 'DELETE' });
          toast('Trabajador eliminado', 'ok');
          await loadWorkers();
          refreshStatus();
        } catch (error) {
          toast(error.message, 'err');
        }
      });

      const last = lastFor(worker.email);

      return el('tr', {}, [
        el('td', {}, [
          el('div', { className: 'cell-main' }, [
            el('span', { className: 'name', textContent: worker.name }),
            el('span', { className: 'cell-sub', textContent: `Alta el ${fmtDay(worker.created_at)}` }),
          ]),
        ]),
        el('td', { className: 'mono', textContent: worker.email }),
        el('td', {}, [
          worker.active ? stateChip('ok', 'Activo') : stateChip('off', 'Inactivo'),
        ]),
        el('td', {}, [
          el('div', { className: 'cell-main' }, [
            el('span', { textContent: last ? `Informe ${fmtAgo(last.attempted_at)}` : 'Sin informes aún' }),
            el('span', {
              className: 'cell-sub',
              textContent: last ? `el del ${fmtDay(last.report_date)}` : 'recibirá el próximo',
            }),
          ]),
        ]),
        el('td', { className: 'actions' }, [
          el('div', { className: 'row-actions' }, [testBtn, editBtn, toggleBtn, deleteBtn]),
        ]),
      ]);
    }),
  );
}

/* ----------------------------------------------------------- activity tab */

/**
 * Un solo registro, con tres clases de suceso.
 *
 * Antes eran dos tablas separadas y ninguna de las dos contaba los informes,
 * que es justo lo que había que mirar la mañana que el correo no llegó. Las
 * tres fuentes ya existían; aquí simplemente se ordenan juntas por fecha.
 */
async function loadActivity() {
  const [changes, logs, attempts] = await Promise.all([
    api('/posts?limit=120').then((data) => data.changes).catch(() => []),
    api('/logs?limit=200').then((data) => data.logs).catch(() => []),
    api('/digest/attempts?limit=40').then((data) => data.attempts).catch(() => []),
  ]);

  const events = [
    ...logs.map((log) => ({
      at: log.checked_at,
      website: log.website_name,
      kind: 'check',
      action: 'Comprobación',
      ok: Boolean(log.success),
      state: log.success ? 'ok' : 'bad',
      result: log.success ? 'Correcta' : 'Error',
      detail: log.success
        ? `${log.items_found} página(s), ${log.new_items} con cambios · ${log.method || 'html'} · ${log.duration_ms ?? '—'} ms`
        : (explainStored(log.error_message) || 'Error sin detalle'),
      search: `${log.website_name} ${log.error_message ?? ''} ${log.method ?? ''}`,
    })),
    ...changes.map((change) => {
      const priority = PRIORITY[change.priority] ?? PRIORITY.LOW;
      const type = CHANGE_TYPES[change.change_type] ?? { label: change.change_type };
      const reportable = ['NEW', 'UPDATED'].includes(change.change_type);
      return {
        at: change.detected_at,
        website: change.website_name,
        kind: 'change',
        action: `Análisis · ${type.label}`,
        ok: true,
        state: reportable ? priority.kind : 'off',
        result: reportable ? `Prioridad ${priority.label.toLowerCase()}` : 'Descartado',
        detail: [change.title, change.summary].filter(Boolean).join(' — ') || '—',
        changeId: change.id,
        search: `${change.website_name} ${change.title ?? ''} ${change.summary ?? ''} ${change.change_type}`,
      };
    }),
    ...attempts.map((attempt) => ({
      at: attempt.attempted_at,
      website: '—',
      kind: 'report',
      action: `Informe ${attempt.origin === 'manual' ? 'a mano' : 'automático'}`,
      ok: attempt.outcome === 'enviado',
      state: attempt.outcome === 'enviado' ? 'ok' : attempt.outcome === 'fallido' ? 'bad' : 'off',
      result:
        attempt.outcome === 'enviado'
          ? 'Enviado'
          : attempt.outcome === 'fallido'
            ? 'No salió'
            : 'Omitido',
      detail:
        `Informe del ${fmtDay(attempt.report_date)} · ${attempt.changes} cambio(s)` +
        (attempt.reason ? ` · ${attempt.reason}` : '') +
        (attempt.recipients?.length ? ` · ${attempt.recipients.length} destinatario(s)` : ''),
      search: `informe ${attempt.origin} ${attempt.outcome} ${attempt.reason ?? ''}`,
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  state.activity = events;
  fillWebFilter(events);
  renderActivity();
}

/** Los stored errors se leen igual que en la tabla de webs. */
function explainStored(message) {
  if (!message) return '';
  const http = String(message).match(/^HTTP (\d{3})/);
  if (http) {
    const reasons = {
      401: 'la página exige iniciar sesión',
      403: 'el servidor rechazó la petición',
      404: 'la página ya no existe en esa dirección',
      429: 'demasiadas peticiones: el servidor pide esperar',
      500: 'error interno del servidor',
      502: 'la pasarela del sitio no respondió',
      503: 'el sitio está caído o en mantenimiento',
      504: 'el servidor tardó demasiado en responder',
    };
    return `HTTP ${http[1]} — ${reasons[Number(http[1])] ?? 'respuesta inesperada del servidor'}`;
  }
  const timeout = String(message).match(/^Timeout after (\d+)ms/i);
  if (timeout) return `Tiempo agotado — sin respuesta en ${Math.round(Number(timeout[1]) / 1000)} s`;
  if (/^fetch failed$/i.test(message)) return 'Sin conexión — causa no registrada';
  return String(message).replace(/\s+(para|for)\s+https?:\/\/\S+$/i, '');
}

/** El desplegable de webs se rellena con las que de verdad aparecen. */
function fillWebFilter(events) {
  const select = $('#act-web');
  if (!select) return;
  const current = select.value;
  const names = [...new Set(events.map((event) => event.website))].filter((name) => name !== '—').sort();
  select.replaceChildren(
    el('option', { value: 'all', textContent: 'Todas las webs' }),
    ...names.map((name) => el('option', { value: name, textContent: name })),
  );
  if (names.includes(current) || current === 'all') select.value = current;
}

const KIND_ICONS = { check: 'refresh', change: 'pulse', report: 'mail' };

function renderActivity() {
  const term = ($('#act-search')?.value ?? '').trim().toLowerCase();
  const web = $('#act-web')?.value ?? 'all';
  const kind = $('#act-kind')?.value ?? 'all';
  const result = $('#activity-filter')?.value ?? 'all';
  const range = $('#act-date')?.value ?? 'all';

  const since =
    range === 'today'
      ? new Date().setHours(0, 0, 0, 0)
      : range === 'all'
        ? null
        : Date.now() - Number(range) * 86400000;

  const rows = state.activity.filter((event) => {
    if (web !== 'all' && event.website !== web) return false;
    if (kind !== 'all' && event.kind !== kind) return false;
    if (result === 'errors' && event.ok) return false;
    if (result === 'ok' && !event.ok) return false;
    if (since !== null && new Date(event.at).getTime() < since) return false;
    if (term && !`${event.search} ${event.detail}`.toLowerCase().includes(term)) return false;
    return true;
  });

  const count = $('#act-count');
  if (count) {
    count.textContent =
      rows.length === state.activity.length
        ? `${rows.length} sucesos`
        : `${rows.length} de ${state.activity.length} sucesos`;
  }

  $('#activity-body').replaceChildren(
    ...(rows.length
      ? rows.slice(0, 300).map((event) => {
          const row = el('tr', { className: event.changeId ? 'clickable' : '' }, [
            el('td', { className: 'cell-time' }, [
              el('div', { textContent: fmtDateTime(event.at) }),
              el('span', { className: 'abs', textContent: fmtAgo(event.at) }),
            ]),
            el('td', { className: 'strong', textContent: event.website }),
            el('td', {}, [
              el('span', { className: `kind ${event.kind}` }, [
                icon(KIND_ICONS[event.kind], 'icon icon-sm'),
                el('span', { textContent: event.action }),
              ]),
            ]),
            el('td', {}, [stateChip(event.state, event.result)]),
            el('td', {}, [el('span', { className: 'cell-sub', textContent: event.detail })]),
          ]);
          if (event.changeId) {
            row.addEventListener('click', () =>
              showChangeAudit(event.changeId).catch((error) => toast(error.message, 'err')),
            );
          }
          return row;
        })
      : [emptyRow(5, 'No hay sucesos que encajen con estos filtros.')]),
  );
}

/* -------------------------------------------------------------- users tab */
/** Dashboard users (Supabase Auth). Different from workers, who only receive
 *  the alert emails. */
function userModal() {
  openModal({
    title: 'Añadir usuario',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Contraseña', type: 'password', required: true, hint: 'Mínimo 8 caracteres.' },
    ],
    submitLabel: 'Crear usuario',
    onSubmit: async (values) => {
      await api('/users', { method: 'POST', body: { email: values.email, password: values.password } });
      toast('Usuario creado', 'ok');
      await loadUsers();
    },
  });
}

function passwordModal(user) {
  openModal({
    title: `Cambiar contraseña · ${user.email}`,
    fields: [
      { name: 'password', label: 'Nueva contraseña', type: 'password', required: true, hint: 'Mínimo 8 caracteres.' },
    ],
    submitLabel: 'Guardar',
    onSubmit: async (values) => {
      await api(`/users/${user.id}/password`, { method: 'PUT', body: { password: values.password } });
      toast('Contraseña actualizada', 'ok');
    },
  });
}

async function loadUsers() {
  const { users } = await api('/users');
  state.users = users;
  const body = $('#users-body');

  if (!users.length) {
    body.replaceChildren(
      el('tr', {}, [el('td', { colSpan: 4, className: 'empty', textContent: 'No hay usuarios.' })]),
    );
    return;
  }

  body.replaceChildren(
    ...users.map((user) => {
      const actions = el('td', { className: 'actions' });

      const passwordBtn = el('button', { className: 'btn-sm', textContent: 'Contraseña' });
      passwordBtn.addEventListener('click', () => passwordModal(user));

      const deleteBtn = el('button', { className: 'btn-sm btn-danger', textContent: 'Eliminar' });
      deleteBtn.disabled = user.id === state.user?.id;
      deleteBtn.addEventListener('click', async () => {
        if (!confirmDialog(`¿Eliminar el acceso de ${user.email}?`)) return;
        try {
          await api(`/users/${user.id}`, { method: 'DELETE' });
          toast('Usuario eliminado', 'ok');
          await loadUsers();
        } catch (error) {
          toast(error.message, 'err');
        }
      });
      actions.append(passwordBtn, ' ', deleteBtn);

      return el('tr', {}, [
        el('td', { style: 'font-weight:600' }, [
          user.email,
          user.id === state.user?.id ? el('span', { className: 'hint', textContent: ' (tú)' }) : '',
        ]),
        el('td', { className: 'muted', textContent: fmtDateTime(user.created_at) }),
        el('td', { className: 'muted', textContent: user.last_sign_in_at ? fmtAgo(user.last_sign_in_at) : 'nunca' }),
        actions,
      ]);
    }),
  );
}

/* ----------------------------------------------------------- settings tab */
async function loadSettings() {
  const { settings } = await api('/settings');
  state.settings = settings;
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = ['true', '1', 'yes'].includes(String(value).toLowerCase());
    else input.value = value;
  }
}

/* --------------------------------------------------------------- bootstrap */
/** Los motivos que devuelve la API, dichos como se los diría una persona. */
const REASONS = {
  'already-sent': 'el informe de ese día ya se había enviado',
  'no-changes': 'no hubo cambios y el envío en días vacíos está desactivado',
  'no-active-workers': 'no hay ningún trabajador activo al que enviarlo',
};


const PAGE_TITLES = {
  summary: 'Resumen',
  websites: 'Webs',
  workers: 'Trabajadores',
  activity: 'Actividad',
  users: 'Usuarios',
  settings: 'Configuración',
};

function closeDrawer() {
  $('#sidebar')?.classList.remove('open');
  $('#sidebar-scrim')?.classList.remove('open');
}

function showPage(page) {
  state.page = page;
  document.title = PAGE_TITLES[page] ? `${PAGE_TITLES[page]} · Web Monitor` : 'Web Monitor';
  $('#topbar-title').textContent = PAGE_TITLES[page] ?? '';

  for (const tab of document.querySelectorAll('.nav-item')) {
    tab.classList.toggle('active', tab.dataset.page === page);
  }
  for (const section of document.querySelectorAll('.page')) {
    section.classList.toggle('active', section.id === `page-${page}`);
  }
  closeDrawer();
  window.scrollTo({ top: 0, behavior: 'instant' });

  const loaders = {
    websites: loadWebsites,
    workers: loadWorkers,
    activity: loadActivity,
    settings: loadSettings,
    users: loadUsers,
  };
  loaders[page]?.().catch((error) => toast(error.message, 'err'));
}

async function init() {
  const { provider } = await authConfig();
  state.provider = provider;

  const me = await fetch('/api/auth/me', { headers: await authHeaders() })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  if (!me) {
    // The API is not answering. Show the dashboard anyway and say what happens:
    // there is no login page to fall back to, and nothing to log into.
    showBanner('La API no responde. Abre /api/diagnostics para ver el motivo.');
  }
  state.csrfToken = me?.csrfToken ?? null;
  state.user = me?.user ?? storedUser();

  $('#logout').hidden = state.provider === 'none';

  if (state.provider === 'supabase') {
    document.getElementById('tab-users').hidden = false;
    const label = document.getElementById('current-user');
    if (label && state.user?.email) label.textContent = state.user.email;
  }

  document.getElementById('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.nav-item');
    if (tab?.dataset.page) showPage(tab.dataset.page);
  });

  // Los enlaces "Ver todo el registro" / "Gestionar" del Resumen.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-goto]');
    if (link) showPage(link.dataset.goto);
  });

  // La sidebar es un cajón por debajo de 900 px; arriba de eso siempre está.
  $('#menu-btn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
    $('#sidebar-scrim').classList.toggle('open');
  });
  $('#sidebar-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    clearSession();
    window.location.reload();
  });

  $('#digest-preview').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await showDigestPreview();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      event.target.disabled = false;
    }
  });

  $('#digest-send').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const outcome = await api('/digest/run', { method: 'POST' });
      toast(
        outcome.sent
          ? `Informe enviado a ${outcome.recipients.length} destinatario(s) · ${outcome.changes} cambio(s)`
          : `No se envió: ${REASONS[outcome.reason] ?? outcome.reason}`,
        outcome.sent ? 'ok' : 'err',
      );
      await refreshStatus();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      event.target.disabled = false;
    }
  });

  $('#add-worker').addEventListener('click', () => workerModal(null));
  $('#add-user').addEventListener('click', () => userModal());

  // Los filtros no vuelven a pedir datos: recolocan lo que ya está cargado.
  for (const id of ['#act-search', '#act-web', '#act-kind', '#activity-filter', '#act-date']) {
    $(id)?.addEventListener(id === '#act-search' ? 'input' : 'change', renderActivity);
  }
  $('#web-search')?.addEventListener('input', renderWebsites);
  $('#web-filter')?.addEventListener('change', renderWebsites);

  $('#run-now').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const outcome = await api('/status/run-now', { method: 'POST' });
      toast(
        `Comprobadas ${outcome.websites} web(s) · ${outcome.pagesChanged} página(s) con cambios · ` +
          `${outcome.reported} para el informe` +
          (outcome.failed ? ` · ${outcome.failed} con error` : ''),
        outcome.failed ? '' : 'ok',
      );
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      event.target.disabled = false;
      refreshStatus();
    }
  });

  $('#test-email-all').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const result = await api('/workers/test-email', { method: 'POST' });
      toast(`Email de prueba enviado a ${result.recipients.length} destinatario(s)`, 'ok');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      event.target.disabled = false;
    }
  });

  $('#verify-mail').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const result = await api('/settings/verify-mail', { method: 'POST' });
      toast(`Transporte "${result.transport}" verificado`, 'ok');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      event.target.disabled = false;
    }
  });

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const payload = {
      default_check_interval: form.default_check_interval.value,
      scheduler_tick: form.scheduler_tick.value,
      crawler_concurrency: form.crawler_concurrency.value,
      max_items_per_email: form.max_items_per_email.value,
      log_retention_days: form.log_retention_days.value,
      crawler_enabled: form.crawler_enabled.checked,
      notify_on_first_check: form.notify_on_first_check.checked,
      ai_recovery_enabled: form.ai_recovery_enabled.checked,
      ai_recovery_min_hours: form.ai_recovery_min_hours.value,
      digest_ai_enabled: form.digest_ai_enabled.checked,
      notification_mode: form.notification_mode.value,
      digest_hour: form.digest_hour.value,
      digest_timezone: form.digest_timezone.value,
      report_send_when_empty: form.report_send_when_empty.checked,
    };
    try {
      const { settings } = await api('/settings', { method: 'PUT', body: payload });
      state.settings = settings;
      toast('Configuración guardada', 'ok');
      // La tarjeta del informe muestra el envío en días vacíos, así que tiene
      // que reflejar el cambio en el momento, no en el siguiente refresco.
      await refreshDigest().catch(() => {});
    } catch (error) {
      toast(error.message, 'err');
    }
  });

  const clockText = el('span');
  $('#clock').append(clockText);
  const tickClock = () => {
    clockText.textContent = new Date().toLocaleTimeString('es-ES');
  };
  setInterval(tickClock, 1000);
  tickClock();

  await refreshStatus();
  await loadSettings();
  // Cada 10 s: suficiente para que el panel esté vivo, lo bastante espaciado
  // para no recargar una tabla justo cuando alguien está leyéndola.
  setInterval(() => {
    if (document.hidden) return;
    refreshStatus().catch(() => {});
    if (state.page === 'websites') loadWebsites().catch(() => {});
    if (state.page === 'activity') loadActivity().catch(() => {});
  }, 10000);
}

init().catch((error) => toast(error.message, 'err'));
