# Web Monitor

Dashboard de monitorización de webs: comprueba periódicamente una lista de webs,
detecta **nuevas publicaciones** (noticias, posts, convocatorias…) y avisa por
**email** a los trabajadores activos.

Diseñado desde el principio para escalar de 1 a ~28 webs o más: todas las webs,
trabajadores e intervalos se gestionan **desde el dashboard y la base de datos**,
nunca desde el código.

---

## 1. Arquitectura

```
  28 WEBS
     |
     v
  CRAWLER  ---------  lee el listado y las paginas recientes de cada web,
     |                limpia el HTML (fuera menus, cookies, anuncios,
     |                contadores) y lo reduce a texto normalizado en UTF-8
     v
  ALMACEN  ---------  pages + page_versions
     |                guarda una version NUEVA solo si el texto cambio.
     |                Nada cambio -> ni una llamada al modelo.
     v
  CLAUDE   ---------  recibe SOLO las lineas que cambiaron (un diff), junto
     |                con la fecha que la pagina declara sobre si misma.
     |                Clasifica: NEW / UPDATED / UNCHANGED / IGNORED
     |                y prioriza:  HIGH / MEDIUM / LOW
     v
  CAMBIOS  ---------  detected_changes, con la auditoria completa:
     |                que se le mostro, que respondio, con que modelo
     v
  INFORME  ---------  daily_reports + UN email cada manana con lo del
                      dia anterior, agrupado por prioridad
```

Cada pieza vive en su propio modulo y puede sustituirse sin tocar las demas:

| Carpeta | Responsabilidad |
|---|---|
| `src/config` | Variables de entorno y la lista de las 28 webs (`sites.js`) |
| `src/db` | Conexion (SQLite o Supabase), migraciones y **repositorios** |
| `src/crawler` | HTTP, decodificacion de texto y `fetchers/` (rss, html, browser) |
| `src/monitor` | **El sistema nuevo**: crawl, diff, analisis con Claude, informe |
| `src/scheduler` | Bucle periodico y heartbeat |
| `src/notifications` | Transporte de email y destinatarios |
| `src/api` | Express, rutas, validacion |
| `src/web` | Dashboard estatico (HTML + CSS + JS, sin build) |
| `src/cli` | `seed`, `check-once`, `hash-password`, `migrate-postgres` |

**Las tres decisiones que sostienen el sistema**

**1. Encontrar una URL otra vez no es una novedad.** Es el error que tenia el
sistema anterior: identificaba cada publicacion por un hash de su enlace, asi
que una noticia de 2025 que el crawler no habia llegado a ver antes aparecia
como nueva en 2026. Ahora lo que se compara es el TEXTO de cada pagina contra
la ultima version guardada, y a Claude se le entrega ademas la fecha que la
propia pagina declara. Una pagina de 2025 que sigue publicada y no ha cambiado
es `UNCHANGED`, se le descubra cuando se le descubra.

**2. El crawler filtra, Claude juzga.** El crawler no sabe si un cambio importa
-solo sabe que unos bytes son distintos-, y tratar esas dos preguntas como si
fueran la misma es lo que llenaba el correo de banners de cookies. Asi que el
crawler responde la pregunta barata (que se ha movido) y Claude la cara (que
significa). Una web que no cambio no llega al modelo, y de una que si cambio
solo llegan las lineas afectadas.

**3. Un email al dia, con candado.** El envio lo bloquea `daily_reports.sent_at`,
no una variable en memoria: dos ejecuciones del scheduler, un reintento tras
una caida o un despliegue a media manana no pueden producir un segundo correo.

**Coste**

Un dia tranquilo cuesta **cero**: sin paginas cambiadas no hay llamada. Un dia
normal son unas pocas llamadas de unos miles de tokens, porque lo que viaja es
un diff y no un documento. El prompt del sistema va marcado con `cache_control`,
asi que a partir de la segunda llamada de cada pasada se cobra a una decima
parte. El modelo se elige en Configuracion (`analysis_model`): con
`claude-haiku-4-5` el gasto baja aproximadamente a una quinta parte.

---

## 2. Requisitos

- Node.js **20 o superior** (probado en Node 22)
- npm

---

