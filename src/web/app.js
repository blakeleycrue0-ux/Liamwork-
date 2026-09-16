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
  page: 'summary',
};

/* ---------------------------------------------------------------- helpers */
const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
};

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
    document.querySelector('main.container')?.prepend(banner);
  }
  banner.textContent = message;
  banner.hidden = false;
}

function toast(message, kind = '') {
  const node = el('div', { className: `toast ${kind}`, textContent: message });
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

const DOT_COLOURS = { ok: 'var(--ok)', err: 'var(--bad)', warn: 'var(--warn)', off: '#94a3b8' };
const dot = (kind) =>
  el('span', { className: 'dot', style: `background:${DOT_COLOURS[kind] ?? '#94a3b8'}` });

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
async function refreshStatus() {
  let data;
  try {
    data = await api('/status');
  } catch {
    return;
  }

  const crawler = data.crawler;
  const running = crawler.alive && crawler.status !== 'stopped';
  const statusLabel = !crawler.alive
    ? 'Detenido'
    : crawler.status === 'running'
      ? 'Comprobando'
      : crawler.status === 'paused'
        ? 'En pausa'
        : 'Funcionando';
  const statusDot = !crawler.alive ? 'off' : crawler.status === 'paused' ? 'warn' : 'ok';

  const crawlerCell = $('#s-crawler');
  crawlerCell.replaceChildren(
    el('span', { className: `badge ${statusDot === 'ok' ? 'ok' : statusDot === 'warn' ? 'warn' : 'mute'}` }, [
      el('span', { className: `dot${crawler.status === 'running' ? ' pulse' : ''}` }),
      statusLabel,
    ]),
  );
  $('#s-crawler-sub').textContent = running
    ? `Última ejecución ${fmtTime(crawler.last_run_at)} · Próxima ${fmtTime(crawler.next_run_at)}`
    : 'Arranca el servidor o `npm run crawler`';

  $('#s-websites').textContent = `${data.websites.active}`;
  $('#s-websites-sub').textContent =
    `${data.websites.total} en total · ${data.websites.ok} OK · ${data.websites.failing} con errores`;

  $('#s-workers').textContent = `${data.workers.active}`;
  $('#s-workers-sub').textContent = `${data.workers.total} en total`;

  $('#s-last-check').textContent = fmtTime(data.checks.last_checked_at);
  $('#s-last-check-sub').textContent = fmtAgo(data.checks.last_checked_at);

  $('#s-news').textContent = data.report.pending_changes;
  $('#s-news-sub').textContent = `del ${data.report.covers_date}, para el informe de mañana`;

  $('#s-errors').textContent = data.checks.errors_24h;
  $('#s-errors-sub').textContent = `${data.usage_7d.analyses} análisis en 7 días · ${
    data.usage_7d.input_tokens + data.usage_7d.output_tokens
  } tokens`;

  $('#recent-posts').replaceChildren(
    ...(data.recent_changes.length
      ? data.recent_changes.map((change) => changeRow(change))
      : [el('tr', {}, [el('td', { colSpan: 4, className: 'empty', textContent: 'Todavía no hay cambios' })])]),
  );

  $('#recent-errors').replaceChildren(
    ...(data.recent_errors.length
      ? data.recent_errors.map((log) =>
          el('tr', {}, [
            el('td', { textContent: log.website_name }),
            el('td', { className: 'muted', textContent: fmtAgo(log.checked_at) }),
            el('td', { className: 'mono', textContent: log.error_message || '—' }),
          ]),
        )
      : [el('tr', {}, [el('td', { colSpan: 3, className: 'empty', textContent: 'Sin errores recientes' })])]),
  );

  $('#mail-info').textContent = `Transporte: ${data.mail.transport} · Remitente: ${data.mail.from}`;

  if (data.brand?.credit) {
    $('#footer-credit').textContent = data.brand.credit;
  }

  await refreshDigest().catch(() => {});
}

/** Colour and wording for a verdict, used everywhere a change is listed. */
const PRIORITY = {
  HIGH: { dot: 'err', label: 'Alta' },
  MEDIUM: { dot: 'warn', label: 'Media' },
  LOW: { dot: 'off', label: 'Baja' },
};

function changeRow(change) {
  const priority = PRIORITY[change.priority] ?? PRIORITY.LOW;
  const row = el('tr', {}, [
    el('td', { textContent: change.website_name }),
    el('td', {}, [
      el('div', {}, [
        change.url
          ? el('a', { href: change.url, target: '_blank', rel: 'noopener', textContent: change.title || change.url })
          : document.createTextNode(change.title || '—'),
      ]),
      change.summary ? el('div', { className: 'hint', textContent: change.summary }) : '',
    ]),
    el('td', { className: 'muted', textContent: fmtAgo(change.detected_at) }),
    el('td', {}, [
      dot(priority.dot),
      `${change.change_type === 'NEW' ? 'Nuevo' : 'Actualizado'} · ${priority.label}`,
    ]),
  ]);
  row.style.cursor = 'pointer';
  row.addEventListener('click', () => showChangeAudit(change.id));
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
    el('div', { className: 'hint', textContent: `${change.website_name} · ${change.change_date} · ${change.change_type} · ${change.priority}` }),
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
/** The hero: when the next report goes out and what is waiting for it. */
async function refreshDigest() {
  const { digest } = await api('/digest');
  state.digest = digest;

  const pending = digest.pending_changes;
  $('#digest-headline').textContent = pending
    ? `${pending} cambio(s) del ${digest.covers_date} esperando el informe`
    : `Sin cambios pendientes del ${digest.covers_date}`;
  $('#digest-meta').textContent = digest.last_sent_date
    ? `Último informe enviado: ${digest.last_sent_date} · el próximo sale a las ${String(digest.hour).padStart(2, '0')}:00 (${digest.timezone})`
    : `El primer informe saldrá a las ${String(digest.hour).padStart(2, '0')}:00 (${digest.timezone})`;
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
    el('h2', { textContent: `Informe del ${date}` }),
    el('div', {
      className: 'hint',
      textContent: `${report.total_changes} cambio(s) · ${report.high_priority} alta, ${report.medium_priority} media, ${report.low_priority} baja`,
    }),
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
  const body = $('#websites-body');

  if (!websites.length) {
    body.replaceChildren(
      el('tr', {}, [el('td', { colSpan: 5, className: 'empty', textContent: 'La lista de webs está vacía.' })]),
    );
    return;
  }

  body.replaceChildren(
    ...websites.map((website) => {
      const statusDot = !website.active ? 'off' : website.consecutive_errors ? 'err' : 'ok';
      const statusText = !website.active ? 'Inactiva' : website.consecutive_errors ? 'Con errores' : 'Activa';

      const actions = el('td', { className: 'actions' });
      const checkBtn = el('button', { className: 'btn-sm', textContent: 'Comprobar' });
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = '…';
        try {
          const { result } = await api(`/websites/${website.id}/check`, { method: 'POST' });
          if (result.ok) {
            toast(
              `${website.name}: ${result.itemsFound} item(s), ${result.newItems} nuevo(s)` +
                (result.notified ? ' · email enviado' : result.baseline ? ' · línea base' : '') +
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
          checkBtn.textContent = 'Comprobar';
          await loadWebsites();
          refreshStatus();
        }
      });

      const toggleBtn = el('button', { className: 'btn-sm', textContent: website.active ? 'Desactivar' : 'Activar' });
      toggleBtn.addEventListener('click', async () => {
        await api(`/websites/${website.id}/toggle`, { method: 'POST', body: { active: !website.active } });
        await loadWebsites();
        refreshStatus();
      });

      const editBtn = el('button', { className: 'btn-sm', textContent: 'Editar' });
      editBtn.addEventListener('click', () => websiteModal(website));

      const historyBtn = el('button', { className: 'btn-sm', textContent: 'Historial' });
      historyBtn.addEventListener('click', () => showHistory(website));

      actions.append(el('div', { className: 'row-actions' }, [checkBtn, historyBtn, editBtn, toggleBtn]));

      return el('tr', {}, [
        el('td', {}, [
          el('div', { className: 'strong', textContent: website.name }),
          el('a', {
            href: website.url,
            target: '_blank',
            rel: 'noopener',
            className: 'mono cell-url',
            title: website.url,
            textContent: website.url,
          }),
          el('div', {
            className: 'hint',
            textContent: `${website.detection_method} · ${website.posts_count} publicaciones · cada ${fmtDuration(website.check_interval)}`,
          }),
        ]),
        el('td', {}, [
          el('span', { className: `badge ${statusDot === 'ok' ? 'ok' : statusDot === 'err' ? 'bad' : 'mute'}` }, [
            dot(statusDot),
            ` ${statusText}`,
          ]),
          website.error_count
            ? el('div', { className: 'hint', textContent: `${website.error_count} error(es) · ${(website.last_error || '').slice(0, 60)}` })
            : '',
        ]),
        el('td', { className: 'muted' }, [
          el('div', { textContent: fmtAgo(website.last_checked_at) }),
          el('div', { className: 'hint', textContent: fmtDateTime(website.last_checked_at) }),
        ]),
        el('td', {}, [
          el('div', { textContent: website.last_new_item_title || '—' }),
          el('div', { className: 'hint', textContent: fmtDateTime(website.last_new_item_at) }),
        ]),
        actions,
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
  const { workers } = await api('/workers');
  state.workers = workers;
  const body = $('#workers-body');

  if (!workers.length) {
    body.replaceChildren(
      el('tr', {}, [el('td', { colSpan: 5, className: 'empty', textContent: 'No hay trabajadores configurados.' })]),
    );
    return;
  }

  body.replaceChildren(
    ...workers.map((worker) => {
      const actions = el('td', { className: 'actions' });

      const testBtn = el('button', { className: 'btn-sm', textContent: 'Email de prueba' });
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

      const toggleBtn = el('button', { className: 'btn-sm', textContent: worker.active ? 'Desactivar' : 'Activar' });
      toggleBtn.addEventListener('click', async () => {
        await api(`/workers/${worker.id}/toggle`, { method: 'POST', body: { active: !worker.active } });
        await loadWorkers();
        refreshStatus();
      });

      const editBtn = el('button', { className: 'btn-sm', textContent: 'Editar' });
      editBtn.addEventListener('click', () => workerModal(worker));

      const deleteBtn = el('button', { className: 'btn-sm btn-danger', textContent: 'Eliminar' });
      deleteBtn.addEventListener('click', async () => {
        if (!confirmDialog(`¿Eliminar a ${worker.name}?`)) return;
        await api(`/workers/${worker.id}`, { method: 'DELETE' });
        toast('Trabajador eliminado', 'ok');
        await loadWorkers();
        refreshStatus();
      });
      actions.append(testBtn, ' ', editBtn, ' ', toggleBtn, ' ', deleteBtn);

      return el('tr', {}, [
        el('td', { style: 'font-weight:600', textContent: worker.name }),
        el('td', { className: 'mono', textContent: worker.email }),
        el('td', {}, [dot(worker.active ? 'ok' : 'off'), worker.active ? 'Activo' : 'Inactivo']),
        el('td', { className: 'muted', textContent: fmtDateTime(worker.created_at) }),
        actions,
      ]);
    }),
  );
}

/* ----------------------------------------------------------- activity tab */
async function loadActivity() {
  const onlyErrors = $('#activity-filter').value === 'errors';
  const [{ changes }, { logs }] = await Promise.all([
    api('/posts?limit=50'),
    api(`/logs?limit=100${onlyErrors ? '&errors=true' : ''}`),
  ]);

  // Everything is listed here, including what the model judged irrelevant:
  // the point of this view is to be able to check its work.
  $('#posts-body').replaceChildren(
    ...(changes.length
      ? changes.map((change) => {
          const priority = PRIORITY[change.priority] ?? PRIORITY.LOW;
          const row = el('tr', {}, [
            el('td', { textContent: change.website_name }),
            el('td', {}, [
              el('div', {}, [
                change.url
                  ? el('a', { href: change.url, target: '_blank', rel: 'noopener', textContent: change.title || change.url })
                  : document.createTextNode(change.title || '—'),
              ]),
              change.summary ? el('div', { className: 'hint', textContent: change.summary }) : '',
            ]),
            el('td', { className: 'muted', textContent: change.change_date }),
            el('td', { className: 'muted', textContent: fmtDateTime(change.detected_at) }),
            el('td', {}, [dot(priority.dot), `${change.change_type} · ${priority.label}`]),
          ]);
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => showChangeAudit(change.id));
          return row;
        })
      : [el('tr', {}, [el('td', { colSpan: 5, className: 'empty', textContent: 'Sin cambios registrados' })])]),
  );

  $('#logs-body').replaceChildren(
    ...(logs.length
      ? logs.map((log) =>
          el('tr', {}, [
            el('td', { textContent: log.website_name }),
            el('td', { className: 'muted', textContent: fmtDateTime(log.checked_at) }),
            el('td', {}, [dot(log.success ? 'ok' : 'err'), log.success ? 'OK' : (log.error_message || 'Error')]),
            el('td', { textContent: log.method || '—' }),
            el('td', { textContent: String(log.items_found) }),
            el('td', { textContent: String(log.new_items) }),
            el('td', { className: 'muted', textContent: log.duration_ms ?? '—' }),
          ]),
        )
      : [el('tr', {}, [el('td', { colSpan: 7, className: 'empty', textContent: 'Sin comprobaciones' })])]),
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
function showPage(page) {
  state.page = page;
  const titles = {
    summary: 'Resumen',
    websites: 'Webs',
    workers: 'Trabajadores',
    activity: 'Actividad',
    users: 'Usuarios',
    settings: 'Configuración',
  };
  document.title = titles[page] ? `${titles[page]} · Web Monitor` : 'Web Monitor';
  for (const tab of document.querySelectorAll('.nav-item')) {
    tab.classList.toggle('active', tab.dataset.page === page);
  }
  for (const section of document.querySelectorAll('.page')) {
    section.classList.toggle('active', section.id === `page-${page}`);
  }
  if (page === 'websites') loadWebsites().catch((error) => toast(error.message, 'err'));
  if (page === 'workers') loadWorkers().catch((error) => toast(error.message, 'err'));
  if (page === 'activity') loadActivity().catch((error) => toast(error.message, 'err'));
  if (page === 'settings') loadSettings().catch((error) => toast(error.message, 'err'));
  if (page === 'users') loadUsers().catch((error) => toast(error.message, 'err'));
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
          ? `Informe enviado a ${outcome.recipients.length} destinatario(s) · ${outcome.posts} novedad(es)`
          : `No se envió: ${outcome.reason}`,
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
  $('#activity-filter').addEventListener('change', () => loadActivity());

  $('#run-now').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const outcome = await api('/status/run-now', { method: 'POST' });
      toast(`Comprobadas ${outcome.checked} web(s) · ${outcome.newItems ?? 0} novedad(es)`, 'ok');
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
    };
    try {
      const { settings } = await api('/settings', { method: 'PUT', body: payload });
      state.settings = settings;
      toast('Configuración guardada', 'ok');
    } catch (error) {
      toast(error.message, 'err');
    }
  });

  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('es-ES'); }, 1000);
  $('#clock').textContent = new Date().toLocaleTimeString('es-ES');

  await refreshStatus();
  await loadSettings();
  setInterval(() => {
    refreshStatus();
    if (state.page === 'websites') loadWebsites().catch(() => {});
    if (state.page === 'activity') loadActivity().catch(() => {});
  }, 5000);
}

init().catch((error) => toast(error.message, 'err'));
