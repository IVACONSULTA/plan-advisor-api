# PA Plan Advisor — Guía de Arquitectura y Desarrollo

> **Proyecto:** Calculadora inteligente de planes por país y proveedor PA (e-invoicing / e-reporting)  
> **Fecha:** Abril 2026  
> **Referencia:** `b2brouter-calculator/docs/Proyecto Agente Calculadora Pa Einvoicing Ereporting.pdf`

---

## Índice

1. [Visión general del sistema](#1-visión-general-del-sistema)
2. [Mapa de aplicaciones y plataformas](#2-mapa-de-aplicaciones-y-plataformas)
3. [Aplicación 1 — Frontend Astro (Netlify)](#3-aplicación-1--frontend-astro-netlify)
4. [Aplicación 2 — Backend API Express (Railway)](#4-aplicación-2--backend-api-express-railway)
5. [Aplicación 3 — Agente documental CrewAI (Railway)](#5-aplicación-3--agente-documental-crewai-railway)
6. [Aplicación 4 — Agente de resumen DSPy (Railway)](#6-aplicación-4--agente-de-resumen-dspy-railway)
7. [Railway — Base de datos y almacenamiento de documentos](#7-railway--base-de-datos-y-almacenamiento-de-documentos)
8. [Supabase — Auth y gestión de usuarios](#8-supabase--auth-y-gestión-de-usuarios)
9. [Flujos entre aplicaciones](#9-flujos-entre-aplicaciones)
10. [Variables de entorno por aplicación](#10-variables-de-entorno-por-aplicación)
11. [Roadmap de desarrollo (orden sugerido)](#11-roadmap-de-desarrollo-orden-sugerido)
12. [Criterios de aceptación del MVP](#12-criterios-de-aceptación-del-mvp)

---

## 1. Visión general del sistema

**PA Plan Advisor** es una aplicación web protegida por login que permite:

- Al **Admin**: subir documentos de proveedores PA y normativa por país, usar IA para proponer reglas de cálculo, revisar/aprobar esas reglas y activar una calculadora determinista por país.
- Al **Internal user**: ejecutar cálculos y generar resúmenes en inglés sobre países ya activos.
- Al **Client user**: calcular el plan recomendado solo sobre países configurados y activos.

La IA se usa exclusivamente para:
1. **Interpretación documental** → proponer reglas (nunca activarlas automáticamente).
2. **Redacción de resúmenes** → explicar el resultado del cálculo en inglés.

El cálculo final es siempre **determinista** basado en reglas aprobadas por el Admin.

---

## 2. Mapa de aplicaciones y plataformas

```
┌─────────────────────────────────────────────────────────────┐
│                        USUARIO FINAL                        │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS
┌──────────────────────────────▼──────────────────────────────┐
│          APP 1: Frontend Astro SSR                          │
│          Basado en b2brouter-calculator                     │
│          Auth via Supabase (patrón AstroChatBot)            │
│          Hospedado en: Netlify                              │
└────────┬──────────────────────────────┬─────────────────────┘
         │ REST API calls               │ Auth JWT (solo login)
┌────────▼──────────────┐   ┌───────────▼───────────────────┐
│  APP 2: Backend API   │   │  SUPABASE                     │
│  Express.js           │   │  · auth.users (credenciales)  │
│  Railway              │──►│  (solo login/JWT — sin DB     │
│                       │   │   de negocio ni Storage)      │
└────────┬──────────────┘   └───────────────────────────────┘
         │ Railway internal network
┌────────▼──────────────────────────────────────────────────┐
│                  RAILWAY PROJECT                           │
│  ┌──────────────────┐  ┌──────────────────────────────┐   │
│  │  PostgreSQL       │  │  Volume /data/documents      │   │
│  │  (13 tablas)     │  │  (PDF/DOCX/XLSX binarios)    │   │
│  │                  │  │  montado en App 2            │   │
│  └──────────────────┘  └──────────────────────────────┘   │
│                                                            │
│  ┌───────────────────────┐  ┌──────────────────────────┐  │
│  │  APP 3: Agente DocIA  │  │  APP 4: Agente Resumen   │  │
│  │  Python + CrewAI      │  │  Python + DSPy           │  │
│  │  Guardrails:          │  │  Genera texto comercial  │  │
│  │  · EU AI Act          │  │  en inglés post-cálculo  │  │
│  │  · Copyright EU       │  │                          │  │
│  └───────────────────────┘  └──────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

| Aplicación | Stack | Plataforma | Función principal |
|---|---|---|---|
| Frontend | Astro 6 SSR + Supabase Auth | Netlify | UI Admin + Customer + Login |
| Backend API | Express.js | Railway | Toda la lógica de negocio, cálculo, acceso a DB |
| Agente DocIA | Python + CrewAI + OpenAI | Railway | Analizar documentos → JSON estructurado |
| Agente Resumen | Python + DSPy + OpenAI | Railway | Generar resumen en inglés del cálculo |
| Base de datos | PostgreSQL | Railway | 13 tablas (7.1–7.13) |
| Documentos | Railway Volume | Railway | Almacenamiento de archivos (PDF/DOCX/etc.) |
| Auth | Supabase | Supabase Cloud | Login, JWT — solo `auth.users` (credenciales) |
| `users_profile` | PostgreSQL | Railway | Rol, empresa, estado activo — espejo de `auth.users.id` |

---

## 3. Aplicación 1 — Frontend Astro (Netlify)

### Base de código

Adaptar **`b2brouter-calculator`** que ya incluye:
- Astro 6 SSR con `output: 'server'` y `@astrojs/node`
- Dos portales: Admin y Customer, protegidos por cookie de sesión
- Supabase client configurado (`src/lib/supabase.ts`)
- Login con Supabase Auth (patrón tomado de **`AstroChatBot`**)

### Estructura de páginas a construir

```
src/pages/
├── index.astro                      # Landing: ir a login
├── login.astro                      # Login unificado (email/password via Supabase Auth)
├── dashboard.astro                  # Dashboard según rol (Admin / Internal / Client)
│
├── countries/
│   └── index.astro                  # Listado países (vista por rol)
│
├── calculator/
│   └── [profile_id].astro           # Calculadora dinámica
│
├── scenarios/
│   ├── index.astro                  # Mis escenarios
│   └── [id].astro                   # Resultado detallado + resumen IA
│
├── admin/                           # Solo rol Admin
│   ├── dashboard.astro
│   ├── countries/
│   │   ├── new.astro                # Crear país/proveedor
│   │   └── [id]/
│   │       ├── setup.astro          # Configurar perfil
│   │       └── documents.astro     # Subir documentos
│   ├── analyses/
│   │   └── [id].astro               # Revisar análisis IA (aprobar/editar/rechazar reglas)
│   ├── profiles/
│   │   └── [id].astro               # Activar perfil de cálculo
│   └── settings.astro               # Usuarios, límites IA (opcional MVP)
│
└── api/auth/
    ├── login.ts                     # Supabase signInWithPassword → cookie sesión
    └── logout.ts                    # Limpiar cookie
```

### Roles y protección de rutas

El sistema maneja tres roles vía `users_profile.role`. El rol **nunca** viaja en el JWT de Supabase — se consulta en Railway PostgreSQL en cada request protegido.

#### Descripción de roles

| Rol | Tipo de usuario | Descripción |
|---|---|---|
| `admin` | Interno | Control total del sistema. Único que puede crear países, subir y analizar documentos, aprobar reglas y activar perfiles |
| `internal` | Interno | Puede ejecutar cálculos y generar resúmenes en inglés, pero no puede modificar ni configurar información de países |
| `client` | Cliente externo | Solo puede calcular sobre países/proveedores con estado `active`. Puede ver sus propios escenarios. Puede tener habilitado o deshabilitado el botón de resumen IA según configuración |

#### Matriz de permisos completa (PDF §4.2)

| Funcionalidad | `admin` | `internal` | `client` |
|---|---|---|---|
| Login | ✅ | ✅ | ✅ |
| Ver países activos | ✅ | ✅ | ✅ |
| Ver países en borrador / pending | ✅ | Opcional | ❌ |
| Crear país/proveedor | ✅ | ❌ | ❌ |
| Subir documentos | ✅ | ❌ | ❌ |
| Analizar documentos con IA | ✅ | ❌ | ❌ |
| Revisar reglas propuestas | ✅ | ❌ | ❌ |
| Editar reglas | ✅ | ❌ | ❌ |
| Aprobar reglas | ✅ | ❌ | ❌ |
| Activar versión país/PA | ✅ | ❌ | ❌ |
| Editar planes | ✅ | ❌ | ❌ |
| Ejecutar calculadora | ✅ | ✅ | ✅ solo países activos |
| Generar resumen IA | ✅ | ✅ | Configurable (on/off) |
| Ver todos los escenarios | ✅ | ✅ solo internos | ❌ |
| Ver sus propios escenarios | ✅ | ✅ | ✅ |
| Ver logs de IA | ✅ | ❌ | ❌ |

#### Restricción crítica (PDF §4.3)

> El Admin es el **único** usuario que puede modificar o dar de alta información de un país. El cliente solo puede: ver países activos, introducir volúmenes, obtener el plan recomendado, y ver el resumen si está permitido.

#### Protección de rutas en middleware

El middleware Astro en `src/middleware.ts` lee la cookie de sesión (JWT Supabase), valida la identidad con `supabase.auth.getUser()` y luego consulta el rol en Railway PostgreSQL. Reglas de redirección:

| Ruta solicitada | Rol requerido | Si no tiene rol → |
|---|---|---|
| `/admin/*` | `admin` | Redirect `/dashboard` |
| `/dashboard`, `/calculator/*`, `/scenarios/*` | `admin`, `internal`, `client` | Redirect `/login` |
| `/countries` | `admin` ve todos; `internal`/`client` ven solo activos | — |
| Cualquier ruta sin sesión | — | Redirect `/login` |

#### Pantallas por rol

**`/login`** (todos)
- Email + Password + Botón Login
- Recuperación de contraseña (si habilitado en Supabase)

**`/dashboard`** (todos, contenido diferente por rol)

| Elemento | `admin` | `internal` | `client` |
|---|---|---|---|
| Países configurados (todos estados) | ✅ | ❌ | ❌ |
| Países en borrador | ✅ | ❌ | ❌ |
| Últimos documentos subidos | ✅ | ❌ | ❌ |
| Accesos directos Admin | ✅ | ❌ | ❌ |
| Países activos disponibles | ✅ | ✅ | ✅ |
| Nuevo cálculo (CTA) | ✅ | ✅ | ✅ |
| Escenarios recientes | ✅ | ✅ internos | ✅ propios |

**`/countries`** (todos, contenido diferente)

| Vista | Columnas |
|---|---|
| Admin | Country · Provider · Version · Status · Active from · Actions (View/Edit/Continue setup) |
| Client / Internal | Country · Provider · Action (Calculate) — solo activos |

**`/admin/countries/new`** y **`/admin/countries/:id/setup`** (solo `admin`)
- Campos: Country, Provider/PA, Currency, Notes
- Acciones: Crear, Subir documentos, Analizar documentos

**`/admin/countries/:id/documents`** (solo `admin`)
- Upload file (PDF/DOCX/XLSX/CSV/TXT/MD)
- Document type (6 tipos del PDF §5.3)
- Description libre
- Lista de documentos subidos con estado copyright
- Botón "Analyze selected documents with AI"

**`/admin/analyses/:id`** (solo `admin`)
- Summary of detected logic
- Extracted transaction rules (con confidence badge + source excerpt)
- Extracted plans (con confidence badge)
- Extracted assumptions
- Ambiguities · Conflicts
- Controls por regla: Approve / Edit / Reject / Mark as pending

**`/admin/profiles/:id`** (solo `admin`)
- Ver reglas aprobadas / planes aprobados / supuestos aprobados
- Validaciones previas antes de activar: ≥1 regla aprobada, ≥1 plan aprobado, sin conflictos críticos
- Botón "Activate version" (con modal de confirmación)
- Acción "Archive previous version"

**`/calculator/[profile_id]`** (todos si perfil `active`)
- Campo Nombre del cliente
- Inputs dinámicos generados desde `transaction_rules` activas del perfil
- Botón **Calculate** → resultado inmediato (sin IA)
- Botón **Generate English summary** → llamada a App 4 (opcional para `client`)

**`/scenarios/:id`** (dueño del escenario o `admin`)
- Inputs · Transaction breakdown · Plan comparison · Recommended plan
- AI summary en inglés (si generado)
- Copy summary · Download/Export (opcional MVP)

**`/admin/settings`** (solo `admin`, opcional MVP)
- Gestión de usuarios (crear, desactivar, asignar empresa)
- Límites IA por rol
- Modelos IA
- Configuración de permisos (ej. habilitar resumen para `client`)

### Hosting en Netlify

Patrón idéntico a **`AstroChatBot`**:

```toml
# netlify.toml
[build]
  publish = "dist"
  command = "npm run build"

[build.environment]
  NODE_VERSION = "22"
```

El adaptador `@astrojs/netlify` convierte las rutas SSR en Netlify Functions automáticamente.

**Variables de entorno en Netlify UI:**
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `API_BASE_URL` (URL pública del Backend API en Railway, ej: `https://pa-plan-api.up.railway.app/api`)

> `DOC_AGENT_URL` y `SUMMARY_AGENT_URL` **no se exponen al Frontend**. El Frontend solo llama a App 2 (Backend). App 2 llama a App 3 y App 4 por red interna Railway.

### Funcionalidades asignadas al Frontend

| Módulo | Descripción |
|---|---|
| Auth (5.1) | Login/logout via Supabase Auth, sesión por cookie httpOnly |
| Dashboard (6.2) | Vista diferente por rol |
| Countries (6.3) | Admin ve todos los estados; Client solo ve activos |
| Country setup (6.4) | Formulario crear país/proveedor (solo Admin) |
| Document upload (6.5) | Upload de PDF/DOCX/XLSX/CSV/TXT (solo Admin) |
| Analysis review (6.6) | Revisar reglas, planes, supuestos, ambigüedades (solo Admin) |
| Profile activation (6.7) | Activar perfil con validaciones previas (solo Admin) |
| Calculator (6.8) | Inputs dinámicos + botón Calculate + botón Generate summary |
| Scenario result (6.9) | Resultado completo + resumen IA + copy/download |

---

## 4. Aplicación 2 — Backend API Express (Railway)

### Base de código

Basado en **`ExpressApi`** (estructura `server.js` + rutas modulares), desplegado directamente en Railway como servicio HTTP persistente. Al estar en Railway tiene acceso a la red interna del proyecto para comunicarse con PostgreSQL, el Volume y los agentes sin latencia de red pública.

### Estructura del proyecto

```
pa-plan-api/
├── server.js                    # Entry point Express
├── routes/
│   ├── auth.js                  # Middleware: requireAuth, requireAdmin, requireRole
│   ├── users.js                 # POST /admin/users, PATCH /admin/users/:id (gestión usuarios)
│   ├── countries.js             # GET /countries, POST /admin/countries
│   ├── providers.js             # GET /providers, POST /admin/providers
│   ├── profiles.js              # CRUD perfiles + activate
│   ├── documents.js             # Upload a Volume + analyze (llama al Agente DocIA)
│   ├── rules.js                 # PATCH/approve/reject reglas
│   ├── plans.js                 # PATCH/approve/reject planes
│   ├── calculator.js            # POST /calculator/calculate (lógica determinista)
│   ├── scenarios.js             # GET/POST escenarios
│   └── ai-summary.js            # POST /scenarios/:id/generate-summary (llama Agente Resumen)
├── lib/
│   ├── db.js                    # Cliente PostgreSQL (pg) con DATABASE_URL Railway
│   ├── supabase.js              # Supabase client solo para validar JWT (SUPABASE_ANON_KEY)
│   ├── storage.js               # Helpers para leer/escribir en Railway Volume (/data/documents)
│   └── quota.js                 # checkAIQuota: verifica límite de uso IA por rol en ai_usage_logs
├── railway.json
└── package.json
```

### Acceso a datos: Railway PostgreSQL (no Supabase DB)

```js
// lib/db.js — Pool PostgreSQL directo a Railway
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,  // Railway inyecta esta var automáticamente
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

module.exports = { query: (text, params) => pool.query(text, params) };
```

### Almacenamiento de documentos: Railway Volume

El Volume se monta en la ruta `/data/documents` del contenedor de App 2. Los documentos se guardan y leen como archivos del sistema operativo:

```js
// lib/storage.js
const fs   = require('fs');
const path = require('path');

const DOCS_PATH = process.env.DOCUMENTS_PATH || '/data/documents';

function saveDocument(profileId, filename, buffer) {
  const dir = path.join(DOCS_PATH, profileId);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function readDocument(filepath) {
  return fs.readFileSync(filepath);
}

module.exports = { saveDocument, readDocument, DOCS_PATH };
```

### Control de cuota IA: `lib/quota.js`

Verifica el límite mensual de uso IA por rol antes de invocar App 3 o App 4. Se usa como middleware en los endpoints `POST /admin/documents/analyze` y `POST /scenarios/:id/generate-summary`.

```js
// lib/quota.js
const db = require('./db');

const MONTHLY_LIMITS = {
  admin:    Infinity,   // sin límite (o configurable)
  internal: 50,
  client:   10          // configurable por empresa
};

async function checkAIQuota(req, res, next) {
  const role = req.userRole;  // asignado por requireAuth
  const limit = MONTHLY_LIMITS[role] ?? 0;
  if (limit === Infinity) return next();

  const { rows } = await db.query(
    `SELECT COUNT(*) AS calls
     FROM ai_usage_logs
     WHERE user_id = $1
       AND created_at >= date_trunc('month', NOW())`,
    [req.user.id]
  );

  if (parseInt(rows[0].calls) >= limit) {
    return res.status(429).json({
      error: 'ai_quota_exceeded',
      message: `Monthly AI usage limit reached (${limit} calls for role '${role}')`,
      limit,
      used: parseInt(rows[0].calls)
    });
  }
  next();
}

module.exports = { checkAIQuota };
```

### Autenticación: JWT Supabase (solo para validar identidad)

```js
// lib/supabase.js — Solo Auth, no DB
const { createClient } = require('@supabase/supabase-js');
const db = require('./db');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY   // Anon key es suficiente para validar JWT
);

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  // El rol se consulta en Railway PostgreSQL, no en Supabase
  const { rows } = await db.query(
    'SELECT role FROM users_profile WHERE id = $1',
    [req.user.id]
  );
  if (rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

module.exports = { supabase, requireAuth, requireAdmin };
```

### Lógica de cálculo determinista (módulo más importante)

El endpoint `POST /calculator/calculate` es completamente determinista:

1. Carga `transaction_rules` activas del perfil solicitado desde Railway PostgreSQL.
2. Calcula total PA transactions: `SUM(volume[key] × pa_transactions_per_item[key])`.
3. Para cada plan activo calcula: `annual_fee + max(0, total_pa - included) × extra_cost`.
4. Recomienda el plan con menor `total_annual_cost`.
5. Guarda el resultado como escenario en Railway PostgreSQL.
6. **No llama a ninguna IA.**

### Endpoints principales

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/countries` | Todos | Admin: todos; Client/Internal: solo activos |
| POST | `/admin/countries` | Admin | Crear país |
| GET | `/providers` | Todos | Lista proveedores |
| POST | `/admin/providers` | Admin | Crear proveedor |
| POST | `/admin/profiles` | Admin | Crear perfil en draft |
| GET | `/admin/profiles/:id` | Admin | Ver perfil completo |
| POST | `/admin/profiles/:id/activate` | Admin | Activar perfil |
| POST | `/admin/documents/upload` | Admin | Guardar en Railway Volume + metadata en DB |
| POST | `/admin/documents/analyze` | Admin | Llamar Agente DocIA → guardar análisis |
| PATCH | `/admin/rules/:id` | Admin | Editar regla |
| POST | `/admin/rules/:id/approve` | Admin | Aprobar regla |
| POST | `/admin/rules/:id/reject` | Admin | Rechazar regla |
| PATCH | `/admin/plans/:id` | Admin | Editar plan |
| POST | `/admin/plans/:id/approve` | Admin | Aprobar plan |
| GET | `/calculator/available-countries` | Todos | Países/proveedores activos |
| GET | `/calculator/profile/:id` | Todos | Inputs dinámicos |
| POST | `/calculator/calculate` | Todos | Cálculo determinista + guardar escenario |
| POST | `/scenarios/:id/generate-summary` | Admin/Internal/Client* | Llamar Agente Resumen |
| POST | `/admin/users` | Admin | Crear users_profile en Railway PostgreSQL tras crear usuario en Supabase Auth |
| PATCH | `/admin/users/:id` | Admin | Actualizar rol, empresa o estado activo de un usuario |
| GET | `/admin/users` | Admin | Listar todos los usuarios con su rol y empresa |

*Client solo si está habilitado en configuración.

### Hosting en Railway

```json
// railway.json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node server.js",
    "healthcheckPath": "/health"
  }
}
```

El Volume `/data/documents` se configura en el dashboard de Railway → Service → Volumes, montado en la ruta `/data/documents`. Railway inyecta `DATABASE_URL` automáticamente al añadir el servicio PostgreSQL al proyecto.

---

## 5. Aplicación 3 — Agente Documental CrewAI (Railway)

### Propósito

Recibe documentos (texto extraído de PDF/DOCX/etc.) más metadatos del país/proveedor y devuelve un JSON estructurado con reglas de cálculo, planes, supuestos, ambigüedades y conflictos.

**Principio clave:** el agente propone, nunca activa. El Admin siempre aprueba.

**Guardrails obligatorios:** antes de procesar cualquier documento, el agente ejecuta dos capas de guardrails: cumplimiento EU AI Act y verificación de copyright. Si alguna capa falla, el agente devuelve un error estructurado sin invocar al LLM.

### Base de referencia

Patrón tomado de: https://docs.crewai.com/en/guides/crews/first-crew  
Guardrails basados en el patrón de seguridad de **`OrchestratorIva`** (OWASP Top 10 + prompt injection).

### Estructura del proyecto

```
pa-doc-agent/
├── main.py                      # FastAPI app
├── crew/
│   ├── __init__.py
│   ├── agents.py                # Definición de agentes CrewAI
│   ├── tasks.py                 # Tareas de análisis
│   └── crew.py                  # Ensamblado del crew
├── guardrails/
│   ├── __init__.py
│   ├── eu_ai_act.py             # Guardrail EU AI Act (transparencia, supervisión humana)
│   ├── copyright_checker.py     # Guardrail copyright EU (DSM Directive + cláusulas TDM opt-out)
│   └── input_validator.py       # Validación de input + prompt injection (patrón OrchestratorIva)
├── tools/
│   ├── pdf_extractor.py         # Extrae texto de PDF/DOCX/XLSX
│   └── schema_validator.py      # Valida JSON de salida
├── prompts/
│   └── doc_analysis.py          # System prompt del agente documental
├── requirements.txt
├── railway.json
└── Dockerfile
```

### Funcionamiento

**Endpoint:** `POST /analyze`

**Input recibido desde Backend API:**
```json
{
  "country": "France",
  "provider": "B2Brouter",
  "documents": [
    {
      "filename": "pricing.pdf",
      "text": "...(texto extraído)...",
      "source_url": "https://example.com/pricing",
      "declared_license": "proprietary"
    }
  ],
  "existing_rules": [],
  "existing_plans": []
}
```

**Output devuelto al Backend API:**
```json
{
  "country": "France",
  "provider": "B2Brouter",
  "currency": "EUR",
  "calculation_basis": "PA transactions",
  "summary": "...",
  "rules": [...],
  "plans": [...],
  "assumptions": [...],
  "ambiguities": [...],
  "conflicts": [],
  "guardrail_audit": {
    "eu_ai_act_check": "passed",
    "copyright_check": "passed",
    "blocked_documents": [],
    "processing_timestamp": "2026-04-28T10:00:00Z"
  }
}
```

**Output en caso de bloqueo por guardrail:**
```json
{
  "error": "copyright_restriction",
  "blocked": true,
  "reason": "Document 'XP-Z12-014.pdf' contains an explicit AI opt-out clause (DSM Directive Art. 4 compliant opt-out detected). Document cannot be processed by AI systems.",
  "affected_documents": ["XP-Z12-014.pdf"],
  "guardrail": "copyright_checker",
  "action_required": "Admin must review documents manually and input rules without AI assistance."
}
```

---

### Guardrail 1 — EU AI Act (`guardrails/eu_ai_act.py`)

El sistema PA Plan Advisor se clasifica como **sistema de IA de riesgo limitado** (no Anexo III) bajo el EU AI Act, dado que:
- Las decisiones finales las toma siempre un humano (Admin aprueba cada regla).
- No afecta a derechos fundamentales ni a decisiones con impacto sobre personas físicas.
- Opera en contexto B2B de compliance fiscal.

El guardrail implementa las obligaciones aplicables:

```python
# guardrails/eu_ai_act.py
"""
EU AI Act Compliance Guardrail
Regulation (EU) 2024/1689 — applicable obligations for limited-risk AI systems:
- Art. 50: Transparency obligations
- Art. 13: Logging and traceability
- Human oversight: Admin approval gate (enforced at Backend level, documented here)
"""

from datetime import datetime
from typing import Dict, Any, List

class EUAIActGuardrail:
    """
    Implements EU AI Act obligations for the PA Doc Agent.
    
    Checks performed before LLM invocation:
    1. Input transparency: log all document metadata before processing
    2. Traceability: generate a processing_id for audit trail
    3. Human oversight reminder: flag output as 'requires_admin_approval'
    4. Prompt injection detection (OWASP LLM Top 10 - LLM01)
    5. Output validation: ensure no rules are marked as 'active' in LLM output
    """

    PROHIBITED_OUTPUT_FIELDS = ['status=active', 'auto_approved', 'activated_by_ai']

    def pre_process_check(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Run before calling CrewAI. Returns audit metadata or raises."""
        processing_id = self._generate_processing_id(payload)

        # 1. Validate input is not attempting prompt injection via document text
        for doc in payload.get('documents', []):
            self._check_prompt_injection(doc['text'], doc['filename'])

        # 2. Validate country/provider are strings, not injection vectors
        self._validate_metadata_fields(payload)

        return {
            'processing_id': processing_id,
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'document_count': len(payload.get('documents', [])),
            'eu_ai_act_check': 'passed',
            'human_oversight_required': True   # Always True — Admin must approve
        }

    def post_process_check(self, output: Dict[str, Any]) -> Dict[str, Any]:
        """Run on LLM output before returning to Backend. Ensures no auto-activation."""
        for rule in output.get('rules', []):
            if rule.get('status') == 'active':
                raise ValueError(
                    f"EU AI Act violation: LLM attempted to set rule '{rule.get('id')}' "
                    f"as active. AI may only propose rules; Admin must approve."
                )
        # Tag all proposed items as pending
        for item in output.get('rules', []) + output.get('plans', []):
            item['status'] = 'pending'
            item['requires_admin_approval'] = True

        return output

    def _check_prompt_injection(self, text: str, filename: str):
        """Detect prompt injection patterns in document text (patrón OrchestratorIva)."""
        INJECTION_PATTERNS = [
            r'ignore\s+(previous|prior|all)\s+instruction',
            r'disregard\s+all',
            r'you\s+are\s+now\s+(a\s+)?(developer|admin|system)',
            r'override\s+(system|previous)\s+(instruction|prompt)',
            r'new\s+instruction:',
            r'jailbreak',
        ]
        import re
        for pattern in INJECTION_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                raise ValueError(
                    f"Security: Prompt injection pattern detected in document '{filename}'. "
                    f"Document rejected. Pattern: {pattern}"
                )

    def _validate_metadata_fields(self, payload: Dict[str, Any]):
        import re
        for field in ['country', 'provider']:
            value = payload.get(field, '')
            if not re.match(r'^[\w\s\-\.]{1,100}$', value):
                raise ValueError(f"Invalid metadata field '{field}': '{value}'")

    def _generate_processing_id(self, payload: Dict[str, Any]) -> str:
        import hashlib, json
        content = json.dumps({
            'country': payload.get('country'),
            'provider': payload.get('provider'),
            'doc_names': [d['filename'] for d in payload.get('documents', [])],
            'timestamp': datetime.utcnow().isoformat()
        }, sort_keys=True)
        return hashlib.sha256(content.encode()).hexdigest()[:16]
```

---

### Guardrail 2 — Copyright EU (`guardrails/copyright_checker.py`)

Implementa la verificación de restricciones de copyright sobre los documentos antes de procesarlos con IA, en cumplimiento con:

- **DSM Directive (EU) 2019/790, Art. 4**: excepción de minería de texto y datos (TDM) para investigación científica, **revocable si el titular ejerce el opt-out de forma apropiada**.
- **DSM Directive Art. 3**: TDM por organismos de investigación, también sujeto a opt-out.
- **InfoSoc Directive 2001/29/EC**: derechos de reproducción y transformación.
- **EU AI Act Art. 53(1)(c)**: los sistemas de IA deben respetar el derecho de autor en los datos de entrenamiento e inferencia.

```python
# guardrails/copyright_checker.py
"""
EU Copyright Compliance Guardrail
References:
- DSM Directive (EU) 2019/790, Arts. 3 and 4 (TDM exception + opt-out)
- InfoSoc Directive 2001/29/EC
- EU AI Act (EU) 2024/1689, Art. 53(1)(c)
- https://digital-strategy.ec.europa.eu/en/policies/copyright-legislation
"""

import re
from typing import Dict, Any, List, Tuple

# Patterns that indicate an explicit AI/TDM opt-out under DSM Directive Art. 4
# When a rightsholder expresses these, the TDM exception no longer applies.
AI_OPTOUT_PATTERNS = [
    # English
    r'(expressly\s+)?(prohibit|oppose|object|forbid).{0,80}(AI|artificial intelligence|machine learning|LLM)',
    r'(no|not\s+permitted).{0,60}(AI|artificial intelligence).{0,60}(processing|training|ingestion|mining)',
    r'text\s+and\s+data\s+mining.{0,60}(prohibited|not\s+permitted|reserved)',
    r'TDM\s+(opt.out|restriction|prohibited)',
    r'AI.{0,30}(opt.out|restriction|prohibited)',
    # French (e.g. AFNOR pattern)
    r"s'oppose\s+expressément.{0,120}(intelligence\s+artificielle|IA)",
    r"s'oppose\s+également.{0,120}(fouille\s+de\s+textes|création\s+dérivée).{0,80}(IA|intelligence artificielle)",
    r"(intégration|transmission|absorption).{0,60}(IA|intelligence\s+artificielle)",
    # Spanish
    r'(prohíbe|se\s+opone).{0,80}(inteligencia\s+artificial|IA)',
    # German
    r'(verbietet|untersagt).{0,80}(künstliche\s+Intelligenz|KI)',
]

# Patterns indicating restricted reproduction rights
REPRODUCTION_RESTRICTION_PATTERNS = [
    r'all\s+rights\s+reserved',
    r'todos\s+los\s+derechos\s+reservados',
    r'tous\s+droits\s+réservés',
    r'©.{0,80}(all\s+rights|rights\s+reserved)',
    r'reproduction\s+(prohibited|not\s+permitted|reserved)',
    r'no\s+part.{0,100}(reproduced|copied|transmitted)',
]

class CopyrightChecker:

    def check_documents(self, documents: List[Dict[str, Any]]) -> Tuple[bool, List[Dict]]:
        """
        Check all documents for copyright restrictions before AI processing.
        
        Returns:
            (all_clear: bool, results: list of per-document check results)
        """
        results = []
        all_clear = True

        for doc in documents:
            text_sample = doc.get('text', '')[:3000]  # Check first 3000 chars (headers/licenses)
            filename = doc.get('filename', 'unknown')

            ai_blocked, ai_reason = self._check_ai_optout(text_sample, filename)
            repro_restricted, repro_reason = self._check_reproduction_rights(text_sample, filename)

            if ai_blocked:
                all_clear = False
                results.append({
                    'filename': filename,
                    'status': 'blocked',
                    'reason': ai_reason,
                    'restriction_type': 'ai_optout',
                    'legal_basis': 'DSM Directive Art. 4 opt-out / EU AI Act Art. 53(1)(c)',
                    'action': 'Document must be reviewed manually by Admin. AI processing not permitted.'
                })
            elif repro_restricted:
                results.append({
                    'filename': filename,
                    'status': 'restricted',
                    'reason': repro_reason,
                    'restriction_type': 'reproduction_rights',
                    'legal_basis': 'InfoSoc Directive 2001/29/EC',
                    'action': 'Extract only factual rules (not verbatim text). source_excerpt must be paraphrased.'
                })
            else:
                results.append({
                    'filename': filename,
                    'status': 'clear',
                    'reason': 'No copyright restrictions detected in document headers.',
                    'action': 'Document may be processed. Cite source in extracted rules.'
                })

        return all_clear, results

    def _check_ai_optout(self, text: str, filename: str) -> Tuple[bool, str]:
        for pattern in AI_OPTOUT_PATTERNS:
            match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
            if match:
                excerpt = match.group(0)[:200]
                return True, (
                    f"Document '{filename}' contains an explicit AI opt-out clause under "
                    f"DSM Directive Art. 4. Detected: '{excerpt}'. "
                    f"AI processing is not permitted."
                )
        return False, ''

    def _check_reproduction_rights(self, text: str, filename: str) -> Tuple[bool, str]:
        for pattern in REPRODUCTION_RESTRICTION_PATTERNS:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return True, (
                    f"Document '{filename}' has reproduction restrictions. "
                    f"Verbatim extraction prohibited; factual rules only."
                )
        return False, ''
```

---

### Integración de guardrails en `main.py`

```python
# main.py (extracto del endpoint /analyze)
from guardrails.eu_ai_act import EUAIActGuardrail
from guardrails.copyright_checker import CopyrightChecker

eu_ai_act  = EUAIActGuardrail()
copyright  = CopyrightChecker()

@app.post("/analyze")
async def analyze(payload: AnalyzeRequest):
    # --- GUARDRAIL 1: Copyright check ---
    all_clear, copyright_results = copyright.check_documents(payload.documents)
    blocked_docs = [r for r in copyright_results if r['status'] == 'blocked']

    if blocked_docs:
        return JSONResponse(status_code=451, content={  # 451 = Unavailable For Legal Reasons
            "error": "copyright_restriction",
            "blocked": True,
            "reason": blocked_docs[0]['reason'],
            "affected_documents": [d['filename'] for d in blocked_docs],
            "guardrail": "copyright_checker",
            "action_required": blocked_docs[0]['action']
        })

    # Filter out restricted docs from LLM processing; keep only 'clear' or 'restricted'
    # For 'restricted' docs: instruct LLM to paraphrase, not quote verbatim
    processable_docs = [
        {**doc, '_copyright_status': next(
            r['status'] for r in copyright_results if r['filename'] == doc['filename']
        )}
        for doc in payload.documents
    ]

    # --- GUARDRAIL 2: EU AI Act pre-process check ---
    try:
        audit_meta = eu_ai_act.pre_process_check(payload.dict())
    except ValueError as e:
        return JSONResponse(status_code=400, content={
            "error": "eu_ai_act_violation",
            "blocked": True,
            "reason": str(e),
            "guardrail": "eu_ai_act"
        })

    # --- Run CrewAI analysis ---
    raw_output = run_crew(processable_docs, payload.country, payload.provider,
                          payload.existing_rules, payload.existing_plans)

    # --- GUARDRAIL 2: EU AI Act post-process check ---
    try:
        validated_output = eu_ai_act.post_process_check(raw_output)
    except ValueError as e:
        return JSONResponse(status_code=500, content={
            "error": "eu_ai_act_output_violation",
            "reason": str(e),
            "guardrail": "eu_ai_act"
        })

    validated_output['guardrail_audit'] = {
        **audit_meta,
        'copyright_results': copyright_results
    }
    return validated_output
```

---

### Agentes CrewAI

| Agente | Rol | Herramientas |
|---|---|---|
| `document_reader` | Estructura el texto ya extraído | Contexto de documentos |
| `rules_analyst` | Identifica reglas de cálculo PA | Contexto de documentos |
| `plans_analyst` | Extrae planes, fees, transacciones incluidas | Contexto de documentos |
| `conflict_detector` | Detecta ambigüedades y conflictos entre documentos | Contexto completo |
| `output_formatter` | Ensambla el JSON estructurado final | `schema_validator` |

### System prompt principal

```
You are a document analysis agent for an e-invoicing/e-reporting PA plan calculator.
Your task is to extract calculation rules, pricing plans, assumptions, ambiguities
and conflicts from the provided documents.

IMPORTANT CONSTRAINTS (EU AI Act + Copyright compliance):
- Do not reproduce verbatim text from documents marked as 'restricted' copyright.
  For restricted documents, paraphrase factual information only.
- Do not produce client-facing recommendations.
- Do not activate or modify rules. All output status must be 'pending'.
- Return structured JSON only.
- Every extracted rule or plan must include: confidence score, source document name,
  and a paraphrased (not verbatim) excerpt.
- If information is missing, explicitly state what is missing.
- If documents conflict, flag the conflict with both source references.
- Never claim to be acting autonomously. Always indicate human review is required.
```

### Hosting en Railway

```json
// railway.json
{
  "build": { "builder": "DOCKERFILE" },
  "deploy": {
    "startCommand": "uvicorn main:app --host 0.0.0.0 --port $PORT",
    "healthcheckPath": "/health"
  }
}
```

La URL del servicio Railway se configura como `DOC_AGENT_URL` en el Backend API. La comunicación entre App 2 y App 3 usa la **red interna de Railway** (`pa-doc-agent.railway.internal`) eliminando latencia y coste de red pública.

---

## 6. Aplicación 4 — Agente de Resumen DSPy (Railway)

### Propósito

Recibe el resultado cerrado de un cálculo ya realizado y genera un texto comercial en inglés explicando la recomendación de plan. **No recalcula ni modifica cifras.**

### Base de referencia

Basado en la arquitectura de **`DSPy-Assistant`**:
- `ConversationManager` con soporte multi-modelo (OpenAI como principal)
- Configuración de modelos via variables de entorno
- Expuesto como API HTTP (FastAPI)

### Estructura del proyecto

```
pa-summary-agent/
├── main.py                  # FastAPI app
├── assistant/
│   ├── __init__.py
│   ├── summary_agent.py     # Módulo DSPy para generar resumen
│   ├── models/
│   │   └── model_config.py  # Configuración modelos (OpenAI, Groq)
│   └── prompts/
│       └── summary_prompt.py # Prompt del agente de resumen
├── requirements.txt
├── railway.json
└── Dockerfile
```

### Funcionamiento

**Endpoint:** `POST /generate-summary`

**Input recibido desde Backend API:**
```json
{
  "country": "France",
  "provider": "B2Brouter",
  "profile_version": "v1.0",
  "inputs": { "issued_einvoicing": 1000, ... },
  "transaction_breakdown": [...],
  "plan_comparison": [...],
  "recommended_plan": { "plan_name": "Plan 3", "total_annual_cost": 1218 },
  "assumptions": [...]
}
```

**Output devuelto:**
```json
{
  "summary": "Based on the estimated annual volume, the client would consume
    5,400 PA transactions per year. The recommended option is Plan 3..."
}
```

### Módulo DSPy

```python
# Patrón tomado de DSPy-Assistant
import dspy

class SummarySignature(dspy.Signature):
    """Generate a commercial English summary of a PA plan calculation result."""
    calculation_result: str = dspy.InputField()
    summary: str = dspy.OutputField(
        desc="Clear English explanation of the recommended plan"
    )

class SummaryAgent(dspy.Module):
    def __init__(self):
        self.generate = dspy.ChainOfThought(SummarySignature)

    def forward(self, calculation_result):
        return self.generate(calculation_result=calculation_result)
```

### System prompt principal

```
You are a commercial explanation agent.
Write in English.
Explain the recommended plan clearly and concisely.
Do not recalculate.
Do not change numbers.
Use only the calculation result provided.
Mention total PA transactions, recommended plan, annual cost and excess transactions if any.
Explain why the recommended plan is more cost-effective than the closest
lower and higher alternatives when relevant.
```

### Hosting en Railway

Igual que el Agente DocIA: Dockerfile + `railway.json`. URL configurada como `SUMMARY_AGENT_URL` en el Backend API.

---

## 7. Railway — Base de datos y almacenamiento de documentos

### Railway PostgreSQL (13 tablas)

Todas las tablas de dominio viven en Railway PostgreSQL. App 2 (Express) se conecta directamente usando `DATABASE_URL` inyectada por Railway. La red interna del proyecto elimina latencia y no consume ancho de banda de red pública.

**Ventaja frente a Supabase DB:** latencia sub-milisegundo entre App 2 y la BD al compartir red interna Railway. Sin coste adicional de Supabase Pro para acceso directo desde backend externo.

> **Nota:** `users_profile` se puebla con un webhook de Supabase Auth (`auth.users` → trigger → `INSERT` en Railway PostgreSQL) o manualmente en el primer login del usuario.

---

#### 7.1 `users_profile`

Extiende la identidad de Supabase Auth con rol y empresa. El `id` es el mismo UUID que Supabase genera en `auth.users`.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | = `auth.users.id` de Supabase |
| `email` | `text` | Copiado de Supabase Auth para consultas internas |
| `full_name` | `text` | |
| `role` | `enum('admin','internal','client')` | Consultado por App 2 para autorización |
| `company_id` | `uuid` nullable | FK → `companies.id` |
| `active` | `boolean` | Default `true`. Permite desactivar usuarios sin borrarlos |
| `created_at` | `timestamp` | |

---

#### 7.2 `companies`

Empresas internas y clientes externos. Agrupa usuarios de tipo `client` bajo una misma empresa.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `name` | `text` | Nombre comercial de la empresa |
| `type` | `enum('internal','client')` | Distingue empresa propia de cliente externo |
| `created_at` | `timestamp` | |

---

#### 7.3 `countries`

Catálogo de países para los que se configuran calculadoras.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `code` | `text` | ISO 3166-1 alpha-2, ej. `FR`, `ES`, `IT` |
| `name` | `text` | Nombre completo, ej. `France` |
| `created_by` | `uuid` | FK → `users_profile.id` |
| `created_at` | `timestamp` | |

---

#### 7.4 `providers`

Proveedores PA (Plataforma de Acceso) o PDP configurables.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `name` | `text` | Ej. `B2Brouter` |
| `type` | `text` | Ej. `PA`, `PDP` |
| `created_at` | `timestamp` | |

---

#### 7.5 `calculation_profiles`

Versión de reglas y planes para una combinación país + proveedor. Solo una versión puede estar `active` por combinación.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `country_id` | `uuid` | FK → `countries.id` |
| `provider_id` | `uuid` | FK → `providers.id` |
| `version` | `text` | Ej. `v1.0`, `v1.1` |
| `currency` | `text` | Ej. `EUR` |
| `status` | `enum('draft','pending_approval','active','archived')` | Solo `active` visible para clientes |
| `calculation_basis` | `text` | Ej. `PA transactions` |
| `active_from` | `date` nullable | Fecha de vigencia inicio |
| `active_to` | `date` nullable | Fecha de vigencia fin |
| `created_by` | `uuid` | FK → `users_profile.id` |
| `approved_by` | `uuid` nullable | FK → `users_profile.id` (Admin que activó) |
| `approved_at` | `timestamp` nullable | |
| `created_at` | `timestamp` | |

---

#### 7.6 `transaction_rules`

Reglas de consumo de PA transactions por tipo de operación. Generadas por el agente documental, aprobadas por el Admin.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `profile_id` | `uuid` | FK → `calculation_profiles.id` |
| `input_key` | `text` | Ej. `issued_einvoicing`. Usado como clave dinámica en calculadora |
| `label` | `text` | Ej. `Issued e-invoicing invoices/year` |
| `direction` | `text` | `Issued` / `Received` |
| `obligation` | `text` | `E-invoicing` / `E-reporting` / `Payment e-reporting` |
| `operation_group` | `text` | Ej. `Domestic B2B invoices` |
| `pa_transactions_per_item` | `numeric` | Multiplicador para el cálculo |
| `reason` | `text` | Justificación extraída del documento |
| `source_document_id` | `uuid` nullable | FK → `documents.id` |
| `source_excerpt` | `text` nullable | Extracto paráfraseado del documento fuente |
| `confidence` | `enum('high','medium','low')` | Nivel de confianza del agente |
| `status` | `enum('proposed','approved','rejected','pending_confirmation')` | Nunca `active` directamente — pasa por aprobación |
| `ai_proposed_value` | `jsonb` nullable | Valor original propuesto por IA (inmutable tras edición) |
| `manually_edited` | `boolean` | `true` si el Admin modificó el valor propuesto |
| `approved_by` | `uuid` nullable | FK → `users_profile.id` |
| `approved_at` | `timestamp` nullable | |
| `created_at` | `timestamp` | |

---

#### 7.7 `plans`

Planes comerciales del proveedor con sus tarifas. Generados por el agente, aprobados por el Admin.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `profile_id` | `uuid` | FK → `calculation_profiles.id` |
| `plan_name` | `text` | Ej. `Plan 1`, `Plan 3` |
| `included_pa_transactions` | `numeric` | Transacciones incluidas en el fee anual |
| `annual_fee` | `numeric` | Fee fijo anual en `currency` del perfil |
| `monthly_fee` | `numeric` nullable | Fee mensual equivalente (informativo) |
| `extra_transaction_cost` | `numeric` | Coste por transacción adicional |
| `status` | `enum('proposed','approved','rejected')` | Aprobación manual obligatoria |
| `source_document_id` | `uuid` nullable | FK → `documents.id` |
| `source_excerpt` | `text` nullable | Extracto paráfraseado del documento fuente |
| `confidence` | `enum('high','medium','low')` | Nivel de confianza del agente |
| `approved_by` | `uuid` nullable | FK → `users_profile.id` |
| `approved_at` | `timestamp` nullable | |
| `created_at` | `timestamp` | |

---

#### 7.8 `assumptions`

Supuestos de negocio que condicionan el cálculo pero no son reglas directas (ej. tratamiento B2C).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `profile_id` | `uuid` | FK → `calculation_profiles.id` |
| `key` | `text` | Ej. `b2c_treatment` |
| `value` | `text` | Ej. `Invoice by invoice` |
| `reason` | `text` nullable | Justificación del supuesto |
| `status` | `enum('proposed','approved','rejected','pending_confirmation')` | |
| `source_document_id` | `uuid` nullable | FK → `documents.id` |
| `created_at` | `timestamp` | |

---

#### 7.9 `documents`

Metadata de los documentos subidos por el Admin. El binario se almacena en el Railway Volume.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `country_id` | `uuid` | FK → `countries.id` |
| `provider_id` | `uuid` | FK → `providers.id` |
| `profile_id` | `uuid` nullable | FK → `calculation_profiles.id` |
| `filename` | `text` | Nombre original del archivo |
| `storage_path` | `text` | Ruta en Railway Volume, ej. `/data/documents/{profile_id}/{filename}`. Nunca se expone en la API |
| `document_type` | `text` | `provider_pricing` / `transaction_guide` / `country_legal` / `contract` / `commercial_confirmation` / `other` |
| `description` | `text` nullable | Descripción libre del Admin |
| `copyright_status` | `enum('pending','clear','restricted','blocked')` | Resultado del guardrail `CopyrightChecker` |
| `copyright_reason` | `text` nullable | Motivo del bloqueo o restricción si aplica |
| `uploaded_by` | `uuid` | FK → `users_profile.id` |
| `created_at` | `timestamp` | |

---

#### 7.10 `document_analyses`

Resultado completo del agente documental (App 3) para un análisis. Incluye la auditoría de los guardrails.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `profile_id` | `uuid` | FK → `calculation_profiles.id` |
| `document_ids` | `uuid[]` | Array de FKs a `documents.id` incluidos en el análisis |
| `analysis_json` | `jsonb` | JSON completo devuelto por App 3 (rules, plans, assumptions, ambiguities, conflicts) |
| `summary` | `text` | Resumen textual del análisis generado por el agente |
| `status` | `enum('completed','failed','pending_review')` | |
| `guardrail_audit` | `jsonb` | Resultado de EU AI Act check + Copyright check + `processing_id` |
| `created_by` | `uuid` | FK → `users_profile.id` |
| `created_at` | `timestamp` | |

---

#### 7.11 `scenarios`

Cálculos guardados. Cada vez que un usuario ejecuta la calculadora se crea un escenario.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `company_id` | `uuid` nullable | FK → `companies.id` (empresa del cliente) |
| `client_name` | `text` | Nombre libre introducido por el usuario en la calculadora |
| `profile_id` | `uuid` | FK → `calculation_profiles.id` (versión de reglas usada) |
| `input_json` | `jsonb` | Inputs introducidos por el usuario, ej. `{"issued_einvoicing": 1000, ...}` |
| `result_json` | `jsonb` | Output completo del cálculo: `transaction_breakdown`, `plan_comparison`, `recommended_plan` |
| `recommended_plan_id` | `uuid` | FK → `plans.id` |
| `ai_summary` | `text` nullable | Resumen en inglés generado por App 4. Null hasta que el usuario lo solicite |
| `created_by` | `uuid` | FK → `users_profile.id` |
| `created_at` | `timestamp` | |

---

#### 7.12 `ai_usage_logs`

Registro de cada llamada a IA para control de costes y auditoría. El cálculo determinista **no** genera entradas aquí.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` | FK → `users_profile.id` |
| `action` | `text` | `document_analysis` / `generate_summary` / `re_analyze_document` |
| `model` | `text` | Ej. `gpt-4o` |
| `input_tokens` | `integer` nullable | Tokens de entrada consumidos |
| `output_tokens` | `integer` nullable | Tokens de salida generados |
| `estimated_cost` | `numeric` nullable | Coste estimado en USD |
| `document_id` | `uuid` nullable | FK → `documents.id` si la acción es documental |
| `scenario_id` | `uuid` nullable | FK → `scenarios.id` si la acción es un resumen |
| `processing_id` | `text` nullable | `processing_id` del guardrail EU AI Act para trazabilidad |
| `created_at` | `timestamp` | |

---

#### 7.13 `audit_logs`

Historial inmutable de cambios en entidades críticas (reglas, planes, activaciones de perfil). Permite saber quién cambió qué y cuándo.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` | FK → `users_profile.id` (Admin que realizó la acción) |
| `action` | `text` | Ej. `approve_rule`, `edit_plan`, `activate_profile`, `reject_rule` |
| `entity_type` | `text` | `transaction_rule` / `plan` / `assumption` / `calculation_profile` |
| `entity_id` | `uuid` | ID de la entidad afectada |
| `before_json` | `jsonb` nullable | Estado anterior de la entidad (para ediciones) |
| `after_json` | `jsonb` nullable | Estado posterior de la entidad |
| `created_at` | `timestamp` | |

---

### Railway Volume (almacenamiento de documentos)

- **Tipo:** Railway Persistent Volume
- **Ruta de montaje:** `/data/documents` en el contenedor de App 2
- **Coste:** $0.25/GB/mes — sin coste de egress en red interna
- **Estructura:** `/data/documents/{profile_id}/{filename}`
- Solo App 2 escribe y lee el Volume directamente
- App 3 recibe el texto ya extraído en el payload de `/analyze`, no accede al Volume

```
/data/documents/
├── profile_abc123/
│   ├── pricing_b2brouter_fr.pdf
│   └── guide_einvoicing_fr.docx
└── profile_def456/
    └── tariff_sheet_es.xlsx
```

### Seguridad del Volume

- Solo accesible desde dentro del contenedor de App 2 (no expuesto públicamente)
- Las rutas de fichero nunca se exponen en respuestas de API
- App 2 valida `profile_id` en la ruta antes de leer/escribir (previene path traversal)

---

## 8. Supabase — Auth y gestión de usuarios

Supabase se usa **exclusivamente** para autenticación de usuarios. No contiene tablas de negocio ni archivos.

### Auth

- Login con `supabase.auth.signInWithPassword({ email, password })`
- JWT devuelto se almacena en cookie httpOnly en el frontend
- App 2 (Backend) valida el JWT con `supabase.auth.getUser(token)` para identificar al usuario
- **El rol** se consulta en Railway PostgreSQL (`users_profile.role`), nunca en el JWT claims

### Entidad gestionada en Supabase

| Entidad | Descripción |
|---|---|
| `auth.users` (nativa Supabase) | Credenciales (email, password hash), sesiones, tokens de refresh |

### Tabla espejo en Railway PostgreSQL

| Campo | Origen | Descripción |
|---|---|---|
| `id` | = `auth.users.id` | UUID idéntico al generado por Supabase |
| `email` | Copiado de Auth | Para consultas internas sin llamar a Supabase |
| `full_name` | Manual | Nombre del usuario |
| `role` | Manual Admin | `admin` / `internal` / `client` |
| `company_id` | Manual Admin | FK a `companies` — obligatorio para usuarios `client` |
| `active` | Manual Admin | `false` = usuario desactivado (no puede login) |

### Tipos de usuario a crear

#### `admin` — Usuario interno con control total

- Creado directamente por el equipo técnico en Supabase Dashboard o via API
- `company_id`: referencia a la empresa interna (type = `internal`)
- Sin límite de uso IA recomendado (o límite alto configurable)
- Únicas acciones exclusivas: subir documentos, analizar con IA, aprobar reglas, activar perfiles
- **Mínimo 1 admin** debe existir antes de que el sistema sea funcional

#### `internal` — Usuario interno operativo

- Creado por el Admin desde `/admin/settings` o directamente en Supabase Dashboard
- `company_id`: referencia a la empresa interna (type = `internal`)
- Límite IA sugerido: **50 resúmenes/mes** (configurable en `ai_usage_logs` + lógica en App 2)
- Puede calcular sobre cualquier país activo y generar resúmenes en inglés
- No puede ver ni modificar configuración de países

#### `client` — Usuario cliente externo

- Creado por el Admin y asociado a una empresa cliente (`companies.type = 'client'`)
- `company_id`: **obligatorio** — FK a la empresa cliente correspondiente
- Solo ve países/proveedores con `calculation_profiles.status = 'active'`
- Límite IA sugerido: **0–10 resúmenes/mes**, configurable por empresa
- El botón "Generate English summary" puede estar deshabilitado según configuración de empresa
- Solo puede ver escenarios propios o de su empresa (`scenarios.company_id = users_profile.company_id`)

### Flujo de creación de usuarios

```
Admin crea usuario en Supabase Dashboard (o via Supabase Admin API):
  → Supabase genera auth.users.id (UUID) + envía email de bienvenida

Admin inserta users_profile en Railway PostgreSQL:
  POST /admin/users
  {
    "supabase_id": "<uuid>",
    "email": "user@example.com",
    "full_name": "User Name",
    "role": "client",
    "company_id": "<company_uuid>"
  }
  → App 2 → INSERT INTO users_profile (Railway PostgreSQL)

Para desactivar un usuario:
  PATCH /admin/users/:id { "active": false }
  → App 2 → UPDATE users_profile SET active = false
  → El middleware del Frontend rechaza el JWT si users_profile.active = false
```

### Límites de consumo IA por rol (PDF §5.9)

| Rol | Acción permitida | Límite sugerido |
|---|---|---|
| `admin` | Document analysis, Generate summary, Re-analyze | Sin límite inicial (o alto configurable) |
| `internal` | Generate summary | 50 resúmenes/mes |
| `client` | Generate summary (si habilitado) | 0–10 resúmenes/mes, configurable |

Los límites se verifican en App 2 consultando `ai_usage_logs` antes de llamar a App 3 o App 4. El cálculo determinista **nunca** consume cuota IA.

### Row Level Security

No se usa RLS de Supabase para tablas de negocio (están en Railway). El control de acceso lo implementa App 2 (Express middleware `requireAdmin`, `requireAuth`, `checkAIQuota`).

---

## 9. Flujos entre aplicaciones

### Flujo de alta de país (Admin)

```
Frontend (Admin login via Supabase Auth)
  → POST /admin/countries
      → App 2 (Express/Railway)
      → Railway PostgreSQL (INSERT countries)

  → POST /admin/documents/upload
      → App 2 (Express/Railway)
      → Railway Volume: guardar binario en /data/documents/{profile_id}/
      → Railway PostgreSQL (INSERT documents: filename, filepath, copyright_status='pending')

  → POST /admin/documents/analyze
      → App 2 (Express/Railway) [checkAIQuota — Admin sin límite, pero registrado]
      → Lee binarios del Railway Volume (/data/documents/{profile_id}/)
      → Extrae texto (pdf-parse, mammoth, xlsx)
      → [red interna Railway] → App 3 (Agente DocIA)
          ↓ Guardrail 1: CopyrightChecker
            Si AI opt-out detectado → HTTP 451 → App 2 → Frontend (error estructurado)
          ↓ Guardrail 2: EUAIActGuardrail (pre-process)
            Si prompt injection en texto → HTTP 400 → App 2 → Frontend
          ↓ CrewAI analysis
          ↓ EUAIActGuardrail (post-process): fuerza status='pending' en todas las reglas
          ← JSON {rules, plans, assumptions, ambiguities, guardrail_audit}
      → Railway PostgreSQL (INSERT document_analyses, transaction_rules, plans)
      → Railway PostgreSQL (UPDATE documents.copyright_status)
      → Railway PostgreSQL (INSERT ai_usage_logs: action='document_analysis', tokens, processing_id)

  → Admin revisa reglas/planes en Frontend (/admin/analyses/:id)
  → POST /admin/rules/:id/approve
      → App 2 → Railway PostgreSQL (UPDATE transaction_rules.status = 'approved')
  → POST /admin/profiles/:id/activate
      → App 2 → Railway PostgreSQL (UPDATE calculation_profiles.status = 'active')
      → Frontend: país/proveedor visible para Client/Internal
```

### Flujo de cálculo (Client/Internal/Admin)

```
Frontend (Calculator)
  → GET /calculator/profile/:id
      → App 2 → Railway PostgreSQL (SELECT active transaction_rules)
      ← inputs dinámicos generados

  → POST /calculator/calculate
      → App 2 → Cálculo determinista (sin IA, solo Railway PostgreSQL)
      → Railway PostgreSQL (INSERT scenarios con inputs + resultados)
      ← resultado + scenario_id

  → POST /scenarios/:id/generate-summary
      → App 2 [checkAIQuota]
          Si cuota superada → HTTP 429 {error: 'ai_quota_exceeded'} → Frontend
      → [red interna Railway] → App 4 (Agente Resumen DSPy)
          ← texto comercial en inglés
      → Railway PostgreSQL (UPDATE scenarios.ai_summary)
      → Railway PostgreSQL (INSERT ai_usage_logs: action='generate_summary', scenario_id, tokens)
      ← resumen mostrado en Frontend
```

### Flujo de sincronización de usuarios

```
Admin crea usuario en Supabase Auth (dashboard o API)
  → Webhook / llamada manual a App 2:
    POST /admin/users { supabase_id, role, company_id }
  → App 2 → Railway PostgreSQL (INSERT users_profile)

Usuario hace login en Frontend:
  → Supabase Auth → JWT cookie httpOnly
  → Todas las peticiones posteriores llevan JWT en Authorization header
  → App 2 valida JWT con Supabase (solo identidad)
  → App 2 consulta rol en Railway PostgreSQL (users_profile)
```

---

## 10. Variables de entorno por aplicación

### Frontend (Netlify)

```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
API_BASE_URL=https://pa-plan-api.up.railway.app/api
```

### Backend API (Railway)

```env
# Railway inyecta DATABASE_URL automáticamente al conectar el servicio PostgreSQL
DATABASE_URL=postgresql://postgres:xxx@postgres.railway.internal:5432/railway

# Supabase — solo para validar JWT (no DB, no Storage)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...            # Anon key suficiente para getUser()

# Railway Volume — ruta de montaje configurada en Railway dashboard
DOCUMENTS_PATH=/data/documents

# URLs internas Railway (red privada — sin coste de egress)
DOC_AGENT_URL=http://pa-doc-agent.railway.internal:8000
SUMMARY_AGENT_URL=http://pa-summary-agent.railway.internal:8001

AGENT_API_KEY=xxx                   # Clave compartida para llamadas internas
NODE_ENV=production
PORT=3000
```

### Agente DocIA — Railway (App 3)

```env
OPENAI_API_KEY=sk-...
AGENT_API_KEY=xxx
PORT=8000

# Configuración guardrails
COPYRIGHT_CHECK_ENABLED=true         # Activar/desactivar guardrail copyright
EU_AI_ACT_CHECK_ENABLED=true         # Activar/desactivar guardrail EU AI Act
MAX_CHARS_PER_DOC=20000              # Límite de texto por documento antes de enviar al LLM
COPYRIGHT_SCAN_CHARS=3000            # Chars iniciales del doc a escanear por copyright
```

### Agente Resumen — Railway (App 4)

```env
OPENAI_API_KEY=sk-...
AGENT_API_KEY=xxx
PORT=8001
```

---

## 11. Roadmap de desarrollo (orden sugerido)

### Fase 0 — Infraestructura base

- [ ] Crear proyecto Railway y añadir servicio PostgreSQL
- [ ] Crear tablas según modelo de datos (sección 7): 13 tablas (7.1–7.13)
- [ ] Crear Railway Volume y configurar montaje en `/data/documents`
- [ ] Crear proyecto Supabase (solo Auth): configurar email/password login
- [ ] Crear usuarios de prueba con cada rol en Supabase + sincronizar `users_profile` en Railway PostgreSQL

### Fase 1 — Backend API (Railway)

- [ ] Clonar/inicializar proyecto basado en `ExpressApi`
- [ ] Configurar `lib/db.js` con pool PostgreSQL Railway
- [ ] Implementar `lib/storage.js` para Railway Volume
- [ ] Implementar middleware auth JWT Supabase (solo validación de identidad)
- [ ] Implementar `requireAdmin` consultando rol en Railway PostgreSQL
- [ ] Implementar endpoints de Countries y Providers
- [ ] Implementar endpoints de Profiles (CRUD + activate)
- [ ] Implementar endpoint de cálculo determinista
- [ ] Deploy en Railway y verificar

### Fase 2 — Frontend (Netlify)

- [ ] Clonar `b2brouter-calculator` como base
- [ ] Adaptar auth real con Supabase (patrón `AstroChatBot`)
- [ ] Implementar middleware de roles y protección de rutas
- [ ] Construir páginas Admin: countries, setup, documents
- [ ] Construir calculadora dinámica (inputs desde API)
- [ ] Construir vista de escenarios y resultados
- [ ] Deploy en Netlify y verificar

### Fase 3 — Agente Documental (Railway)

- [ ] Inicializar proyecto Python + FastAPI + CrewAI
- [ ] Implementar `guardrails/copyright_checker.py` (patrones AI opt-out DSM Directive)
- [ ] Implementar `guardrails/eu_ai_act.py` (pre/post process + prompt injection)
- [ ] Implementar extracción de texto de documentos en App 2 (PDF, DOCX, XLSX)
- [ ] Definir agentes y tareas CrewAI con instrucciones de copyright en system prompt
- [ ] Implementar validación del JSON de salida (`schema_validator.py`)
- [ ] Exponer endpoint `POST /analyze` con guardrails integrados
- [ ] Deploy en Railway (red interna) y conectar con Backend API
- [ ] Integrar en flujo de análisis del Frontend Admin
- [ ] Verificar respuesta HTTP 451 para documentos con AI opt-out

### Fase 4 — Agente de Resumen (Railway)

- [ ] Inicializar proyecto Python + FastAPI + DSPy (base `DSPy-Assistant`)
- [ ] Implementar `SummarySignature` y `SummaryAgent` DSPy
- [ ] Exponer endpoint `POST /generate-summary`
- [ ] Deploy en Railway y conectar con Backend API
- [ ] Integrar botón "Generate English summary" en Frontend

### Fase 5 — Integración y MVP completo

- [ ] Test del flujo completo: France/B2Brouter (alta → cálculo → resumen)
- [ ] Implementar `ai_usage_logs` (registrar cada llamada IA con `processing_id`)
- [ ] Implementar `audit_logs` para cambios de reglas por Admin
- [ ] Revisar seguridad: rate limiting en endpoints IA, validación path traversal en Volume
- [ ] Verificar guardrails: test con documento AFNOR (debe devolver HTTP 451)
- [ ] Verificar criterios de aceptación del PDF

---

## 12. Criterios de aceptación del MVP

### Alta de país

- [ ] Admin puede crear France/B2Brouter desde el Frontend
- [ ] Admin puede subir documentos PDF/DOCX
- [ ] Agente DocIA devuelve reglas y planes estructurados con confianza y extracto
- [ ] Admin puede aprobar/editar/rechazar reglas individualmente
- [ ] Admin puede activar el perfil (validaciones: al menos 1 regla + 1 plan aprobados, sin conflictos críticos)
- [ ] France/B2Brouter aparece en lista de clientes solo tras activación

### Calculadora

- [ ] Inputs se generan dinámicamente desde `transaction_rules` activas
- [ ] Cálculo es determinista (sin llamadas IA)
- [ ] Sistema compara todos los planes y recomienda el de menor coste total anual
- [ ] Escenario se guarda con versión de reglas usada

### Resumen IA

- [ ] Resumen generado en inglés, claro y comercial
- [ ] No cambia ninguna cifra del cálculo
- [ ] Explica por qué el plan recomendado es más conveniente que alternativas

### Guardrails documentales

- [ ] Documento con cláusula AI opt-out explícita devuelve HTTP 451 con razón detallada
- [ ] Documento con "all rights reserved" pero sin AI opt-out: procesado con instrucción de paráfrasis
- [ ] Texto del documento con patrón de prompt injection devuelve HTTP 400
- [ ] Ninguna regla o plan en el output del agente tiene `status = 'active'`
- [ ] Cada análisis genera un `processing_id` único almacenado en `document_analyses`
- [ ] El campo `guardrail_audit` aparece en todos los responses de `/analyze`

### Seguridad

- [ ] Cliente no puede acceder a `/admin`
- [ ] Cliente no puede subir documentos ni modificar reglas
- [ ] Cliente no ve países en estado draft
- [ ] `OPENAI_API_KEY` nunca aparece en el frontend
- [ ] `DATABASE_URL` nunca aparece en el frontend
- [ ] Todos los endpoints privados validan JWT Supabase
- [ ] Rutas del Railway Volume no se exponen en ninguna respuesta de API

---

## Referencias

| Recurso | URL / Path |
|---|---|
| Especificación del proyecto | `b2brouter-calculator/docs/Proyecto Agente Calculadora Pa Einvoicing Ereporting.pdf` |
| Frontend base | `/Users/macnolo/Desktop/Code/b2brouter-calculator` |
| Patrón Auth / Netlify | `/Users/macnolo/Desktop/Code/AstroChatBot` |
| Backend API base | `/Users/macnolo/Desktop/Code/ExpressApi` |
| Agente Resumen base | `/Users/macnolo/Desktop/Code/DSPy-Assistant` |
| Guardrails base (seguridad) | `/Users/macnolo/Desktop/Code/OrchestratorIva/security/` |
| CrewAI first crew guide | https://docs.crewai.com/en/guides/crews/first-crew |
| Supabase Auth docs | https://supabase.com/docs/guides/auth |
| Railway Volumes docs | https://docs.railway.com/reference/volumes |
| Railway PostgreSQL docs | https://docs.railway.com/databases/postgresql |
| EU Copyright legislation | https://digital-strategy.ec.europa.eu/en/policies/copyright-legislation |
| DSM Directive (TDM) | Directive (EU) 2019/790, Arts. 3 and 4 |
| EU AI Act | Regulation (EU) 2024/1689, Art. 50 (transparency), Art. 53(1)(c) (copyright) |