## 3. Instalación y arranque (instrucciones exactas)

```bash
# 1. Instalar dependencias
npm install

# 2. Crear el fichero de entorno
cp .env.example .env

# 3. Generar un secreto de sesión y pegarlo en SESSION_SECRET del .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 4. Generar el hash de la contraseña del dashboard
#    y pegarlo en ADMIN_PASSWORD_HASH del .env
npm run hash-password -- "miPasswordSegura"

# 5. Arrancar (crea la base de datos, aplica migraciones y siembra los datos
#    iniciales la primera vez)
npm start
```

Abre **http://localhost:3000** y entra con `ADMIN_USERNAME` / tu contraseña.

Otros comandos:

```bash
npm run dev        # servidor con recarga automática
npm run crawler    # crawler como proceso independiente (ver abajo)
npm run migrate    # aplicar migraciones sin arrancar el servidor
npm run seed       # crear BD + datos iniciales sin arrancar el servidor
npm run check      # una pasada del crawler y salir (útil para cron)
npm run check -- 1 # comprobar solo la web con id 1, ignorando su intervalo
npm test           # tests unitarios y de integración
```

### Crawler como proceso independiente

```bash
# en el .env del servidor web
RUN_SCHEDULER_IN_WEB=false

# terminal 1
npm start
# terminal 2
npm run crawler
```

Ambos procesos usan la misma base de datos; el dashboard sigue mostrando el
estado del crawler en tiempo real (última ejecución, próxima comprobación, pid).

---

## 4. Primera prueba

La primera vez que arranca, si las tablas están vacías, se insertan **en la base
de datos** (valores tomados del `.env`, no del código):

| | |
|---|---|
| Website | **FFSP** — `https://ffsp.info` — activa — intervalo 60 s — método `auto` |
| Worker | **Test Worker** — `cruecrv9445@gmail.com` — activo |

A partir de ahí todo se edita desde el dashboard. Para cambiar los valores
sembrados **antes** del primer arranque, edita `SEED_*` en el `.env`.

> Los emails de alerta no se envían en la primera comprobación de una web:
> esa pasada crea la **línea base** (guarda lo que ya existe sin avisar). Puedes
> cambiarlo en *Configuración → Notificar también en la primera comprobación*.

---

## 5. Email

Las credenciales SMTP se leen **solo de variables de entorno**:

```env
MAIL_TRANSPORT=smtp            # smtp | console
MAIL_FROM="Web Monitor <monitor@tudominio.com>"
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu-cuenta@gmail.com
SMTP_PASSWORD=contraseña-de-aplicacion
```

- `MAIL_TRANSPORT=console` (por defecto) imprime los emails por consola: permite
  probar todo el flujo sin credenciales.
- Con Gmail hay que usar una **contraseña de aplicación**, no la del correo.
- Botón **Email de prueba** en *Trabajadores* (a un trabajador o a todos los
  activos) y **Verificar SMTP** en *Configuración*.
- Si en una misma comprobación aparecen varias novedades, se envía **un único
  email agrupado por web**.

---

## 6. Cómo se configura cada web

Desde *Webs → Añadir / Editar*:

| Campo | Para qué sirve |
|---|---|
| Nombre, URL | Identificación |
| Intervalo | Segundos entre comprobaciones (por defecto 60) |
| Método de detección | `auto`, `rss`, `html` o `browser` |
| URL del RSS | Si la web tiene feed, se usa siempre antes que el scraping |
| Selector del listado | CSS del contenedor de cada publicación, p. ej. `.news-list article` |
| Selector del título | p. ej. `h2 a` |
| Selector del enlace | p. ej. `a` |
| Selector de la fecha | p. ej. `time` |

- **`auto`** (recomendado al añadir una web nueva): busca RSS declarado en el
  HTML (`<link rel="alternate">`) y en rutas habituales (`/feed`, `/rss.xml`…);
  si no encuentra ninguno, hace scraping HTML con una heurística genérica
  (`article`, `.post`, `.noticia`, `.card`…). Los selectores solo hacen falta
  cuando esa heurística no acierta.
- **`ai`**: la IA lee la página en **cada** comprobación. Útil para webs que
  cambian de estructura a menudo, pero cuesta dinero por comprobación; para el
  caso normal usa el botón, no este método.
