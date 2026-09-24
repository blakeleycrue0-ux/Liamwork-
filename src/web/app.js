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
  // Los detalles de la última comprobación, cacheados por id: mientras el
  // panel siga mirando la misma ejecución no hace falta volver a pedirlos.
  runDetailFor: null,
  runDetail: null,
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
    showBanner('The API rejected the request (401). Check AUTH_PROVIDER in Netlify.');
    throw new Error('Not signed in');
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
    icon(kind === 'err' ? 'x-circle' : kind === 'ok' ? 'check-circle' : 'alert', 'icon icon-sm'),
    el('span', { textContent: message }),
  ]);
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 4500);
}

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB');
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-GB');
};

function fmtAgo(iso) {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 0) return `in ${fmtDuration(-seconds)}`;
  if (seconds < 5) return 'just now';
  return `${fmtDuration(seconds)} ago`;
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

/** Long date: "16 September 2026", for titles and headings. */
const fmtLongDay = (value) => {
  if (!value) return '—';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

/** Short date, for a column that has to stay one line wide. */
const fmtDay = (value) => {
  if (!value) return '—';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

/**
 * "today at 07:00", "tomorrow at 07:00", or the date when it is further off.
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

  const time = date.toLocaleTimeString('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit',
  });
  const days = Math.round(
    (new Date(`${dayOf(date)}T12:00:00Z`) - new Date(`${dayOf(new Date())}T12:00:00Z`)) / 86400000,
  );
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  return `${date.toLocaleDateString('en-GB', { timeZone: zone, day: 'numeric', month: 'long' })} at ${time}`;
}

/** Two lines in one cell: the relative time on top, the exact one below. */
const timeCell = (iso) =>
  el('td', { className: 'cell-time' }, [
    el('div', { textContent: fmtAgo(iso) }),
    el('span', { className: 'abs', textContent: iso ? fmtDateTime(iso) : '' }),
  ]);

/** Un estado: punto + palabra. El color solo nunca es el mensaje. */
function stateChip(kind, label) {
  return el('span', { className: `state ${kind}` }, [
    el('span', { className: `dot ${kind}` }),
    el('span', { textContent: label }),
  ]);
}

/** Una prioridad, en versalitas. Sin globos de color. */
const prioChip = (priority) => {
  const look = PRIORITY[priority] ?? PRIORITY.LOW;
  return el('span', { className: `prio ${look.css}`, textContent: look.label });
};

/**
 * El estado de una web, en una celda.
 *
 * El servidor ya manda la frase traducida; aquí no se interpreta nada. Y lo
 * que no llega no se puede enseñar por accidente: el mensaje del crawler no
 * sale de /api/websites/:id/diagnostics.
 */
function statusCell(website) {
  const look = websiteState(website);
  return el('td', {}, [
    el('div', { className: 'status' }, [
      stateChip(look.kind, look.label),
      look.note ? el('span', { className: 'status-note', textContent: look.note }) : '',
    ]),
  ]);
}

/** Marca la columna para que en móvil la fila se lea como una ficha. */
const label = (node, text) => {
  node.dataset.label = text;
  return node;
};

/** Nombre y dirección, el par que identifica una web en todas las tablas. */
/**
 * El nombre de un club abre su ficha.
 *
 * Antes sólo lo hacía un icono pequeño al final de la fila, escondido entre
 * otros tres. El nombre es lo que la gente pulsa, así que el nombre es lo que
 * tiene que responder; el icono sigue existiendo para quien ya lo conocía.
 */
const websiteCell = (website) =>
  el('td', { className: 'primary' }, [
    (() => {
      const name = el('button', {
        className: 'cell-name cell-open',
        type: 'button',
        textContent: website.name,
        title: `Open ${website.name}`,
      });
      name.addEventListener('click', () =>
        showClub(website).catch((error) => toast(error.message, 'err')),
      );
      return name;
    })(),
    el('a', {
      href: website.url,
      target: '_blank',
      rel: 'noopener',
      className: 'cell-url',
      title: website.url,
      textContent: (website.url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    }),
  ]);

/** Cómo está una web ahora mismo, en una palabra. */
function websiteState(website) {
  if (!website.active) return { kind: 'off', label: 'Paused', note: '' };
  if (website.status) {
    return { kind: 'bad', label: website.status.label, note: website.status.note };
  }
  if (!website.last_checked_at) return { kind: 'warn', label: 'Never checked', note: '' };
  return { kind: 'ok', label: 'Correcta', note: '' };
}

/* ------------------------------------------------------------------ modal */
function openModal({ title, fields, submitLabel = 'Save', onSubmit, secondary = null }) {
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
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });

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
  form.append(error, output, el('div', { className: 'form-actions' }, actions));

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
  running: { kind: 'ok', label: 'Checking' },
  idle: { kind: 'ok', label: 'System active' },
  paused: { kind: 'warn', label: 'Paused' },
  stalled: { kind: 'bad', label: 'Not running' },
  never: { kind: 'off', label: 'Never run' },
};

/**
 * Las iniciales de quien tiene el panel delante, para el avatar del header.
 *
 * Un buzón como "acceso@" o "admin@" no es el nombre de nadie: en ese caso se
 * usa el de la configuración, que es a quien pertenece el panel.
 */
const GENERIC_MAILBOX = new Set([
  'acceso', 'admin', 'administrador', 'info', 'no-reply', 'noreply', 'user', 'mail',
]);

const personal = (value) => {
  const first = String(value ?? '').split(/[.\-_\s]+/)[0].toLowerCase();
  return Boolean(first) && !GENERIC_MAILBOX.has(first) && !/^\d+$/.test(first);
};

function initials(brand) {
  // Sin sesión real, /api/auth/me devuelve "Acceso abierto": eso no es nadie.
  const candidates = [state.user?.name, (state.user?.email ?? '').split('@')[0]];
  const raw = candidates.find(personal) || brand?.owner || '';
  const parts = String(raw).split(/[.\-_\s]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  return (letters || String(raw).slice(0, 2) || 'WM').toUpperCase();
}

/** Una frase de estado que dice la verdad, no una que siempre suena bien. */
function headline(data) {
  const failing = data.websites.failing ?? 0;
  // "Sin ejecutarse" es lo único que justifica dar la alarma: quiere decir que
  // el sistema se ha saltado una revisión entera. Que ahora mismo no haya un
  // proceso corriendo no dice nada - entre revisión y revisión nunca lo hay.
  if (data.crawler.status === 'stalled') return 'Monitoring has stopped.';
  if (data.crawler.status === 'paused') return 'Monitoring is paused.';
  if (data.crawler.status === 'never') return 'No first check yet.';
  if (failing) return failing === 1 ? 'One website needs attention.' : `${failing} websites need attention.`;
  return 'Everything under control.';
}

/* ======================================================================
   RESULTADOS DE UNA COMPROBACIÓN

   Lo que se enseña aquí sale de /api/status/runs/:id, atado por run_id, y
   no de "los cambios más recientes de la base de datos". La diferencia
   importa: dos pasadas seguidas producen dos listas distintas, y la de ayer
   sigue siendo consultable mañana.

   El estado no se estima. Mientras la fila de la ejecución está en `running`
   hay una pasada corriendo de verdad; cuando pasa a `done` es porque
   terminó. No se inventa ningún porcentaje ni ninguna barra de progreso,
   porque el crawler no publica progreso parcial y fingirlo sería mentir.
   ====================================================================== */

let runPoll = null;

async function renderRun(run) {
  const section = $('#run-section');
  if (!run) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const running = run.status === 'running';
  $('#run-state').replaceChildren(
    running
      ? stateChip('warn', 'Check in progress…')
      : run.status === 'failed'
        ? stateChip('bad', 'Check interrupted')
        : stateChip('ok', 'Check complete'),
  );
  $('#run-when').textContent =
    `${fmtTime(run.started_at)}${run.origin === 'manual' ? ' · on request' : ''}` +
    (run.duration_ms ? ` · ${fmtDuration(Math.round(run.duration_ms / 1000))}` : '');

  // Los siete recuentos que se pidieron, en el orden en que se leen.
  $('#run-metrics').replaceChildren(
    ...[
      ['Websites checked', run.websites],
      ['Pages checked', run.pages_seen],
      ['Pages that moved', run.pages_changed],
      ['Relevant changes', run.relevant],
      ['Changes ignored', run.ignored],
      ['Drafts', run.drafts],
      ['Websites failing', run.websites_failed],
    ].map(([label, value]) =>
      el('div', { className: 'run-metric' }, [
        el('div', { className: 'value num', textContent: running ? '—' : String(value ?? 0) }),
        el('div', { className: 'label', textContent: label }),
      ]),
    ),
  );

  // Los errores, ya traducidos por el servidor: aquí no llega un código HTTP.
  // Se enseñan los primeros y se cuenta el resto: el día que fallen las
  // veintisiete -pasa, si se cae la red- una lista de veintisiete filas
  // empuja fuera de la pantalla todo lo demás.
  const errors = run.errors ?? [];
  const shown = errors.slice(0, 8);
  $('#run-errors').hidden = !errors.length;
  $('#run-errors').replaceChildren(
    ...shown.map((error) =>
      el('div', { className: 'run-error' }, [
        el('span', { className: 'who', textContent: error.website }),
        el('span', { className: 'what', textContent: error.label ?? 'Could not connect' }),
      ]),
    ),
    ...(errors.length > shown.length
      ? [el('div', { className: 'run-error dim', textContent: `and ${errors.length - shown.length} more website(s)` })]
      : []),
  );

  // Mientras corre no hay nada que listar todavía.
  if (running) {
    $('#run-relevant').replaceChildren();
    $('#run-none').hidden = true;
    $('#run-ignored').hidden = true;
    schedulePoll();
    return;
  }

  // Terminada: se piden los detalles una sola vez por ejecución.
  if (state.runDetailFor !== run.id) {
    let detail;
    try {
      detail = await api(`/status/runs/${run.id}`);
    } catch {
      return;
    }
    state.runDetailFor = run.id;
    state.runDetail = detail;
  }
  paintRunDetail(state.runDetail);
}

function paintRunDetail(detail) {
  if (!detail) return;
  const relevant = detail.relevant ?? [];

  $('#run-none').hidden = relevant.length > 0;
  $('#run-relevant').replaceChildren(...relevant.map(relevantCard));

  // Los ignorados no se pintan: se cuentan. Ciento cuarenta y tres filas de
  // ruido encima del que abre el panel no le dicen nada, y esconden las tres
  // que sí importan.
  const ignored = detail.ignored_count ?? 0;
  $('#run-ignored').hidden = ignored === 0;
  $('#run-ignored-label').textContent =
    `${ignored} change${ignored === 1 ? '' : 's'} ignored`;
  $('#run-ignored-body').replaceChildren(
    ...(detail.ignored ?? []).map((change) =>
      el('div', { className: 'run-skip' }, [
        el('span', { className: 'who', textContent: change.website_name }),
        el('span', { className: 'what', textContent: change.title || '—' }),
        el('span', { className: 'why', textContent: change.reasoning || '' }),
      ]),
    ),
  );
}

/** Un cambio relevante, plegado; se abre para ver el detalle y el borrador. */
function relevantCard(change) {
  const kind = CATEGORIES[change.category] ?? 'Change';
  const type = CHANGE_TYPES[change.change_type] ?? { label: change.change_type };
  const priority = PRIORITY[change.priority] ?? PRIORITY.LOW;

  const head = el('summary', { className: 'run-card-head' }, [
    el('span', { className: 'club', textContent: change.website_name }),
    el('span', { className: 'cat', textContent: kind }),
    el('span', { className: `tag ${change.change_type === 'NEW' ? 'accent' : ''}`, textContent: type.label }),
    el('span', { className: `tag prio-${priority.css}`, textContent: priority.label }),
    el('span', { className: 'title', textContent: change.title || 'Change detected' }),
    el('span', { className: 'when', textContent: fmtTime(change.detected_at) }),
  ]);

  const body = el('div', { className: 'run-card-body' }, [
    change.summary ? el('p', { textContent: change.summary }) : '',
    change.what_changed
      ? el('p', { className: 'muted' }, [
          el('strong', { textContent: 'What changed: ' }),
          change.what_changed,
        ])
      : '',
    change.previous_value && change.new_value
      ? el('div', { className: 'preview-box mono' }, [
          el('div', { textContent: `Antes: ${change.previous_value}` }),
          el('div', { textContent: `Ahora: ${change.new_value}` }),
        ])
      : '',
    change.draft_message
      ? el('div', {}, [
          el('h3', { textContent: 'Draft message' }),
          el('p', { className: 'draft', textContent: change.draft_message }),
        ])
      : '',
    el('div', { className: 'run-card-links' }, [
      change.url
        ? el('a', { className: 'btn-ghost btn-sm', href: change.url, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open the original page' })
        : '',
      change.slack_notified_at
        ? el('span', { className: 'dim', textContent: `Sent to Slack at ${fmtTime(change.slack_notified_at)}` })
        : '',
    ]),
  ]);

  return el('details', { className: 'run-card' }, [head, body]);
}

/**
 * Vuelve a preguntar mientras haya una pasada corriendo.
 *
 * Cinco segundos, y sólo mientras el estado sea `running`: en cuanto la
 * ejecución se cierra, el sondeo para solo. No hace falta recargar la página
 * ni pulsar nada.
 */
function schedulePoll() {
  clearTimeout(runPoll);
  runPoll = setTimeout(() => refreshStatus().catch(() => {}), 5000);
}

async function refreshStatus() {
  let data;
  try {
    data = await api('/status');
  } catch {
    return;
  }
  state.status = data;

  const crawler = data.crawler;
  const look = CRAWLER_STATES[crawler.status] ?? CRAWLER_STATES.idle;
  const failing = data.websites.failing ?? 0;

  /* --- header --- */
  const sysDot = $('#sys-dot');
  sysDot.className = `dot ${look.kind}${crawler.status === 'running' ? ' pulse' : ''}`;
  $('#sys-label').textContent = look.label;
  $('#sys-state').title = crawler.last_run_at
    ? `${look.label} · last check ${fmtAgo(crawler.last_run_at)}`
    : look.label;

  const avatar = $('#avatar');
  avatar.textContent = initials(data.brand);
  avatar.title = state.user?.email ?? data.brand?.credit ?? '';

  /* --- titular --- */
  $('#hero-title').textContent = headline(data);
  $('#hero-line').replaceChildren(
    stateChip(look.kind, look.label),
    el('span', { className: 'sep', textContent: '/' }),
    el('span', { textContent: `${data.websites.active} websites watched` }),
    el('span', { className: 'sep', textContent: '/' }),
    el('span', { textContent: `last check ${fmtAgo(data.checks.last_checked_at)}` }),
    el('span', { className: 'sep', textContent: '/' }),
    el('span', {
      textContent: crawler.next_run_at
        ? `next one ${fmtWhen(crawler.next_run_at, data.report.timezone)}`
        : 'no next check scheduled',
    }),
  );

  /* --- métricas --- */
  $('#s-websites').textContent = String(data.websites.active);
  $('#s-websites-sub').textContent = `${data.websites.total} on the list`;

  $('#s-ok').textContent = String(data.websites.ok ?? 0);
  $('#s-ok-sub').textContent = 'answering normally';

  $('#s-bad').textContent = String(failing);
  $('#s-bad-sub').textContent = failing ? 'the reason is in the table' : 'none refusing to be read';
  $('#metric-bad').className = `metric${failing ? ' is-bad' : ''}`;

  $('#s-news').textContent = String(data.report.pending_changes);
  $('#s-news-sub').textContent = `for ${fmtDay(data.report.covers_date)}`;

  $('#s-workers').textContent = String(data.workers.active);
  $('#s-workers-sub').textContent = `${data.workers.total} registered`;

  $('#s-errors').textContent = String(data.checks.errors_24h);
  $('#s-errors-sub').textContent = data.checks.errors_24h
    ? 'failed checks'
    : 'no check failed';

  /* --- estado del sistema, en filas --- */
  // Lo que se cuenta aquí es producto, no instalación: cuándo miró, cuánto
  // tardó, cuánto trabajo hizo. Ni transportes, ni modelos, ni tokens.
  $('#system-rows').replaceChildren(
    ...[
      ['Monitoring', stateChip(look.kind, look.label)],
      ['Last check', crawler.last_run_at ? fmtTime(crawler.last_run_at) : '—'],
      ['Took', crawler.last_run_duration_ms
        ? fmtDuration(Math.round(crawler.last_run_duration_ms / 1000))
        : '—'],
      ['Next check', crawler.next_run_at
        ? fmtWhen(crawler.next_run_at, data.report.timezone)
        : '—'],
      ...(crawler.overdue_by_ms > 0
        ? [['Running late by', fmtDuration(Math.round(crawler.overdue_by_ms / 1000))]]
        : []),
      ['Analysed this week', `${data.usage_7d.analyses} change(s)`],
      ['Email alerts', data.mail.configured ? stateChip('ok', 'Configured') : stateChip('warn', 'Not configured')],
      // Sólo si hay canal. El webhook no llega nunca al navegador: la API
      // manda un booleano y esto es todo lo que el panel sabe de Slack.
      ['Slack alerts', data.slack?.configured
        ? stateChip('ok', 'Connected')
        : stateChip('off', 'Not configured')],
    ].map(([key, value]) =>
      el('div', {}, [
        el('dt', { textContent: key }),
        el('dd', {}, [value instanceof Node ? value : el('span', { textContent: String(value) })]),
      ]),
    ),
  );

  /* --- los resultados de la última comprobación --- */
  renderRun(data.last_run).catch(() => {});

  /* --- actividad reciente --- */
  $('#recent-posts').replaceChildren(
    ...(data.recent_changes.length
      ? data.recent_changes.slice(0, 6).map((change) => changeRow(change))
      : [emptyRow(6, 'No change has been detected yet')]),
  );

  $('#mail-info').textContent = data.mail.configured
    ? 'Outgoing mail is configured. The credentials live in environment variables, never in the dashboard.'
    : 'No mail server is configured: the report cannot go out.';
  if (data.brand?.credit) $('#footer-credit').textContent = data.brand.credit;

  await Promise.all([refreshDigest().catch(() => {}), refreshSummaryWebsites().catch(() => {})]);
}

const emptyRow = (columns, message) =>
  el('tr', {}, [el('td', { colSpan: columns, className: 'empty', textContent: message })]);

/**
 * Las webs en el Resumen, con las que fallan arriba.
 *
 * Es la misma verdad que la página de Webs, sin los botones: quien abre el
 * panel por la mañana ve de una vez qué respondió y qué no.
 */
async function refreshSummaryWebsites() {
  const { websites } = await api('/websites');
  state.websites = websites;

  const ordered = websites.slice().sort((a, b) => {
    const rank = (site) => (site.failing ? 0 : site.active ? 2 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, 'en');
  });

  const count = $('#summary-web-count');
  if (count) count.textContent = `${websites.length}`;

  $('#summary-websites').replaceChildren(
    ...(ordered.length
      ? ordered.map((website) => {
          const look = websiteState(website);
          return el('tr', {}, [
            websiteCell(website),
            label(statusCell(website), 'Status'),
            label(el('td', { className: 'cell-time dim', textContent: fmtAgo(website.last_checked_at) }), 'Checked'),
            label(
              el('td', { className: 'muted' }, [
                el('span', {
                  className: 'cell-text',
                  title: website.last_new_item_title || '',
                  textContent: website.last_new_item_title || 'Nothing new',
                }),
              ]),
              'Change',
            ),
          ]);
        })
      : [emptyRow(4, 'The website list is empty')]),
  );
}

/** Cómo se dice cada veredicto y cada prioridad, en un solo sitio. */
const PRIORITY = {
  HIGH: { css: 'high', label: 'High' },
  MEDIUM: { css: 'medium', label: 'Medium' },
  LOW: { css: 'low', label: 'Low' },
};

const CHANGE_TYPES = {
  NEW: { label: 'New', tag: 'accent' },
  UPDATED: { label: 'Updated', tag: '' },
  UNCHANGED: { label: 'No changes', tag: '' },
  IGNORED: { label: 'Irrelevant', tag: '' },
};

/**
 * Las seis categorías que sí entran en el informe. Espejo de
 * RELEVANT_CATEGORIES en src/monitor/analyze.js: el navegador no puede
 * importar código del servidor, así que los nombres viven en dos sitios y
 * una prueba comprueba que no se separen.
 */
const CATEGORIES = {
  TOURNAMENTS: 'Tournaments',
  NEWS_EVENTS: 'News & events',
  PRACTICE: 'Practice & lessons',
  RESTAURANT: 'Restaurant',
  CLUB_SECTIONS: 'Club sections',
  COURSE_INFO: 'Course information',
};

/** Una fila del log: hora, web, evento, resultado, prioridad, estado. */
function changeRow(change) {
  const type = CHANGE_TYPES[change.change_type] ?? { label: change.change_type, tag: '' };
  const reportable = ['NEW', 'UPDATED'].includes(change.change_type);

  const row = el('tr', { className: 'clickable' }, [
    label(el('td', { className: 'cell-time dim', textContent: fmtTime(change.detected_at) }), 'Hora'),
    label(el('td', { className: 'primary cell-name', textContent: change.website_name }), 'Website'),
    label(el('td', { className: 'muted', textContent: 'Change detected' }), 'Evento'),
    label(
      el('td', {}, [
        el('span', { className: `tag ${type.tag}`, textContent: type.label }),
      ]),
      'Resultado',
    ),
    reportable
      ? label(el('td', {}, [prioChip(change.priority)]), 'Prioridad')
      : el('td', { className: 'is-blank' }, [el('span', { className: 'prio low', textContent: '—' })]),
    label(
      el('td', {}, [
        reportable
          ? change.reported_in
            ? stateChip('ok', 'Reported')
            : stateChip('warn', 'Pending')
          : stateChip('off', 'Descartado'),
      ]),
      'Estado',
    ),
  ]);
  row.title = [change.title, change.summary].filter(Boolean).join(' — ');
  row.addEventListener('click', () => showChangeAudit(change.id).catch((error) => toast(error.message, 'err')));
  return row;
}

async function showChangeAudit(id) {
  const { change, audit, versions } = await api(`/reports/changes/${id}`);
  const modal = el('div', { className: 'modal' }, [
    el('h2', { textContent: change.title || 'Change detected' }),
    el('div', {
      className: 'hint',
      textContent:
        `${change.website_name} · ${fmtLongDay(change.change_date)} · ` +
        `${(CHANGE_TYPES[change.change_type] ?? { label: change.change_type }).label} · ` +
        (CATEGORIES[change.category] ? `${CATEGORIES[change.category]} · ` : '') +
        `${(PRIORITY[change.priority] ?? PRIORITY.LOW).label.toLowerCase()} priority`,
    }),
    change.summary ? el('p', { textContent: change.summary }) : '',
    change.what_changed ? el('p', {}, [el('strong', { textContent: 'What changed: ' }), change.what_changed]) : '',
    change.previous_value && change.new_value
      ? el('div', { className: 'preview-box mono' }, [
          el('div', { textContent: `Antes: ${change.previous_value}` }),
          el('div', { textContent: `Ahora: ${change.new_value}` }),
        ])
      : '',
    // El borrador es lo que alguien viene a buscar aquí: va antes del
    // razonamiento, entero y seleccionable, no plegado dentro de un detalle.
    change.draft_message
      ? el('div', {}, [
          el('h3', { textContent: 'Draft message' }),
          el('p', { className: 'draft', textContent: change.draft_message }),
        ])
      : '',
    // Por qué se decidió así. El razonamiento sí es del producto: explica el
    // veredicto. El recuento de tokens y el nombre del modelo no, así que se
    // quedan detrás de "Ver el texto comparado", plegado y sin cifras.
    el('h3', { textContent: 'Why' }),
    el('p', { className: 'muted', textContent: change.reasoning || 'No explanation recorded.' }),
    el('details', {}, [
      el('summary', { textContent: 'See the compared text' }),
      el('pre', { className: 'preview-box mono', textContent: audit.input || '—' }),
      versions.before
        ? el('pre', {
            className: 'preview-box mono',
            textContent: versions.before.text.slice(0, 4000),
          })
        : '',
    ]),
  ]);

  const close = el('button', { textContent: 'Close' });
  modal.append(el('div', { className: 'form-actions' }, [close]));
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
    ? `${pending} change${pending === 1 ? '' : 's'} waiting for the report`
    : 'No changes pending';

  $('#digest-meta').textContent =
    `Covers ${fmtLongDay(digest.covers_date)} · goes out at ` +
    `${String(digest.hour).padStart(2, '0')}:00 (${digest.timezone})`;

  $('#digest-next').replaceChildren(
    el('span', { textContent: fmtWhen(digest.next_report_at, digest.timezone) }),
  );

  $('#digest-last').replaceChildren(
    el('span', {
      textContent: digest.last_sent_date ? `The one for ${fmtDay(digest.last_sent_date)}` : 'None yet',
    }),
  );

  $('#digest-pending').replaceChildren(
    el('span', { textContent: pending ? `${pending} for ${fmtDay(digest.covers_date)}` : 'Ninguno' }),
  );

  // El dato que decide si un día tranquilo genera correo o silencio. Sale del
  // valor real de report_send_when_empty, y se escribe con todas las letras.
  const on = Boolean(digest.send_when_empty);
  $('#digest-empty').replaceChildren(
    el('span', { className: `flag ${on ? 'on' : 'off'}` }, [
      el('span', { className: 'track' }),
      el('span', { textContent: on ? 'ON' : 'OFF' }),
    ]),
    el('span', {
      className: 'note',
      textContent: on ? 'a quiet day still sends an email' : 'a quiet day sends nothing',
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
  const origin = attempt.origin === 'manual' ? 'a mano' : 'automatic';
  const verb =
    attempt.outcome === 'enviado'
      ? `Sent ${origin}`
      : attempt.outcome === 'fallido'
        ? `The ${origin} send failed`
        : `Not sent (${origin})`;

  box.className = `attempt ${look.className}`;
  box.hidden = false;
  box.replaceChildren(
    icon(look.icon, 'icon icon-sm'),
    el('div', {}, [
      el('div', {}, [
        el('strong', { textContent: verb }),
        ` · report for ${fmtDay(attempt.date)} · ${fmtAgo(attempt.at)}`,
      ]),
      attempt.reason ? el('span', { className: 'note', textContent: attempt.reason }) : '',
      attempt.outcome === 'enviado' && attempt.recipients
        ? el('span', {
            className: 'note',
            textContent: `${attempt.recipients} recipient(s) · ${attempt.changes} change(s)`,
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
    el('h2', { textContent: `Report for ${fmtLongDay(date)}` }),
    el('div', { className: 'hint' }, [
      `This is how the email would look · ${report.total_changes} change(s): ` +
        `${report.high_priority} high priority, ${report.medium_priority} medium, ${report.low_priority} low`,
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
              item.what_changed ? el('div', { className: 'where', textContent: `What changed: ${item.what_changed}` }) : '',
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
    report.total_changes ? '' : el('div', { className: 'empty', textContent: 'Nothing to report that day.' }),
  ]);

  const close = el('button', { textContent: 'Close' });
  modal.append(el('div', { className: 'form-actions' }, [close]));
  const backdrop = el('div', { className: 'modal-backdrop' }, [modal]);
  close.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) backdrop.remove(); });
  $('#modal-root').append(backdrop);
}

/* ----------------------------------------------------------- websites tab */
const websiteFields = (website = {}) => [
  { name: 'name', label: 'Name', value: website.name, required: true, placeholder: 'FFSP' },
  { name: 'url', label: 'URL', type: 'url', value: website.url, required: true, placeholder: 'https://ffsp.info' },
  {
    name: 'check_interval',
    label: 'Check interval (seconds)',
    type: 'number',
    min: 10,
    max: 86400,
    value: website.check_interval ?? state.settings.default_check_interval ?? 60,
  },
  {
    name: 'detection_method',
    label: 'Detection method',
    type: 'select',
    value: website.detection_method ?? 'auto',
    options: [
      { value: 'auto', label: 'Auto (RSS if present, otherwise HTML)' },
      { value: 'rss', label: 'RSS / Atom' },
      { value: 'html', label: 'Scraping HTML' },
      { value: 'browser', label: 'Navegador headless (Playwright)' },
    ],
  },
  {
    name: 'feed_url',
    label: 'RSS URL (optional)',
    value: website.selector_config?.feed_url ?? '',
    hint: 'If the website has RSS, it is always preferred over scraping.',
  },
  { name: 'list', label: 'CSS selector for the listing (optional)', value: website.selector_config?.list ?? '', placeholder: '.news-list article' },
  { name: 'title', label: 'Selector for the title (optional)', value: website.selector_config?.title ?? '', placeholder: 'h2 a' },
  { name: 'link', label: 'Selector for the link (optional)', value: website.selector_config?.link ?? '', placeholder: 'a' },
  { name: 'date', label: 'Selector for the date (optional)', value: website.selector_config?.date ?? '', placeholder: 'time' },
  { name: 'active', label: 'Active', type: 'checkbox', value: website.id ? website.active : true },
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
      el('div', { style: 'font-weight:600', textContent: 'No entries were detected' }),
      el('div', { className: 'hint', textContent: `Method used: ${preview.method} · ${preview.source}` }),
      el('div', {
        className: 'hint',
        textContent:
          'This website has no recognisable RSS and its listing does not match automatic detection. ' +
          'Fill in "CSS selector for the listing" (and optionally title and link) with the classes of the block ' +
          'around each entry, then try again.',
      }),
    );
    return;
  }

  output.replaceChildren(
    el('div', { style: 'font-weight:600', textContent: `Detectadas ${preview.total} publicaciones` }),
    el('div', { className: 'hint', textContent: `Method used: ${preview.method} · ${preview.source}` }),
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
    el('div', { style: 'font-weight:600', textContent: `The AI found ${detection.total} entries` }),
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
        ? 'The selectors above are filled in. Save, and future checks will not use the AI.'
        : 'If the website loads its content with JavaScript, there is nothing to read in the HTML.',
    }),
  );
}

/** Shows what the page contains, so a broken listing can be configured. */
async function inspectSite(values, output) {
  const payload = toWebsitePayload({ ...values, name: values.name || 'Diagnosis' });
  const { inspection } = await api('/websites/inspect', { method: 'POST', body: payload });

  const line = (label, value) =>
    el('div', {}, [el('span', { className: 'hint', textContent: `${label}: ` }), String(value)]);

  const nodes = [
    el('div', { style: 'font-weight:600', textContent: 'What the page contains' }),
    line('Descargado', `${Math.round(inspection.bytes / 1024)} KB`),
    line('Texto visible', `${inspection.visible_text_length} caracteres`),
    line('Links with text', inspection.total_links),
  ];

  if (inspection.likely_javascript) {
    nodes.push(
      el('div', {
        className: 'error-text',
        textContent:
          'This website loads its content with JavaScript: the HTML arrives almost empty, so there is nothing to read.',
      }),
    );
  }

  if (inspection.feeds.length) {
    nodes.push(line('RSS encontrado', inspection.feeds.join(', ')));
  }

  if (inspection.candidates.length) {
    nodes.push(
      el('div', { style: 'font-weight:600;margin-top:8px', textContent: 'Repeating blocks' }),
      el(
        'ul',
        { style: 'margin:4px 0 0;padding-left:18px' },
        inspection.candidates.map((candidate) =>
          el('li', {}, [
            el('span', { className: 'mono', textContent: candidate.selector }),
            ` — ${candidate.count} (${candidate.withLink} with a link)`,
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
    title: `Edit ${website.name}`,
    fields: websiteFields(website),
    submitLabel: 'Save changes',
    secondary: [
      { label: 'Test detection', onClick: previewDetection },
      { label: 'Diagnosis', onClick: inspectSite, pending: 'Reading the page…' },
    ],
    onSubmit: async (values) => {
      await api(`/websites/${website.id}`, { method: 'PUT', body: toWebsitePayload(values) });
      toast('Website updated', 'ok');
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
        ? `${state.websites.length} websites`
        : `${rows.length} of ${state.websites.length}`;
  }

  const body = $('#websites-body');
  if (!state.websites.length) return body.replaceChildren(emptyRow(5, 'The website list is empty.'));
  if (!rows.length) return body.replaceChildren(emptyRow(5, 'No website matches this filter.'));

  body.replaceChildren(
    ...rows.map((website) => {
      const look = websiteState(website);

      const checkBtn = el('button', { className: 'btn-sm btn-ghost' }, [
        el('span', { textContent: 'Check' }),
      ]);
      checkBtn.addEventListener('click', async () => {
        const text = checkBtn.querySelector('span');
        checkBtn.disabled = true;
        text.textContent = 'Checking…';
        try {
          const { result } = await api(`/websites/${website.id}/check`, { method: 'POST' });
          if (result.ok) {
            toast(
              `${website.name}: ${result.itemsFound} page(s), ${result.newItems} changed` +
                (result.baseline ? ' · baseline' : '') +
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
          text.textContent = 'Check';
          await loadWebsites();
          refreshStatus();
        }
      });

      // Las acciones secundarias van como icono con su título: cuatro botones
      // de texto por fila dejaban la tabla más ancha que la pantalla.
      const iconAction = (name, title, onClick) => {
        const button = el(
          'button',
          { className: 'btn-ghost icon-btn', title, ariaLabel: title, type: 'button' },
          [icon(name, 'icon icon-sm')],
        );
        button.addEventListener('click', onClick);
        return button;
      };

      const actions = [
        checkBtn,
        iconAction('file', 'Open the club', () =>
          showClub(website).catch((error) => toast(error.message, 'err')),
        ),
        iconAction('settings', 'Edit how it is read', () => websiteModal(website)),
        iconAction(
          website.active ? 'pause' : 'check',
          website.active ? 'Stop watching it' : 'Watch it again',
          async () => {
            await api(`/websites/${website.id}/toggle`, { method: 'POST', body: { active: !website.active } });
            await loadWebsites();
            refreshStatus();
          },
        ),
      ];

      return el('tr', {}, [
        websiteCell(website),
        label(statusCell(website), 'Status'),
        label(
          el('td', { className: 'cell-time dim', title: fmtDateTime(website.last_checked_at) }, [
            el('span', { textContent: fmtAgo(website.last_checked_at) }),
          ]),
          'Comprobada',
        ),
        label(
          el('td', { className: 'muted' }, [
            el('span', {
              className: 'cell-text',
              title: website.last_new_item_title || '',
              textContent: website.last_new_item_title || 'Nothing new',
            }),
          ]),
          'Change',
        ),
        el('td', { className: 'actions' }, [el('div', { className: 'row-actions' }, actions)]),
      ]);
    }),
  );
}

/**
 * Un club, de un vistazo.
 *
 * Lo que alguien quiere al pulsar sobre un club no es una tabla de filas
 * cortadas: es saber qué ha pasado ahí. Así que primero los números, y
 * después CADA cambio con su titular grande y su descripción entera - no la
 * frase de resumen recortada a una línea, que es lo que cabe en una tabla y
 * lo que no sirve para decidir nada.
 *
 * Los descartados no se pintan: se cuentan, y se despliegan si alguien quiere
 * mirarlos. Misma regla que en los resultados de una comprobación, y por el
 * mismo motivo: el ruido esconde lo que importa.
 */
async function showClub(website) {
  const [{ changes = [], pages = [] }, { logs = [] }] = await Promise.all([
    api(`/websites/${website.id}/posts?limit=60`),
    api(`/websites/${website.id}/logs?limit=20`),
  ]);

  const relevant = changes.filter((change) => ['NEW', 'UPDATED'].includes(change.change_type));
  const ignored = changes.filter((change) => !['NEW', 'UPDATED'].includes(change.change_type));
  const look = websiteState(website);

  const metric = (value, label) =>
    el('div', { className: 'run-metric' }, [
      el('div', { className: 'value num', textContent: String(value) }),
      el('div', { className: 'label', textContent: label }),
    ]);

  const modal = el('div', { className: 'modal modal-wide' }, [
    el('h2', { textContent: website.name }),
    el('div', { className: 'hint' }, [
      el('a', {
        href: website.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        textContent: (website.url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      }),
    ]),
    el('div', { className: 'club-state' }, [stateChip(look.kind, look.label)]),
    el('div', { className: 'run-metrics club-metrics' }, [
      metric(pages.length, 'Pages tracked'),
      metric(relevant.length, 'Relevant changes'),
      metric(ignored.length, 'Discarded'),
      metric(website.consecutive_errors ?? 0, 'Failed checks'),
    ]),
    el('div', { className: 'hint', textContent: `Last checked ${fmtAgo(website.last_checked_at)}` }),
  ]);

  modal.append(el('h3', { textContent: 'What has happened' }));
  modal.append(
    relevant.length
      ? el('div', { className: 'club-changes' }, relevant.map(clubChange))
      : el('p', { className: 'muted', textContent: 'No relevant changes recorded for this club yet.' }),
  );

  if (ignored.length) {
    modal.append(
      el('details', { className: 'run-ignored' }, [
        el('summary', {
          textContent: `${ignored.length} change${ignored.length === 1 ? '' : 's'} discarded`,
        }),
        el(
          'div',
          { className: 'run-ignored-body' },
          ignored.map((change) =>
            el('div', { className: 'run-skip' }, [
              el('span', { className: 'who', textContent: fmtDateTime(change.detected_at) }),
              el('span', { className: 'what', textContent: change.title || '—' }),
            ]),
          ),
        ),
      ]),
    );
  }

  modal.append(
    el('details', { className: 'run-ignored' }, [
      el('summary', { textContent: `Last ${logs.length} check${logs.length === 1 ? '' : 's'}` }),
      el(
        'div',
        { className: 'run-ignored-body' },
        logs.map((log) =>
          el('div', { className: 'run-skip' }, [
            el('span', { className: 'who', textContent: fmtDateTime(log.checked_at) }),
            el('span', {
              className: 'what',
              textContent: log.success
                ? `${log.items_found} page(s) read, ${log.new_items} changed`
                : 'Check failed',
            }),
          ]),
        ),
      ),
    ]),
  );

  const closeBtn = el('button', { textContent: 'Close' });
  modal.append(el('div', { className: 'form-actions' }, [closeBtn]));
  const backdrop = el('div', { className: 'modal-backdrop' }, [modal]);
  closeBtn.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) backdrop.remove();
  });
  $('#modal-root').append(backdrop);
}

/**
 * Un cambio dentro de la ficha del club: titular y descripción, abiertos.
 *
 * Aquí NO se pliega. En los resultados de una comprobación hay trece webs
 * compitiendo por el sitio y plegar tiene sentido; dentro de un club el
 * lector ya ha elegido de qué quiere leer, y hacerle pulsar otra vez sobre
 * cada línea para ver una frase es trabajo que no pidió.
 */
function clubChange(change) {
  const kind = CATEGORIES[change.category] ?? null;
  const type = CHANGE_TYPES[change.change_type] ?? { label: change.change_type };
  const priority = PRIORITY[change.priority] ?? PRIORITY.LOW;

  return el('article', { className: 'club-change' }, [
    el('div', { className: 'club-change-meta' }, [
      el('span', {
        className: `tag ${change.change_type === 'NEW' ? 'accent' : ''}`,
        textContent: type.label,
      }),
      kind ? el('span', { className: 'cat', textContent: kind }) : '',
      el('span', { className: `tag prio-${priority.css}`, textContent: priority.label }),
      el('span', { className: 'when', textContent: fmtDateTime(change.detected_at) }),
    ]),

    // El titular, grande y enlazado a la página de la que salió.
    el('h4', { className: 'club-change-title' }, [
      change.url
        ? el('a', {
            href: change.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            textContent: change.title || 'Change detected',
          })
        : el('span', { textContent: change.title || 'Change detected' }),
    ]),

    // Y la descripción entera: el resumen Y lo que cambió, no una de las dos.
    change.summary ? el('p', { className: 'club-change-body', textContent: change.summary }) : '',
    change.what_changed
      ? el('p', { className: 'club-change-body muted' }, [
          el('strong', { textContent: 'What changed: ' }),
          change.what_changed,
        ])
      : '',
    change.previous_value && change.new_value
      ? el('div', { className: 'preview-box mono' }, [
          el('div', { textContent: `Before: ${change.previous_value}` }),
          el('div', { textContent: `After: ${change.new_value}` }),
        ])
      : '',
    change.draft_message
      ? el('div', {}, [
          el('h3', { textContent: 'Draft message' }),
          el('p', { className: 'draft', textContent: change.draft_message }),
        ])
      : '',
  ]);
}

/* ------------------------------------------------------------ workers tab */
function workerModal(worker) {
  openModal({
    title: worker ? `Edit ${worker.name}` : 'Add worker',
    fields: [
      { name: 'name', label: 'Name', value: worker?.name, required: true },
      { name: 'email', label: 'Email', type: 'email', value: worker?.email, required: true },
      { name: 'active', label: 'Active', type: 'checkbox', value: worker ? worker.active : true },
    ],
    submitLabel: worker ? 'Save changes' : 'Add',
    onSubmit: async (values) => {
      const payload = { name: values.name, email: values.email, active: values.active };
      if (worker) await api(`/workers/${worker.id}`, { method: 'PUT', body: payload });
      else await api('/workers', { method: 'POST', body: payload });
      toast(worker ? 'Trabajador actualizado' : 'Worker added', 'ok');
      await loadWorkers();
      refreshStatus();
    },
  });
}

async function loadWorkers() {
  // Los intentos de envío son el único dato real de "actividad" que tiene un
  // trabajador: cuándo le llegó el último informe. Si nunca recibió uno, se
  // dice; no se rellena con nada inventado.
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

  const count = $('#worker-count');
  if (count) {
    const active = workers.filter((worker) => worker.active).length;
    count.textContent = `${active} active of ${workers.length}`;
  }

  const body = $('#workers-body');
  if (!workers.length) return body.replaceChildren(emptyRow(5, 'No workers configured.'));

  body.replaceChildren(
    ...workers.map((worker) => {
      const iconAction = (name, title, onClick, className = 'btn-ghost icon-btn') => {
        const button = el('button', { className, title, ariaLabel: title, type: 'button' }, [
          icon(name, 'icon icon-sm'),
        ]);
        button.addEventListener('click', onClick);
        return button;
      };

      const testBtn = iconAction('mail', 'Send a test email', async () => {
        testBtn.disabled = true;
        try {
          await api(`/workers/${worker.id}/test-email`, { method: 'POST' });
          toast(`Test email sent to ${worker.email}`, 'ok');
        } catch (error) {
          toast(error.message, 'err');
        } finally {
          testBtn.disabled = false;
        }
      });

      const editBtn = iconAction('settings', 'Edit', () => workerModal(worker));

      const toggleBtn = iconAction(
        worker.active ? 'pause' : 'check',
        worker.active ? 'Stop sending them the report' : 'Send them the report again',
        async () => {
          await api(`/workers/${worker.id}/toggle`, { method: 'POST', body: { active: !worker.active } });
          await loadWorkers();
          refreshStatus();
        },
      );

      const deleteBtn = iconAction(
        'x-circle',
        'Delete',
        async () => {
          if (!confirmDialog(`Remove ${worker.name}? They will stop receiving the daily report.`)) return;
          try {
            await api(`/workers/${worker.id}`, { method: 'DELETE' });
            toast('Trabajador eliminado', 'ok');
            await loadWorkers();
            refreshStatus();
          } catch (error) {
            toast(error.message, 'err');
          }
        },
        'btn-ghost icon-btn danger-hover',
      );
      deleteBtn.style.color = 'var(--fg-3)';
      deleteBtn.addEventListener('mouseenter', () => { deleteBtn.style.color = 'var(--bad)'; });
      deleteBtn.addEventListener('mouseleave', () => { deleteBtn.style.color = 'var(--fg-3)'; });

      const last = lastFor(worker.email);

      return el('tr', {}, [
        label(el('td', { className: 'primary cell-name', textContent: worker.name }), 'Name'),
        label(el('td', { className: 'mono dim', textContent: worker.email }), 'Email'),
        label(
          el('td', {}, [worker.active ? stateChip('ok', 'Active') : stateChip('off', 'Inactivo')]),
          'Estado',
        ),
        label(
          el('td', { className: 'muted' }, [
            el('span', {
              textContent: last ? `Report ${fmtAgo(last.attempted_at)}` : 'No reports yet',
              title: last ? `Report for ${fmtLongDay(last.report_date)}` : '',
            }),
          ]),
          'Last activity',
        ),
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
 * Antes eran dos tablas separadas y ninguna contaba los informes, que es justo
 * lo que había que mirar la mañana que el correo no llegó. Las tres fuentes ya
 * existían; aquí se ordenan juntas por hora.
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
      event: 'Check',
      ok: Boolean(log.success),
      state: log.success ? 'ok' : 'bad',
      result: log.success ? 'Comprobada' : (log.outcome ?? 'Unavailable'),
      priority: null,
      detail: log.success
        ? `${log.items_found} page(s) read, ${log.new_items} changed`
        : log.outcome ?? 'Could not be checked',
      search: `${log.website_name} ${log.outcome ?? ''}`,
    })),
    ...changes.map((change) => {
      const type = CHANGE_TYPES[change.change_type] ?? { label: change.change_type };
      const reportable = ['NEW', 'UPDATED'].includes(change.change_type);
      return {
        at: change.detected_at,
        website: change.website_name,
        kind: 'change',
        event: reportable
          ? change.change_type === 'NEW'
            ? 'New content'
            : 'Page updated'
          : change.change_type === 'UNCHANGED'
            ? 'No changes'
            : 'Change discarded',
        ok: true,
        state: reportable ? 'info' : 'off',
        result: reportable ? 'Goes in the report' : 'Not in the report',
        priority: reportable ? change.priority : null,
        detail: [change.title, change.summary].filter(Boolean).join(' — ') || '—',
        changeId: change.id,
        search: `${change.website_name} ${change.title ?? ''} ${change.summary ?? ''} ${change.change_type}`,
      };
    }),
    ...attempts.map((attempt) => ({
      at: attempt.attempted_at,
      website: '—',
      kind: 'report',
      event: attempt.origin === 'manual' ? 'Report sent by hand' : 'Automatic report',
      ok: attempt.outcome === 'enviado',
      state: attempt.outcome === 'enviado' ? 'ok' : attempt.outcome === 'fallido' ? 'bad' : 'off',
      result:
        attempt.outcome === 'enviado'
          ? 'Sent'
          : attempt.outcome === 'fallido'
            ? 'Could not be sent'
            : 'Not needed',
      priority: null,
      detail:
        `For ${fmtDay(attempt.report_date)}, with ${attempt.changes} change(s)` +
        (attempt.recipients?.length ? ` · ${attempt.recipients.length} recipient(s)` : ''),
      search: `report ${attempt.origin} ${attempt.outcome}`,
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  state.activity = events;
  fillWebFilter(events);
  renderActivity();
}

/** El desplegable de webs se rellena con las que de verdad aparecen. */
function fillWebFilter(events) {
  const select = $('#act-web');
  if (!select) return;
  const current = select.value;
  const names = [...new Set(events.map((event) => event.website))].filter((name) => name !== '—').sort();
  select.replaceChildren(
    el('option', { value: 'all', textContent: 'All websites' }),
    ...names.map((name) => el('option', { value: name, textContent: name })),
  );
  if (names.includes(current) || current === 'all') select.value = current;
}

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
        : `${rows.length} of ${state.activity.length}`;
  }

  $('#activity-body').replaceChildren(
    ...(rows.length
      ? rows.slice(0, 300).map((event) => {
          const row = el('tr', { className: event.changeId ? 'clickable' : '' }, [
            label(
              el('td', { className: 'cell-time dim', title: fmtDateTime(event.at) }, [
                el('span', { textContent: fmtTime(event.at) }),
              ]),
              'Hora',
            ),
            label(el('td', { className: 'primary cell-name', textContent: event.website }), 'Website'),
            label(el('td', { className: 'muted', textContent: event.event }), 'Evento'),
            label(el('td', {}, [stateChip(event.state, event.result)]), 'Resultado'),
            event.priority
              ? label(el('td', {}, [prioChip(event.priority)]), 'Prioridad')
              : el('td', { className: 'is-blank' }, [el('span', { className: 'prio low', textContent: '—' })]),
            label(
              el('td', { className: 'muted' }, [
                el('span', { className: 'cell-text', title: event.detail, textContent: event.detail }),
              ]),
              'Detalle',
            ),
          ]);
          if (event.changeId) {
            row.addEventListener('click', () =>
              showChangeAudit(event.changeId).catch((error) => toast(error.message, 'err')),
            );
          }
          return row;
        })
      : [emptyRow(6, 'No events match these filters.')]),
  );
}

/* -------------------------------------------------------------- users tab */
/** Dashboard users (Supabase Auth). Different from workers, who only receive
 *  the alert emails. */
function userModal() {
  openModal({
    title: 'Add user',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true, hint: 'At least 8 characters.' },
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
    title: `Change password · ${user.email}`,
    fields: [
      { name: 'password', label: 'New password', type: 'password', required: true, hint: 'At least 8 characters.' },
    ],
    submitLabel: 'Save',
    onSubmit: async (values) => {
      await api(`/users/${user.id}/password`, { method: 'PUT', body: { password: values.password } });
      toast('Password updated', 'ok');
    },
  });
}

async function loadUsers() {
  const { users } = await api('/users');
  state.users = users;
  const body = $('#users-body');

  if (!users.length) return body.replaceChildren(emptyRow(4, 'No users.'));

  body.replaceChildren(
    ...users.map((user) => {
      const passwordBtn = el('button', { className: 'btn-sm btn-ghost', textContent: 'Password' });
      passwordBtn.addEventListener('click', () => passwordModal(user));

      const deleteBtn = el('button', { className: 'btn-sm btn-danger', textContent: 'Delete' });
      deleteBtn.disabled = user.id === state.user?.id;
      deleteBtn.addEventListener('click', async () => {
        if (!confirmDialog(`Remove access for ${user.email}?`)) return;
        try {
          await api(`/users/${user.id}`, { method: 'DELETE' });
          toast('Usuario eliminado', 'ok');
          await loadUsers();
        } catch (error) {
          toast(error.message, 'err');
        }
      });

      return el('tr', {}, [
        label(
          el('td', { className: 'primary cell-name' }, [
            user.email,
            user.id === state.user?.id ? el('span', { className: 'cell-sub', textContent: '  (you)' }) : '',
          ]),
          'Email',
        ),
        label(el('td', { className: 'dim', textContent: fmtDay(user.created_at) }), 'Alta'),
        label(
          el('td', { className: 'muted', textContent: user.last_sign_in_at ? fmtAgo(user.last_sign_in_at) : 'never' }),
          'Last sign-in',
        ),
        el('td', { className: 'actions' }, [
          el('div', { className: 'row-actions' }, [passwordBtn, deleteBtn]),
        ]),
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
  'already-sent': 'that day\u2019s report had already been sent',
  'no-changes': 'there were no changes and sending on quiet days is switched off',
  'no-active-workers': 'there is no active worker to send it to',
};

const PAGE_TITLES = {
  summary: 'Resumen',
  websites: 'Webs',
  workers: 'Trabajadores',
  activity: 'Actividad',
  users: 'Usuarios',
  settings: 'Settings',
};

function closeMenu() {
  $('#mobile-nav')?.classList.remove('open');
  $('#menu-btn')?.setAttribute('aria-expanded', 'false');
}

/**
 * El menú móvil se construye a partir de las mismas pestañas del header, así
 * que no hay dos listas de navegación que puedan quedarse desincronizadas.
 */
function buildMobileNav() {
  const sheet = $('#mobile-nav');
  const items = [...document.querySelectorAll('#tabs .nav-item')]
    .filter((tab) => !tab.hidden)
    .map((tab) => tab.dataset.page)
    .concat('settings');

  sheet.replaceChildren(
    ...items.map((page) => {
      const button = el('button', {
        type: 'button',
        textContent: PAGE_TITLES[page],
        className: page === state.page ? 'active' : '',
      });
      button.dataset.page = page;
      button.addEventListener('click', () => showPage(page));
      return button;
    }),
  );
}

function showPage(page) {
  state.page = page;
  document.title = PAGE_TITLES[page] ? `${PAGE_TITLES[page]} · WebMonitor` : 'WebMonitor';

  for (const tab of document.querySelectorAll('#tabs .nav-item')) {
    tab.classList.toggle('active', tab.dataset.page === page);
  }
  for (const section of document.querySelectorAll('.page')) {
    section.classList.toggle('active', section.id === `page-${page}`);
  }
  $('#nav-settings')?.classList.toggle('active', page === 'settings');
  for (const button of document.querySelectorAll('#mobile-nav button')) {
    button.classList.toggle('active', button.dataset.page === page);
  }
  closeMenu();
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
    showBanner('The API is not responding. Open /api/diagnostics to see why.');
  }
  state.csrfToken = me?.csrfToken ?? null;
  state.user = me?.user ?? storedUser();

  $('#logout').hidden = state.provider === 'none';

  if (state.provider === 'supabase') {
    document.getElementById('tab-users').hidden = false;
  }
  buildMobileNav();

  document.getElementById('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.nav-item');
    if (tab?.dataset.page) showPage(tab.dataset.page);
  });

  // Los enlaces "Ver todo el registro" / "Gestionar" del Resumen.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-goto]');
    if (link) showPage(link.dataset.goto);
  });

  // Por debajo de 900 px la navegación central se pliega en una hoja.
  $('#menu-btn').addEventListener('click', () => {
    const sheet = $('#mobile-nav');
    const open = sheet.classList.toggle('open');
    $('#menu-btn').setAttribute('aria-expanded', String(open));
  });
  $('#nav-settings').addEventListener('click', () => showPage('settings'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    clearSession();
    window.location.reload();
  });

  // currentTarget, no target: todos estos botones llevan un <svg> dentro y un
  // clic sobre el icono devolvería el propio icono, que no tiene .disabled.
  $('#digest-preview').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await showDigestPreview();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('#digest-send').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const outcome = await api('/digest/run', { method: 'POST' });
      toast(
        outcome.sent
          ? `Report sent to ${outcome.recipients.length} recipient(s) · ${outcome.changes} change(s)`
          : `Not sent: ${REASONS[outcome.reason] ?? outcome.reason}`,
        outcome.sent ? 'ok' : 'err',
      );
      await refreshStatus();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
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
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const outcome = await api('/status/run-now', { method: 'POST' });
      if (outcome.mode === 'background') {
        // En producción la revisión corre aparte y tarda minutos: se avisa y
        // se vuelve a preguntar por el estado en lugar de fingir que ya está.
        // A partir de aquí el sondeo se mantiene solo mientras la fila de la
        // ejecución siga en `running`, así que los resultados aparecen sin
        // que nadie tenga que recargar.
        toast(outcome.message, 'ok');
        setTimeout(() => refreshStatus().catch(() => {}), 3000);
      } else {
        toast(
          `Checked ${outcome.websites} website(s) · ${outcome.pagesChanged} page(s) changed · ` +
            `${outcome.reported} for the report` +
            (outcome.failed ? ` · ${outcome.failed} failing` : ''),
          outcome.failed ? '' : 'ok',
        );
      }
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
      refreshStatus();
    }
  });

  $('#test-email-all').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api('/workers/test-email', { method: 'POST' });
      toast(`Test email sent to ${result.recipients.length} recipient(s)`, 'ok');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  $('#verify-mail').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api('/settings/verify-mail', { method: 'POST' });
      toast(`Transporte "${result.transport}" verificado`, 'ok');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
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
      toast('Settings saved', 'ok');
      // La tarjeta del informe muestra el envío en días vacíos, así que tiene
      // que reflejar el cambio en el momento, no en el siguiente refresco.
      await refreshDigest().catch(() => {});
    } catch (error) {
      toast(error.message, 'err');
    }
  });

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
