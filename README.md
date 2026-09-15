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
┌──────────────┐        ┌──────────────────────────────────────────┐
│  Dashboard   │  HTTP  │  Backend / API  (Express)                │
│  (SPA, JS    │ <────> │  auth · websites · workers · status      │
│   sin build) │        │  posts · logs · settings                 │
└──────────────┘        └───────────────┬──────────────────────────┘
                                        │
                      ┌─────────────────┴──────────────────┐
                      │        SQLite (WAL)                │
                      │  websites · workers · posts ·      │
                      │  check_logs · settings ·           │
                      │  crawler_state · sessions          │
                      └─────────────────┬──────────────────┘
                                        │
   ┌─────────────┐   ┌──────────────────┴────────┐   ┌──────────────────┐
   │  Scheduler  │──>│  Crawler (concurrente)    │──>│  Detector de     │
   │  (tick)     │   │  fetchers modulares:      │   │  novedades       │
   └─────────────┘   │  rss · html · browser     │   │  (content_hash)  │
                     └───────────────────────────┘   └────────┬─────────┘
                                                              │
                                                     ┌────────┴─────────┐
                                                     │ Email (nodemailer│
                                                     │ SMTP / console)  │
                                                     └──────────────────┘
```

Cada pieza vive en su propio módulo y puede sustituirse sin tocar las demás:

| Carpeta | Responsabilidad |
|---|---|
| `src/config` | Carga y validación de variables de entorno (nada sensible en el código) |
| `src/db` | Conexión SQLite, migraciones SQL y **repositorios** (una capa por tabla) |
| `src/crawler` | Orquestación de comprobaciones, normalización y `fetchers/` intercambiables |
| `src/crawler/fetchers` | `rss`, `html`, `browser` (Playwright, opcional) y modo `auto` |
| `src/scheduler` | Bucle periódico, calcula qué webs tocan y publica el heartbeat |
| `src/notifications` | Transporte de email, plantillas y agrupación de alertas |
| `src/api` | Servidor Express, autenticación, sesiones, CSRF, validación y rutas |
| `src/web` | Dashboard estático (HTML + CSS + JS, sin build ni framework) |
| `src/cli` | Utilidades: `seed`, `check-once`, `hash-password` |

**Decisiones clave**

- **Node.js 20+ / Express / SQLite (better-sqlite3)**: cero build, cero servicios
  externos, un único `npm install` para arrancar. La capa de repositorios aísla
  el SQL, así que migrar a PostgreSQL más adelante toca solo `src/db`.
- **El crawler puede correr dentro del servidor web o como proceso aparte**
  (`npm run crawler`). Ambos procesos comparten estado por la base de datos
  (modo WAL) y el dashboard muestra el heartbeat del crawler aunque esté en
  otra máquina.
- **Detección por contenido, no visual**: cada publicación se identifica con un
  `content_hash` (guid del RSS → URL canónica → título). Un cambio de diseño,
  un banner o un contador no generan alertas; solo las publicaciones nuevas.
- **Concurrencia acotada**: las webs pendientes se comprueban en paralelo con un
  límite configurable (`crawler_concurrency`), así 28 webs tardan lo que la más
  lenta, no la suma de todas. Cada comprobación está aislada: **un fallo en una
  web nunca detiene a las demás**.

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
- **`browser`**: para webs que cargan el listado con JavaScript. Requiere
  instalar Playwright (dependencia **opcional**, no se instala por defecto):

  ```bash
  npm install playwright && npx playwright install chromium
  ```

  Si no está instalado, el resto del sistema funciona igual; solo fallan las
  webs marcadas como `browser`, con su error registrado en el historial.

---

## 7. Esquema de base de datos

| Tabla | Contenido |
|---|---|
| `websites` | Webs monitorizadas: url, activa, intervalo, método, selectores (JSON), última comprobación/éxito/error, contadores de error, última novedad |
| `workers` | Destinatarios: nombre, email, activo, fechas |
| `posts` | Publicaciones detectadas: título, url, fecha, `content_hash`, `first_seen_at`, `notified_at`. `UNIQUE(website_id, content_hash)` garantiza que **una alerta nunca se envía dos veces** |
| `check_logs` | Historial de comprobaciones: éxito, items encontrados, nuevos, método, duración, error |
| `settings` | Configuración global editable desde el dashboard |
| `crawler_state` | Heartbeat compartido del crawler (estado, última/próxima ejecución, pid) |
| `sessions` | Sesiones del dashboard |

Las migraciones son ficheros SQL en `src/db/migrations/`, aplicados una sola vez
y registrados en `schema_migrations`. Para añadir un cambio de esquema, crea
`003_lo_que_sea.sql`: se aplicará solo en el siguiente arranque.

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