- **`browser`**: para webs que cargan el listado con JavaScript. Requiere
  instalar Playwright (dependencia **opcional**, no se instala por defecto):

  ```bash
  npm install playwright && npx playwright install chromium
  ```

  Si no está instalado, el resto del sistema funciona igual; solo fallan las
  webs marcadas como `browser`, con su error registrado en el historial.

---

## 6 bis. Detección asistida por IA

Cuando una web no publica RSS y su listado no encaja con la detección
automática, el formulario ofrece **"Detectar con IA"**: Claude lee esa página
una sola vez y devuelve las publicaciones que ve **y los selectores CSS** que
las describen. Esos selectores se escriben en el formulario, así que a partir de
guardarlos las comprobaciones vuelven a ser scraping normal: sin tokens, sin
latencia y sin coste por minuto.

### La lista de webs vive en el código

Las páginas vigiladas están escritas en `src/config/sites.js`, no en el
dashboard. Al arrancar, `src/bootstrap.js` da de alta las que falten en la base
de datos y desactiva las que se hayan retirado, así que la lista de la
aplicación y la del código no pueden separarse.

Para añadir o quitar una web se edita ese fichero y se despliega: el panel no
tiene botón de "añadir" ni de "eliminar". Desde el dashboard sí se puede
comprobar una web al momento, ver su historial, ajustar cómo se lee (selectores,
intervalo, método) y desactivarla temporalmente.

Si hace falta saltarse el alta automática -en los tests, por ejemplo-, basta con
`SEED_WATCHED_SITES=false`.

### Reparación automática

Además del botón, el crawler se repara solo: cuando una web que antes daba
resultados deja de dar ninguno -casi siempre porque ha cambiado su maquetación-,
la IA la lee **una vez** y guarda selectores nuevos, que las comprobaciones
siguientes reutilizan gratis.

Está limitado a propósito: como mucho un intento cada `ai_recovery_min_hours`
horas por web (6 por defecto, configurable en el dashboard). Leer cada web con
el modelo cada minuto costaría cientos de euros al día; esto son unas pocas
llamadas por web al mes, y solo cuando algo se ha roto de verdad.

Solo hace falta una clave de Anthropic en el entorno:

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Sin ella el botón responde que falta la clave y el resto del sistema funciona
igual. El modelo usado es `claude-opus-5`, con salida estructurada para que la
respuesta sea siempre una lista validada de publicaciones y selectores, nunca
texto libre que haya que adivinar.

## 7. Esquema de base de datos

| Tabla | Contenido |
|---|---|
| `websites` | Las webs vigiladas: url, activa, intervalo, metodo, selectores (JSON), ultima comprobacion/exito/error |
| `workers` | Destinatarios del informe: nombre, email, activo |
| `pages` | Una fila por URL vigilada: estado, cuando se descubrio, cuando se vio por ultima vez, cuando cambio por ultima vez, hash del texto actual, fecha que declara la pagina. `UNIQUE(website_id, url)` |
| `page_versions` | El texto completo cada vez que cambio. **No se borra nunca**: es lo que permite a Claude comparar antes y ahora |
| `detected_changes` | Un veredicto por cambio: tipo, prioridad, resumen, que cambio, valor anterior y nuevo, y la **auditoria** (`analysis_input`, `analysis_output`, `model`, tokens). `UNIQUE(to_version_id, page_id)` impide juzgar dos veces la misma version |
| `daily_reports` | Un informe por dia: ventana exacta, recuentos por prioridad, el JSON completo, cuando se envio y a quien |
| `check_logs` | Historial de comprobaciones por web |
| `settings` | Configuracion editable desde el dashboard |
| `crawler_state` | Heartbeat del crawler |
| `sessions` | Sesiones del dashboard |

En SQLite las migraciones son ficheros en `src/db/migrations/`. En Supabase el
esquema se aplica solo en el primer arranque desde `src/db/schema.postgres.js`
y `src/db/schema.monitor.js`; un test comprueba que las dos versiones declaran
exactamente las mismas tablas.

La tabla `posts` del sistema anterior sigue existiendo con su historico, pero
ya no la escribe ni la lee nadie.

