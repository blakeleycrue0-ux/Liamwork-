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

const dot = (kind) => el('span', { className: `dot ${kind}` });

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
  if (secondary) {
    const button = el('button', { type: 'button', textContent: secondary.label });
    button.addEventListener('click', async () => {
      button.disabled = true;
      error.hidden = true;
      output.hidden = false;
      output.replaceChildren(el('div', { className: 'muted', textContent: 'Comprobando…' }));
      try {
        await secondary.onClick(readValues(), output);
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
    el('span', { className: `dot ${statusDot}${crawler.status === 'running' ? ' pulse' : ''}` }),
    el('span', { style: 'font-size:20px', textContent: statusLabel }),
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

  $('#s-news').textContent = data.posts.new_24h;
  $('#s-news-sub').textContent = `${data.posts.new_7d} en los últimos 7 días`;

  $('#s-errors').textContent = data.checks.errors_24h;
  $('#s-errors-sub').textContent = `${crawler.due_now} web(s) pendientes ahora`;

  $('#recent-posts').replaceChildren(
    ...(data.recent_posts.length
      ? data.recent_posts.map((post) =>
          el('tr', {}, [
            el('td', { textContent: post.website_name }),
            el('td', {}, [
              post.url
                ? el('a', { href: post.url, target: '_blank', rel: 'noopener', textContent: post.title })
                : document.createTextNode(post.title),
            ]),
            el('td', { className: 'muted', textContent: fmtAgo(post.first_seen_at) }),
            el('td', {}, [
              post.notified_at ? dot('ok') : dot('off'),
              post.notified_at ? 'Enviado' : 'No enviado',
            ]),
          ]),
        )
      : [el('tr', {}, [el('td', { colSpan: 4, className: 'empty', textContent: 'Todavía no hay novedades' })])]),
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

function websiteModal(website) {
  openModal({
    title: website ? `Editar ${website.name}` : 'Añadir web',
    fields: websiteFields(website ?? {}),
    submitLabel: website ? 'Guardar cambios' : 'Añadir',
    secondary: { label: 'Probar detección', onClick: previewDetection },
    onSubmit: async (values) => {
      const payload = toWebsitePayload(values);
      if (website) await api(`/websites/${website.id}`, { method: 'PUT', body: payload });
      else await api('/websites', { method: 'POST', body: payload });
      toast(website ? 'Web actualizada' : 'Web añadida', 'ok');
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
      el('tr', {}, [el('td', { colSpan: 7, className: 'empty', textContent: 'No hay webs. Añade la primera.' })]),
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
                (result.notified ? ' · email enviado' : result.baseline ? ' · línea base' : ''),
              'ok',
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

      const deleteBtn = el('button', { className: 'btn-sm btn-danger', textContent: 'Eliminar' });
      deleteBtn.addEventListener('click', async () => {
        if (!confirmDialog(`¿Eliminar "${website.name}" y todo su historial?`)) return;
        await api(`/websites/${website.id}`, { method: 'DELETE' });
        toast('Web eliminada', 'ok');
        await loadWebsites();
        refreshStatus();
      });
      actions.append(checkBtn, ' ', historyBtn, ' ', editBtn, ' ', toggleBtn, ' ', deleteBtn);

      return el('tr', {}, [
        el('td', {}, [
          el('div', { style: 'font-weight:600', textContent: website.name }),
          el('a', { href: website.url, target: '_blank', rel: 'noopener', className: 'mono', textContent: website.url }),
          el('div', { className: 'hint', textContent: `${website.detection_method} · ${website.posts_count} publicaciones` }),
        ]),
        el('td', {}, [dot(statusDot), statusText]),
        el('td', { className: 'muted' }, [
          el('div', { textContent: fmtAgo(website.last_checked_at) }),
          el('div', { className: 'hint', textContent: fmtDateTime(website.last_checked_at) }),
        ]),
        el('td', {}, [
          el('div', { textContent: website.last_new_item_title || '—' }),
          el('div', { className: 'hint', textContent: fmtDateTime(website.last_new_item_at) }),
        ]),
        el('td', {}, [
          el('div', { textContent: String(website.error_count) }),
          website.last_error ? el('div', { className: 'hint', textContent: website.last_error.slice(0, 80) }) : '',
        ]),
        el('td', { textContent: fmtDuration(website.check_interval) }),
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
  const [{ posts }, { logs }] = await Promise.all([
    api('/posts?limit=50'),
    api(`/logs?limit=100${onlyErrors ? '&errors=true' : ''}`),
  ]);

  $('#posts-body').replaceChildren(
    ...(posts.length
      ? posts.map((post) =>
          el('tr', {}, [
            el('td', { textContent: post.website_name }),
            el('td', {}, [
              post.url ? el('a', { href: post.url, target: '_blank', rel: 'noopener', textContent: post.title }) : post.title,
            ]),
            el('td', { className: 'muted', textContent: fmtDateTime(post.published_at) }),
            el('td', { className: 'muted', textContent: fmtDateTime(post.first_seen_at) }),
            el('td', {}, [post.notified_at ? dot('ok') : dot('off'), post.notified_at ? 'Enviado' : 'No enviado']),
          ]),
        )
      : [el('tr', {}, [el('td', { colSpan: 5, className: 'empty', textContent: 'Sin publicaciones' })])]),
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
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.page === page);
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

  if (state.provider === 'none') {
    // No hay sesión que cerrar.
    $('#logout').hidden = true;
  }

  if (state.provider === 'supabase') {
    document.getElementById('tab-users').hidden = false;
    const label = document.getElementById('current-user');
    if (label && state.user?.email) label.textContent = state.user.email;
  }

  document.getElementById('tabs').addEventListener('click', (event) => {
    if (event.target.dataset.page) showPage(event.target.dataset.page);
  });

  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    clearSession();
    window.location.reload();
  });

  $('#add-website').addEventListener('click', () => websiteModal(null));
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