---

## 8. Seguridad

- Login con usuario y contraseña; la contraseña se guarda **hasheada con scrypt**
  (`ADMIN_PASSWORD_HASH`), nunca en claro.
- Sesiones firmadas con `SESSION_SECRET`, cookies `httpOnly` + `sameSite=lax`
  (`SECURE_COOKIES=true` al servir por HTTPS), persistidas en SQLite.
- Token **CSRF** obligatorio en toda petición que modifica datos.
- Límite de intentos de login por IP.
- `.env`, la base de datos y `node_modules/` están en `.gitignore`: **ninguna
  credencial llega al repositorio**.

---

## 9. Tests

```bash
npm test
```

Cubren, con un sitio de pruebas local levantado durante el test:

- parseo de RSS 2.0 y Atom, scraping HTML con y sin selectores, autodescubrimiento
  de feeds, hash de contenido (ignora `utm_*` y barras finales) y fechas `dd/mm/yyyy`;
- ciclo completo: línea base → publicación nueva detectada y notificada →
  **misma publicación no se vuelve a notificar**;
- preferencia de RSS sobre HTML;
- una web caída no impide comprobar las demás y su error queda registrado;
- solo los trabajadores **activos** reciben los emails;
- API protegida (401 sin sesión, 403 sin CSRF), alta/edición/borrado de webs y
  trabajadores, comprobación manual, email de prueba y configuración.

---

## 10. Despliegue

Antes de desplegar, en el `.env` del servidor:

```env
NODE_ENV=production
SESSION_SECRET=<48 bytes aleatorios>          # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<npm run hash-password -- "tuPassword">
SECURE_COOKIES=true                            # si sirves por HTTPS
APP_BASE_URL=https://monitor.tudominio.com
MAIL_TRANSPORT=smtp
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASSWORD=...
```

En producción la aplicación **se niega a arrancar** si falta `SESSION_SECRET` o
la contraseña de administrador, y lo dice con un mensaje claro en vez de una
traza.

### Opción A — Docker Compose (recomendada)

Levanta los dos procesos (dashboard y crawler) compartiendo un volumen con la
base de datos SQLite:

```bash
cp .env.example .env     # y rellena los valores de arriba
docker compose up -d --build
docker compose logs -f crawler
```

- `web`: dashboard en el puerto `PORT` del host (3000 por defecto), con
  `RUN_SCHEDULER_IN_WEB=false` y `HEALTHCHECK` contra `/health`.
- `crawler`: `src/crawler-process.js`, reinicio automático.
- `web-monitor-data`: volumen persistente en `/data`. **La base de datos vive
  aquí**: si lo borras, pierdes webs, trabajadores e historial.

Copia de seguridad:

```bash
docker compose exec web sh -c 'cat /data/web-monitor.sqlite' > backup-$(date +%F).sqlite
```

### Opción B — VPS con systemd

```bash
sudo useradd -r -m -d /opt/web-monitor webmonitor
sudo rsync -a --exclude node_modules --exclude data ./ /opt/web-monitor/
cd /opt/web-monitor && sudo -u webmonitor npm ci --omit=dev
sudo -u webmonitor cp .env.example .env && sudo -u webmonitor nano .env

sudo cp deploy/webmonitor-web.service deploy/webmonitor-crawler.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now webmonitor-web webmonitor-crawler
sudo journalctl -u webmonitor-crawler -f
```

Delante, nginx como proxy inverso con TLS: `deploy/nginx.conf.example`
(+ `sudo certbot --nginx -d monitor.tudominio.com`).

### Opción C — Netlify (serverless)

Netlify no ejecuta procesos permanentes ni tiene disco persistente, así que el
despliegue usa las piezas equivalentes de la plataforma:

| Pieza local | En Netlify |
|---|---|
| Dashboard (`src/web`) | Ficheros estáticos servidos por la CDN |
| API Express (`src/api`) | Una función serverless: `netlify/functions/api.mts` |
| Scheduler + crawler | Función programada dos veces al día: `netlify/functions/crawl-scheduled.mts` |
| SQLite | **Supabase** (Postgres), a través de `DATABASE_URL` |
| Migraciones | El propio arranque aplica el esquema si las tablas no existen |

La base de datos es Supabase y se configura con **una sola variable**:
`DATABASE_URL`, la cadena de conexión que da Supabase en *Project Settings →
Database → Connection string → Transaction pooler*. Netlify DB (Neon) ya no se
usa: ni la extensión, ni `@netlify/database`, ni
`netlify/database/migrations/`.

El esquema se aplica solo. En el primer arranque, si las tablas no están, la
aplicación ejecuta `src/db/schema.postgres.js` entero -todo es idempotente, así
que volver a arrancar no rompe nada- y lo anota en `schema_migrations`. También
puede aplicarse a mano con `DATABASE_URL=... npm run migrate:pg`.

El código de la aplicación es el mismo: la capa de base de datos tiene dos
drivers (`src/db/drivers/`) y las consultas se escriben una sola vez.
En local sigue usándose SQLite; en Netlify se usa Postgres automáticamente
(`DB_DRIVER` lo detecta por `DATABASE_URL` o por el entorno Lambda).

Dos formas de publicar:

**1. Conectando el repositorio (recomendado)** — en
*Project configuration → Build & deploy → Link repository*, elige este
repositorio y la rama. A partir de ahí cada push despliega solo.

**2. Desde tu máquina:**

```bash
npm install -g netlify-cli
netlify login
netlify link --id <SITE_ID>   # o: netlify sites:create
netlify deploy --prod
```

Variables de entorno a configurar en *Project configuration → Environment variables*:

```
SESSION_SECRET        <48 bytes aleatorios>
ADMIN_USERNAME        admin
ADMIN_PASSWORD_HASH   <npm run hash-password -- "tuPassword">
SECURE_COOKIES        true
RUN_SCHEDULER_IN_WEB  false
MAIL_TRANSPORT        smtp
MAIL_FROM             "Web Monitor <monitor@tudominio.com>"
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD
SEED_WEBSITE_NAME / SEED_WEBSITE_URL / SEED_WORKER_NAME / SEED_WORKER_EMAIL
```

Limitaciones de la plataforma que conviene conocer:

- Las funciones programadas tienen un límite de **30 segundos** y solo se
  ejecutan en despliegues publicados (no en *deploy previews*). Por eso cada
  ejecución comprueba como máximo 25 webs, empezando por las que llevan más
  tiempo sin comprobarse; el resto entra en la siguiente.
- El crawler corre **cada 10 minutos**. Como el aviso es un informe diario,
  comprobar más a menudo no adelanta nada y multiplica las invocaciones de la
  plataforma. La plataforma admite hasta 1 minuto si algún día hace falta.
- `detection_method: browser` (Playwright) **no funciona en Netlify**: no hay
  navegador en el entorno de funciones. Para esas webs usa `rss`/`html`, o
  despliega el crawler en un servidor con Docker y deja el dashboard en Netlify
  (ambos apuntando a la misma base de datos).
- El dashboard (`index.html`) se sirve como fichero estático: no contiene datos,
  y todas las llamadas a `/api/*` siguen exigiendo sesión.

### Opción D — PaaS (Railway, Render, Fly.io…)

Funciona con el `Dockerfile` tal cual, con dos avisos importantes:

1. **SQLite necesita disco persistente.** Monta un volumen en `/data` y pon
   `DATABASE_FILE=/data/web-monitor.sqlite`. Sin volumen, el sistema de ficheros
   es efímero y perderás la base de datos en cada despliegue.
2. Despliega **dos servicios desde la misma imagen**: uno con
   `node src/server.js` (y `RUN_SCHEDULER_IN_WEB=false`) y otro con
   `node src/crawler-process.js`. Si tu plataforma no permite montar el mismo
   volumen en dos servicios, usa un único servicio con
   `RUN_SCHEDULER_IN_WEB=true`: web y crawler corren en el mismo proceso.

### Después de desplegar

1. Entra en el dashboard y comprueba que el crawler aparece como **Funcionando**.
2. *Trabajadores → Email de prueba*: confirma que el SMTP real entrega el correo.
3. *Webs → FFSP → Comprobar*: valida que el listado se detecta; si no, ajusta los
   selectores desde el formulario.
4. Vigila *Resumen → Errores recientes* durante el primer día.

---

## 11. Supabase: usuarios reales y base de datos gestionada

Por defecto el dashboard tiene **un solo administrador** (usuario + contraseña
en variables de entorno). Con Supabase puedes tener **varias personas, cada una
con su email y su contraseña**, sin tocar el código.

Conviene no confundir dos conceptos que el dashboard mantiene separados:

| | Quién | Dónde se gestiona |
|---|---|---|
| **Usuarios** | Quien **entra al dashboard** | Sección *Usuarios* (Supabase Auth) |
| **Trabajadores** | Quien **recibe los emails** de aviso | Sección *Trabajadores* (base de datos) |

Una persona puede ser las dos cosas, o solo una.

### Qué aporta

- Alta y baja de personas desde el dashboard, o desde el panel de Supabase.
- Contraseñas gestionadas por Supabase (hash, políticas, recuperación por email,
  MFA si la activas): no hay criptografía casera.
- El navegador recibe un **JWT**, no una cookie de sesión. En serverless esto es
  mejor: no hace falta tabla de sesiones ni protección CSRF, porque la
  credencial viaja en una cabecera y no la envía el navegador sola.
- La misma cuenta de Supabase te da el **Postgres** de la aplicación.

### Configuración

La URL del proyecto y la **clave anon** viajan en el repositorio
(`src/config/public.config.json`) porque están pensadas para ser públicas: son
las mismas que cualquier frontend envía al navegador. La seguridad la dan las
políticas RLS de Supabase y la verificación del token en el servidor. Gracias a
eso **el despliegue no necesita ninguna variable de entorno para funcionar**.

En ese fichero no va nunca la clave `service_role`, ni el secreto JWT, ni la
cadena de conexión: esas son secretas y van en variables de entorno.

Para apuntar a otro proyecto de Supabase, edita ese fichero o define
`SUPABASE_URL` y `SUPABASE_ANON_KEY`, que tienen prioridad.

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. En *Project settings → API* copia la URL y las claves; en
   *Project settings → Database* copia la cadena de conexión.
3. Añade estas variables (en `.env` o en Netlify):

```env
AUTH_PROVIDER=supabase
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...             # pública, la usa el navegador
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...     # SECRETA, habilita la sección Usuarios
DATABASE_URL=postgresql://postgres:PASSWORD@db.xxxxxxxx.supabase.co:5432/postgres
```

4. Aplica el esquema una sola vez:

```bash
npm run migrate:pg
```

5. Crea la primera persona en *Authentication → Users → Add user* (marca
   "Auto confirm user"). A partir de ahí, las siguientes se dan de alta desde la
   sección **Usuarios** del dashboard.

`SUPABASE_SERVICE_ROLE_KEY` es una clave de administrador: va **solo** en el
servidor. El código nunca la envía al navegador; la sección *Usuarios* la usa a
través de la API. Sin ella todo funciona igual, pero esa sección responde 501 y
las altas se hacen desde el panel de Supabase.

### Cómo se verifican los tokens

El servidor comprueba cada JWT en este orden, y no hace falta configurar nada
para que funcione:

1. **`SUPABASE_JWT_SECRET`** si lo defines: verificación local con HS256, sin
   red. Es la opción más rápida y la recomendada en producción. Está en
   *Project settings → API → JWT Settings* (proyectos antiguos).
2. **JWKS** del proyecto, para proyectos con claves asimétricas (ES256/RS256):
   verificación local contra las claves públicas publicadas por Supabase.
3. **Consulta a Supabase** (`GET /auth/v1/user`) cuando el token va firmado con
   HS256 y no tienes el secreto configurado. Los proyectos antiguos no publican
   ese secreto, así que esta es la única vía: basta con la URL y la clave anon.
   Los tokens validados se guardan en memoria un minuto, de forma que el
   refresco del dashboard cada pocos segundos no genere una llamada por
   petición.

### Qué NO cambia

El crawler, la detección de novedades, los emails y el resto del dashboard son
idénticos: Supabase solo sustituye el login y, si quieres, el motor de base de
datos. Sin `AUTH_PROVIDER=supabase` el proyecto sigue arrancando con SQLite y el
administrador único, que es lo cómodo en local.
