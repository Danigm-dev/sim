# OpenCode Custom Block

## Objetivo

Documentar el bloque `opencode` añadido a SIMAI, su arquitectura, su comportamiento esperado y cómo encaja en despliegues de Workflow como MCP server y A2A server.

## Flujo obligatorio de trabajo

En cada incidencia detectada durante la validación del bloque se seguirá este orden:

1. reproducir el problema en UI, logs o ejecución real
2. documentar primero el problema en este archivo
3. proponer la solución al usuario y pedir confirmación antes de aplicar cambios
4. aplicar el fix solo después de esa confirmación
5. documentar también la solución aplicada y el resultado de la validación

Nota:

- si por error se rompe este orden en alguna iteración, debe dejarse constancia explícita en este documento

## Estado de implementación

Se ha implementado una integración nueva de OpenCode compuesta por:

- bloque: `apps/sim/blocks/blocks/opencode.ts`
- tools:
  - `apps/sim/tools/opencode/prompt.ts`
  - `apps/sim/tools/opencode/list_repos.ts`
  - `apps/sim/tools/opencode/get_messages.ts`
- capa común:
  - `apps/sim/lib/opencode/client.ts`
  - `apps/sim/lib/opencode/service.ts`
- endpoints de builder para poblar dropdowns:
  - `apps/sim/app/api/opencode/repos/route.ts`
  - `apps/sim/app/api/opencode/providers/route.ts`
  - `apps/sim/app/api/opencode/models/route.ts`
  - `apps/sim/app/api/opencode/agents/route.ts`
- icono y registros:
  - `apps/sim/components/icons.tsx`
  - `apps/sim/blocks/registry.ts`
  - `apps/sim/tools/registry.ts`

## Qué hace el bloque

El bloque `opencode` permite que un workflow de SIMAI use el servicio interno `opencode serve` como agente experto sobre un repositorio fijo montado en `/app/repos/<repo>`.

El diseño separa:

- configuración design-time:
  - `repository`
  - `systemPrompt`
  - `providerId`
  - `modelId`
  - `agent`
- input runtime:
  - `prompt`
  - `newThread`

El repositorio no se elige en runtime. Cada workflow queda ligado a un único repo configurado en el canvas.

## Comportamiento esperado

### 1. Configuración en canvas

Cuando un creador de workflow añade el bloque:

- puede elegir un repositorio disponible en `/app/repos/`
- puede escribir el `system prompt`
- puede elegir proveedor y modelo expuestos por el servidor OpenCode
- puede elegir opcionalmente un `agent` preset de OpenCode
- puede mapear `prompt` y `newThread` desde el bloque Start o desde otros bloques

### 2. Ejecución runtime

Cuando se ejecuta el workflow y llega al bloque:

1. SIMAI inyecta `_context.userId`, `_context.workspaceId` y `_context.workflowId` en la tool.
2. La tool `opencode_prompt` resuelve la identidad del caller usando ese contexto.
3. Se busca en la tabla `memory` una sesión persistida para la clave:
   - `opencode:session:<workflowId>:<callerKey>`
4. Si `newThread = true`, no reutiliza la sesión anterior.
5. Si `newThread = false`:
   - si existe sesión guardada para ese caller y ese workflow, la reutiliza
   - si no existe, crea una nueva sesión
6. Se ejecuta `client.session.prompt(...)` contra OpenCode con:
   - `directory = /app/repos/<repository>`
   - `parts = [{ type: "text", text: prompt }]`
   - `system = systemPrompt` si existe
   - `model = { providerID, modelID }`
   - `agent = agent` si existe
7. Se guarda o actualiza el mapeo caller -> sessionId en `memory`.
8. Se devuelve:
   - `content`
   - `threadId`
   - `cost`
   - `error`

### 3. Continuidad conversacional

El comportamiento esperado es:

- el mismo caller autenticado vuelve al mismo hilo de OpenCode en llamadas sucesivas al mismo workflow
- `newThread: true` fuerza un hilo nuevo
- si una sesión persistida ya no existe en OpenCode, la tool intenta recrearla y reintentar una vez

## Despliegue como MCP y A2A

### Regla importante

Este bloque no necesita un flag especial de “deployable as MCP” o “deployable as A2A”.

En SIMAI, la elegibilidad para MCP y A2A depende del workflow, no del bloque individual. Lo que hace elegible al workflow es el patrón normal de Start/Input block y la lógica de deployment existente en SIMAI.

### Qué se espera al desplegar

Si un workflow contiene:

- un bloque Start válido con inputs públicos
- el bloque `opencode`
- y opcionalmente un bloque Response

entonces ese workflow debe poder:

- desplegarse como MCP server desde Workflow Deployment
- desplegarse como A2A server desde Workflow Deployment

### Schema recomendado del Start block para MCP/A2A

Para exponer este caso de uso a clientes externos, el workflow debería publicar estos inputs en Start:

- `prompt: string` requerido
- `new_thread: boolean` opcional

Después se mapean a:

- `opencode.prompt <- <start.prompt>`
- `opencode.newThread <- <start.new_thread>`

## Comportamiento esperado desde clientes MCP

Caso de uso esperado:

1. Un developer configura un MCP server que apunta al workflow desplegado en SIMAI.
2. Desde OpenCode, Codex, Claude Desktop o cualquier cliente MCP compatible, invoca el tool publicado por el workflow.
3. El caller envía `prompt` y opcionalmente `new_thread`.
4. El workflow ejecuta el bloque `opencode` contra el repo fijo configurado.
5. El caller recibe la respuesta del agente experto sobre ese repositorio.
6. Una segunda llamada del mismo caller continúa la conversación anterior salvo que fuerce `new_thread`.

## Qué puede hacer esta V1

- trabajar contra un repo fijo por workflow
- aplicar un system prompt fijo por workflow
- elegir proveedor y modelo de OpenCode
- elegir opcionalmente un preset `agent`
- continuar conversaciones por caller autenticado
- listar repos disponibles para configuración
- recuperar mensajes de una sesión para debug o futuras ampliaciones

## Qué no hace esta V1

- no hace streaming ni SSE
- no expone el repo como parámetro runtime
- no expone el `systemPrompt` como parámetro runtime
- no implementa abort, fork, share o revert
- no implementa una tabla nueva; reutiliza `memory`
- no implementa skills runtime nativas más allá de lo que soporte OpenCode vía `system` o `agent`
- no usa campos no verificados del SDK como `noReply`

## Persistencia elegida

La persistencia de `caller -> sessionId` se hace en la tabla `memory` de SIMAI.

Motivo:

- evita migraciones nuevas
- ya existe en la arquitectura de ejecución
- encaja bien para guardar un pequeño mapping por workflow y caller

Payload persistido:

- `sessionId`
- `repository`
- `updatedAt`

## Endpoints internos del builder

Estos endpoints solo existen para poblar opciones en el canvas:

- `/api/opencode/repos`
- `/api/opencode/providers`
- `/api/opencode/models`
- `/api/opencode/agents`

Todos requieren auth de sesión o token interno y validan acceso al workspace.

## Validación realizada

Se ha validado:

- `cd apps/sim && ../../node_modules/.bin/tsc --noEmit`
- `cd apps/sim && bunx biome check lib/opencode/service.ts tools/opencode/prompt.ts scripts/validate-opencode-mcp.ts vitest.config.ts`
- `cd apps/sim && bunx vitest --run blocks/blocks.test.ts`

Nota:

- `bun run type-check` no se usó como señal final de validación de esta iteración porque en el sandbox quedó colgado sin devolver resultado, mientras que `tsc --noEmit` sí terminó correctamente
- en una validación posterior, `bun run type-check` sí terminó correctamente
- en una validación posterior, `bun run build` dejó de reproducir el fallo temprano de bundling ligado a `tls` y `node:child_process`, aunque la build completa no terminó dentro del timeout del sandbox
- en validación real con Docker, `docker compose -f docker-compose.local.yml build --no-cache simstudio` terminó correctamente
- ese resultado confirmó que la build que seguía fallando estaba consumiendo un estado anterior o cacheado, no el árbol actual tras mover la ejecución de OpenCode a rutas server-only

## Ajustes posteriores a la review

Tras la review del bloque OpenCode se aplicaron correcciones sobre runtime, validación y test harness.

### Build y bundling

- se corrigió una contaminación de imports server-only en las tools `opencode_prompt`, `opencode_get_messages` y `opencode_list_repos`
- `tools/registry.ts` se consume también desde rutas que terminan en contexto cliente para validación y UI
- las tools de OpenCode importaban `@/lib/opencode/service` en el tope del módulo
- esa cadena arrastraba `@sim/db`, `postgres`, `tls` y otras dependencias de Node no válidas para bundle cliente
- el resultado era un fallo de build de Next/Turbopack con errores sobre `tls` y `node:child_process`
- un primer intento con `await import(...)` dentro de `directExecution` no fue suficiente con Turbopack porque seguía intentando chunkear la referencia alcanzable desde cliente
- la solución final fue eliminar `directExecution` de las tools `opencode_*`
- la ejecución real se movió a rutas server-only:
  - `apps/sim/app/api/tools/opencode/prompt/route.ts`
  - `apps/sim/app/api/tools/opencode/messages/route.ts`
  - `apps/sim/app/api/tools/opencode/repos/route.ts`
- las definitions de tool quedaron como metadata + request HTTP interno hacia `/api/tools/opencode/*`
- con ese ajuste, la metadata de la tool sigue disponible para registro, builder y validación sin arrastrar runtime server-only al bundle cliente
- toda la lógica que toca `@/lib/opencode/service`, `@sim/db` y el SDK queda confinada al servidor

### Estabilidad del editor

- al interactuar con el bloque en el canvas apareció un error cliente `Cannot read properties of undefined (reading 'map')`
- la causa no estaba en OpenCode ni en los endpoints, sino en los componentes base `Dropdown` y `ComboBox`
- ambos asumían que `options` siempre estaba definido, pero el bloque `opencode` usa subblocks con `fetchOptions` asíncrono y sin opciones estáticas iniciales
- eso hacía que el editor intentara ejecutar `.map()` o `.filter()` sobre `undefined` antes de que llegaran las opciones remotas
- se corrigió el comportamiento base para tratar `options` ausente como `[]`
- además, el bloque `opencode` declara ahora `options: []` explícito en los subblocks dinámicos `repository`, `providerId`, `modelId` y `agent`

### Resolución del SDK en desarrollo local

- en `next dev` apareció un build error `Module not found: Can't resolve '@opencode-ai/sdk'`
- la dependencia sí estaba instalada y resolvía correctamente en Node, así que no era un problema de instalación ni de `bun.lock`
- la causa era específica de Next/Turbopack en desarrollo: el paquete publicado de `@opencode-ai/sdk` expone una condición `development` que apunta a `./src/index.ts`, pero el artefacto instalado solo contiene `dist/`
- el repo ya tenía un workaround equivalente en `vitest.config.ts`
- se replicó esa estrategia en `apps/sim/next.config.ts`, forzando alias de `@opencode-ai/sdk` hacia `../../node_modules/@opencode-ai/sdk/dist/index.js`
- en una iteración posterior apareció un `500` en bucle sobre `GET /api/opencode/repos` durante compilación de app routes
- la causa ya no era la ausencia del paquete sino la forma del alias en Turbopack:
  - `webpack` toleraba alias absoluto al fichero real en `node_modules`
  - `turbopack.resolveAlias` terminaba resolviendo ese valor como import relativo inválido dentro del proyecto y emitía `server relative imports are not implemented yet`
- la corrección final en `apps/sim/next.config.ts` separa ambos casos:
  - `webpack` mantiene alias absoluto al fichero `dist/index.js`
  - `turbopack.resolveAlias` usa la ruta relativa al proyecto `../../node_modules/@opencode-ai/sdk/dist/index.js`
- con ese ajuste, las rutas `apps/sim/app/api/opencode/*` y `apps/sim/app/api/tools/opencode/*` vuelven a compilar sin el `module-not-found` ligado al SDK

### Metadata del bloque

- se alineó la metadata de `apps/sim/blocks/blocks/opencode.ts` con las convenciones del repo
- el bloque pasó de `category: 'blocks'` a `category: 'tools'`
- se añadió `docsLink: 'https://docs.sim.ai/tools/opencode'`
- este ajuste evita que OpenCode aparezca clasificado como bloque core/genérico en lugar de integración de herramienta

### Seguridad de repositorio

- se cerró un riesgo de path traversal en la resolución de `repository`
- ya no se acepta un path arbitrario para construir `directory`
- el runtime resuelve el repositorio exclusivamente contra la lista real de proyectos devuelta por OpenCode
- los endpoints del builder para providers, models y agents reutilizan esa validación

### Comportamiento runtime

- se ajustó la tool `opencode_prompt` para que los errores funcionales del asistente viajen en `output.error` sin convertir automáticamente el bloque en un fallo duro del workflow
- se normalizó el repositorio antes de reutilizar o persistir sesiones
- el mapping `workflow + caller + repo -> sessionId` usa ahora un identificador canónico del repo

### Script de validación MCP

- se corrigió `apps/sim/scripts/validate-opencode-mcp.ts`
- el script volvió a compilar
- se ajustó el tipado de `inputFormat`
- se eliminó un acceso inseguro a un tool MCP posiblemente `undefined`

### Suite de tests

- se añadió un ajuste de resolución en `apps/sim/vitest.config.ts`
- con ese cambio, Vitest pudo cargar `@opencode-ai/sdk` correctamente en la suite estructural de bloques

## Resultado funcional esperado

Resultado esperado a nivel producto:

- un usuario de SIMAI puede crear un workflow experto sobre un repo concreto
- ese workflow puede desplegarse como MCP y A2A usando la infraestructura ya existente
- un caller externo autenticado puede consultar ese workflow como agente experto del repositorio
- las conversaciones pueden mantenerse entre llamadas del mismo caller

## Siguiente validación recomendada

Pendiente de verificación manual real:

- crear un workflow mínimo `Start -> OpenCode -> Response`
- desplegarlo como MCP
- llamarlo desde un cliente MCP real con `prompt`
- confirmar continuidad de hilo
- repetir con `new_thread: true`
- repetir el mismo flujo en despliegue A2A

## Validación manual en UI - 2026-03-20

### Fallo reproducido

- en `next dev` local, al seleccionar el bloque `OpenCode` y abrir el dropdown `Repository`, la UI entra en un bucle de peticiones
- el endpoint `GET /api/opencode/repos?workspaceId=...` devuelve `500`
- el dropdown queda vacío y bloquea toda la configuración posterior del bloque

### Evidencia observada

- en navegador:
  - múltiples `Failed to load resource: the server responded with a status of 500`
  - más de un centenar de requests repetidas a `/api/opencode/repos`
- en backend expuesto a la UI:
  - la route responde `{"error":"Failed to fetch repositories"}`
- en Docker:
  - `sim-opencode-1` está `healthy`
  - el contenedor registra `opencode server listening on http://0.0.0.0:4096`
  - el alias `opencode` existe solo dentro de la red Docker `sim_default`

### Causa raíz confirmada

El cliente server-side de OpenCode en `apps/sim/lib/opencode/client.ts` usa por defecto `http://opencode:4096`.

Eso funciona cuando SIM corre dentro de Docker en la misma red que el servicio `opencode`, pero falla en el flujo actual de desarrollo local:

- la UI está sirviendo en `http://localhost:3000` desde `next dev` en host
- el hostname `opencode` no resuelve fuera de Docker
- además `docker-compose.local.yml` usa `expose: ['4096']` y no publica el puerto al host

Resultado:

- el proceso local de Next no puede alcanzar OpenCode ni por hostname Docker ni por `localhost:4096`
- las routes `/api/opencode/*` fallan con `500`
- el bloque queda inutilizable en la UI local aunque el contenedor OpenCode esté sano

### Solución propuesta pendiente de decisión

Hay dos caminos válidos:

1. exponer `4096` solo en `docker-compose.local.yml` y hacer configurable la base URL del cliente OpenCode para desarrollo local
2. mantener OpenCode completamente interno y exigir que SIM local corra también dentro de Docker o en una red que pueda resolver `opencode`

La opción 1 mejora mucho el DX para `next dev`, pero rompe parcialmente la decisión inicial de no publicar puertos, aunque solo en entorno local.
La opción 2 conserva el aislamiento original, pero deja roto el caso de uso actual de UI local con hot reload.

### Solución aplicada

Se implementó la opción local-first sin cambiar el contrato de producción:

- `apps/sim/lib/opencode/client.ts`
  - soporta `OPENCODE_BASE_URL` como override explícito
  - si no existe override:
    - dentro de Docker usa `http://opencode:${OPENCODE_PORT}`
    - fuera de Docker usa `http://127.0.0.1:${OPENCODE_PORT}`
- `docker-compose.local.yml`
  - publica `OPENCODE_PORT` al host para que `next dev` local pueda alcanzar el servicio
- `apps/sim/.env.example`
  - documenta `OPENCODE_BASE_URL` para desarrollo local fuera de Docker

Con esto:

- producción puede seguir usando el alias interno `opencode`
- desarrollo local con UI en host puede replicar el flujo real contra el mismo contenedor OpenCode

## Validación manual en UI - 2026-03-20 (segunda iteración)

### Fallo reproducido

- el bloque `OpenCode` sigue fallando al abrir `Repository`
- el endpoint `GET /api/opencode/repos?workspaceId=...` continúa devolviendo `500`
- además el dropdown genera una tormenta de reintentos mientras permanece abierto

### Hallazgos confirmados

- `apps/sim/.env` sí contiene las variables necesarias para la app host:
  - `OPENCODE_BASE_URL`
  - `OPENCODE_PORT`
  - `OPENCODE_SERVER_USERNAME`
  - `OPENCODE_SERVER_PASSWORD`
  - `OPENCODE_REPOS`
  - credenciales Git y provider key
- por tanto, el fallo ya no parece ser “faltan variables en Next”

### Causa raíz más probable

Hay una alta probabilidad de desalineación entre la configuración del host y la del contenedor `opencode`:

- la app host lee `OPENCODE_SERVER_PASSWORD` desde `apps/sim/.env`
- el contenedor `opencode` toma `OPENCODE_SERVER_PASSWORD` desde el entorno del `docker compose up`
- si el contenedor se levantó sin exportar la misma contraseña, OpenCode arranca con el default del compose local o con otro valor distinto
- en ese escenario, la app llega al servicio pero autentica con credenciales distintas
- el SDK lanza error, la route `/api/opencode/repos` lo captura y responde `500`

### Problema adicional de UX detectado

Aunque el backend esté mal configurado, el editor no debería disparar decenas de requests fallidas al abrir el dropdown.

El comportamiento actual sugiere que `Dropdown` reintenta `fetchOptions` demasiadas veces en estado de error abierto.

### Solución propuesta pendiente

1. alinear explícitamente la contraseña de `apps/sim/.env` y la usada al arrancar `opencode`
2. añadir una protección en `Dropdown` para que un fallo de `fetchOptions` no cause un bucle de reintentos mientras el popover siga abierto

### Solución aplicada

Se corrigió el comportamiento base de fetch asíncrono en:

- `apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/dropdown/dropdown.tsx`
- `apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/combobox/combobox.tsx`

Cambios:

- un fetch en curso ya no puede duplicarse por carreras entre `useEffect` y `onOpenChange`
- un fetch fallido marca el intento como realizado y evita reintentos en bucle
- al cambiar dependencias (`dependsOn`) se resetea el estado y se permite un nuevo fetch

Resultado verificado en UI:

- antes: decenas de `GET /api/opencode/repos` con `500`
- después: un único `GET /api/opencode/repos` con `500` al abrir el dropdown

### Bloqueo pendiente

El fallo funcional de backend sigue existiendo:

- `GET /api/opencode/repos?workspaceId=...` continúa devolviendo `500`
- con las variables presentes en `apps/sim/.env`, la hipótesis principal sigue siendo desalineación de credenciales reales entre la app host y el contenedor `opencode`

## Validación manual en UI - 2026-03-20 (tercera iteración)

### Objetivo

Hacer visible en UI la causa real del fallo restante, en vez de dejar un `500` genérico en el dropdown.

### Solución aplicada

Se añadió clasificación de errores OpenCode en:

- `apps/sim/lib/opencode/errors.ts`

Y se conectó a las rutas del builder:

- `apps/sim/app/api/opencode/repos/route.ts`
- `apps/sim/app/api/opencode/providers/route.ts`
- `apps/sim/app/api/opencode/models/route.ts`
- `apps/sim/app/api/opencode/agents/route.ts`

Además, el bloque dejó de convertir cualquier respuesta fallida en lista vacía:

- `apps/sim/blocks/blocks/opencode.ts`

Ahora:

- errores de auth upstream devuelven `502`
- errores de conectividad devuelven `503`
- errores de validación local como repo inválido devuelven `400`
- el texto `error` del backend se propaga al dropdown/combobox del editor

### Validación real con Chrome MCP

Petición ejecutada desde la sesión autenticada del navegador:

- `GET /api/opencode/repos?workspaceId=81a8bc6b-1965-4489-9baf-49131b21a4ed`

Resultado:

- status: `502`
- body:
  - `OpenCode authentication failed. Align OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD with the running OpenCode server.`

Comprobación visual:

- al abrir `Repository`, el listbox muestra ese mismo mensaje
- ya no hay tormenta de requests
- el fallo quedó diagnosticable directamente desde UI

### Consejo para la siguiente prueba

El siguiente paso ya no es un fix de frontend:

- hay que alinear la credencial efectiva usada por el servicio `opencode` con la que está leyendo la app host
- en la práctica, el `OPENCODE_SERVER_PASSWORD` con el que se arrancó el contenedor debe coincidir con el de `apps/sim/.env`

Cuando esa alineación esté hecha, la siguiente prueba debería ser:

1. abrir `Repository`
2. confirmar que lista repos
3. validar cascada completa:
   - `Model Provider`
   - `Model ID`
   - `Agent`

## Validación manual en UI - 2026-03-20 (cuarta iteración)

### Fallo reproducido

Con `Repository`, `Model Provider`, `Model ID` y `Agent` ya resolviendo correctamente en UI, la ejecución manual del workflow falló al lanzar el bloque `OpenCode`.

Error observado en la respuesta SSE de:

- `POST /api/workflows/<workflowId>/execute`

Detalle:

- `Expected string, received null`
- path:
  - `systemPrompt`

## Validación manual en UI - 2026-03-20 (system prompt y agent)

### Objetivo

Confirmar que `systemPrompt` y `agent` no solo aparecen en el builder, sino que llegan realmente a OpenCode y afectan a la ejecución.

### Validación realizada

Primera comprobación con el bloque configurado con:

- `repository = tp-ai-hackathon`
- `providerId = google`
- `modelId = gemini-2.5-flash`
- `agent = compaction`
- `systemPrompt = Responde exactamente con SYS_OK y nada mas.`
- `prompt = Describe este repositorio en una frase.`
- `newThread = true`

Resultado visible en UI:

- el bloque respondió con una descripción del repo terminada en `SYS_OK`
- `threadId = ses_2f4366afeffeRtJ6qUwsdMem8d`

Verificación raw contra OpenCode:

- `GET /session/ses_2f4366afeffeRtJ6qUwsdMem8d/message?directory=/app/repos/tp-ai-hackathon`

Evidencia confirmada:

- el mensaje `user` contiene `info.system = "Responde exactamente con SYS_OK y nada mas."`
- el mensaje `user` contiene `info.agent = "build"`
- los mensajes `assistant` también registran `info.agent = "build"`
- la sesión quedó anclada a `path.root = /app/repos/tp-ai-hackathon`

Conclusión de esa prueba:

- `systemPrompt` llega correctamente a OpenCode
- el agent preset también llega correctamente
- con ese modelo/agente, el `systemPrompt` influye en la salida pero no actúa como restricción dura exacta

### Segunda comprobación controlada

Se repitió la prueba forzando valores únicos en la propia UI del bloque:

- `agent = compaction`
- `systemPrompt = Termina la respuesta exactamente con TOKEN_SYS_AGENT_20260320.`
- `prompt = Lee el README principal y resume el repositorio en una sola frase.`
- `newThread = true`

Resultado visible en UI:

- respuesta:
  - `This repository contains a multi-agent incident analysis service built with FastAPI and Google Vertex AI, featuring a backend API and a static frontend, designed to be deployed with Docker.`
  - `TOKEN_SYS_AGENT_20260320`
- `threadId = ses_2f43204ebffeEMfrpaMkQA2ROZ`

Verificación raw contra OpenCode:

- `GET /session/ses_2f43204ebffeEMfrpaMkQA2ROZ/message?directory=/app/repos/tp-ai-hackathon`

Evidencia confirmada:

- el mensaje `user` contiene `info.system = "Termina la respuesta exactamente con TOKEN_SYS_AGENT_20260320."`
- el mensaje `user` contiene `info.agent = "compaction"`
- el mensaje `user` contiene exactamente el prompt `Lee el README principal y resume el repositorio en una sola frase.`
- los mensajes `assistant` registran `info.agent = "compaction"`
- los mensajes `assistant` usan `path.root = /app/repos/tp-ai-hackathon`
- la respuesta final incluye el token `TOKEN_SYS_AGENT_20260320`

### Logs del servidor OpenCode

Última comprobación de logs:

- `Already up to date.`
- `[opencode-sync] Updated tp-ai-hackathon`
- `opencode server listening on http://0.0.0.0:4096`

### Resultado

Queda validado que en la implementación actual:

- `systemPrompt` se persiste y se envía a OpenCode
- `agent` se envía a OpenCode y queda registrado en la sesión
- `prompt` se envía con el contenido configurado en el bloque
- el repositorio efectivo usado por la sesión es `tp-ai-hackathon`

No se detectó un fallo nuevo de wiring en esta validación. El único matiz funcional observado es de comportamiento del modelo/agente:

- el `systemPrompt` se respeta e influye en la respuesta
- no debe asumirse que fuerce obediencia literal perfecta en todos los casos

## Revisión de impacto y fixes posteriores - 2026-03-20

### Hallazgo 1: typecheck roto en el bloque OpenCode

Durante una revisión posterior del alcance real contra `plan.md` y los cambios del repo, apareció un error de compilación en:

- `apps/sim/blocks/blocks/opencode.ts`

Síntoma:

- `tsc --noEmit` fallaba con:
  - `'result' is possibly 'null'`

Causa:

- `fetchOpenCodeOptions()` parsea `response.json()` con fallback a `null`
- después accedía a `result.data` sin null-check completo

Solución aplicada:

- se cambió el acceso a `result?.data`

Resultado:

- el bloque mantiene el mismo comportamiento funcional
- el typecheck vuelve a pasar

### Hallazgo 2: reintento manual bloqueado en Dropdown y ComboBox

La corrección anterior contra la tormenta de requests en subblocks asíncronos había resuelto el bucle, pero introdujo un efecto secundario en componentes compartidos:

- `apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/dropdown/dropdown.tsx`
- `apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/combobox/combobox.tsx`

Síntoma:

- tras un fallo inicial de `fetchOptions`, el selector quedaba marcado como “ya intentado”
- si el subblock no tenía `dependsOn`, reabrir el popover no disparaba ningún nuevo intento

Riesgo:

- esto ya no afectaba solo a OpenCode
- podía impactar cualquier bloque con opciones asíncronas y un fallo transitorio de red o backend

Solución aplicada:

- se mantiene un único intento automático por ciclo de dependencias para evitar bucles
- al reabrir manualmente el dropdown/combobox:
  - si no hay opciones cargadas
  - y existe `fetchError`
  - se permite un reintento explícito
- si ya hay opciones cargadas, no se refetch al abrir

Resultado:

- sigue eliminada la tormenta de requests
- vuelve a ser posible reintentar manualmente sin cambiar dependencias
- el fix queda acotado a la lógica de fetch asíncrono de los selectores, sin tocar serialización ni ejecución de workflows

### Verificación posterior al fix

Se volvió a ejecutar:

- `cd apps/sim && ../../node_modules/.bin/tsc --noEmit`
- `cd apps/sim && bunx vitest --run blocks/blocks.test.ts`

Resultado:

- `tsc --noEmit`: OK
- `blocks/blocks.test.ts`: OK

### Conclusión de la revisión

Tras estos dos ajustes, no queda detectado en esta iteración un cambio transversal claramente dañino fuera del alcance buscado.

Persisten solo riesgos menores ya conocidos:

- el selector de modelos aún puede exponer modelos históricos que luego fallen en runtime
- el `systemPrompt` no garantiza obediencia literal perfecta del modelo, aunque sí se verifica que se envía y se aplica

### Causa raíz

El bloque serializaba `systemPrompt: null` cuando el campo estaba vacío en el editor.

La route del tool:

- `apps/sim/app/api/tools/opencode/prompt/route.ts`

validaba `systemPrompt` como `z.string().optional()`, que acepta `undefined` pero no `null`.

### Solución aplicada

Se corrigió en dos capas:

- `apps/sim/blocks/blocks/opencode.ts`
  - ahora normaliza strings opcionales y no manda `systemPrompt` ni `agent` si vienen vacíos o nulos
- `apps/sim/app/api/tools/opencode/prompt/route.ts`
  - ahora tolera `null` para strings opcionales y lo normaliza a `undefined`

### Resultado

El error de validación por `systemPrompt: null` dejó de reproducirse.

## Validación manual en UI - 2026-03-20 (quinta iteración)

### Fallo reproducido

Tras arreglar `systemPrompt`, la siguiente ejecución falló con:

- `Google Generative AI API key is missing. Pass it using the 'apiKey' parameter or the GOOGLE_GENERATIVE_AI_API_KEY environment variable.`

El bloque estaba configurado con:

- provider: `google`
- model: `gemini-1.5-flash`

### Causa raíz

El setup de `opencode` estaba propagando:

- `GEMINI_API_KEY`

pero el provider `google` usado por OpenCode necesita:

- `GOOGLE_GENERATIVE_AI_API_KEY`

Por tanto:

- el builder podía listar providers/models
- pero la ejecución real del prompt fallaba al no tener la variable que consume el runtime del provider

### Solución aplicada

Se dejó el fix preparado para local y producción:

- `docker-compose.local.yml`
- `docker-compose.prod.yml`
  - ahora propagan también `GOOGLE_GENERATIVE_AI_API_KEY`, con fallback desde `GEMINI_API_KEY`
- `docker/opencode/entrypoint.sh`
  - ahora exporta `GOOGLE_GENERATIVE_AI_API_KEY` desde `GEMINI_API_KEY` si la primera no existe
  - también incluye ambas variables en el runtime env del contenedor
- `apps/sim/.env.example`
  - documenta `GOOGLE_GENERATIVE_AI_API_KEY`

### Importante

Este fix requiere recrear `opencode`, porque cambia:

- compose del servicio
- entrypoint de la imagen

### Siguiente prueba esperada

Después de recrear `opencode`, la siguiente validación debe ser:

1. ejecutar el workflow de nuevo
2. confirmar que ya no falla por:
   - `systemPrompt: null`
   - `GOOGLE_GENERATIVE_AI_API_KEY`
3. observar la primera respuesta real del agente OpenCode

## Validación manual en UI - 2026-03-20 (sexta iteración)

### Fallo reproducido

Con el bloque ya renderizando y ejecutando, seguía habiendo una inconsistencia funcional en configuración:

- el dropdown `Repository` mostraba `sim`
- pero el repo configurado para clonado era:
  - `https://dev.azure.com/thinkproject/AI%20Projects/_git/tp-ai-hackathon`

### Evidencia observada

- en UI autenticada:
  - `GET /api/opencode/repos?workspaceId=81a8bc6b-1965-4489-9baf-49131b21a4ed`
  - respuesta: solo `sim`
- en logs del contenedor:
  - `[opencode-sync] Updated tp-ai-hackathon`
- en el contenedor:
  - `/app/repos/tp-ai-hackathon` existía realmente
- en OpenCode:
  - `GET /project` seguía devolviendo solo `/app/repos/sim`
- pero OpenCode sí aceptaba consultas directas contra:
  - `/app/repos/tp-ai-hackathon`

### Causa raíz

La lista del bloque dependía de `client.project.list()` en:

- `apps/sim/lib/opencode/service.ts`

Ese endpoint no reflejaba los repos declarados en `OPENCODE_REPOS`, sino solo los proyectos persistidos en el estado interno de OpenCode.

Resultado:

- el builder enseñaba un repo obsoleto
- el repo correcto existía y era usable por `directory`
- pero nunca aparecía en el catálogo del bloque

### Solución aplicada

Se cambió la resolución de repositorios en:

- `apps/sim/lib/opencode/service.ts`

Nuevo criterio:

1. si `OPENCODE_REPOS` está definido, esa es la fuente de verdad del catálogo
2. `project.list()` se usa solo para enriquecer con `projectId` cuando ya existe un registro interno
3. si `OPENCODE_REPOS` no está definido, se mantiene el fallback anterior a `project.list()`

Detalles:

- se parsean URLs GitHub y Azure Repos
- se deriva el nombre canónico desde el último segmento de la URL
- se elimina sufijo `.git` cuando aplica
- si hay colisiones de basename en `OPENCODE_REPOS`, se ignoran duplicados con log

Se actualizó además:

- `apps/sim/tools/opencode/list_repos.ts`

para aclarar que `projectId` puede ser un fallback configurado y no necesariamente un ID persistido por OpenCode.

### Nota de proceso

En esta iteración no se pidió confirmación separada antes del fix.

Se deja constancia porque este documento define ese orden como preferente, pero el cambio se aplicó bajo la instrucción global activa del usuario de seguir validando y corrigiendo en caliente.

### Resultado verificado tras hot reload

Validación hecha con Chrome MCP y sesión autenticada del builder:

- `GET /api/opencode/repos?workspaceId=81a8bc6b-1965-4489-9baf-49131b21a4ed`
  - ahora devuelve:
    - `tp-ai-hackathon`
  - ya no devuelve:
    - `sim`
- al reabrir el bloque ya guardado con `repository=sim`:
  - el selector `Repository` invalida ese valor antiguo
  - el panel muestra placeholder `Select a repository` en lugar de conservar `sim` como opción válida
- el popup del selector contiene `tp-ai-hackathon`

Observación menor:

- tras invalidarse el repo viejo, `provider` se limpia correctamente
- `modelId` puede seguir mostrando visualmente el valor anterior hasta que se vuelva a seleccionar repo/provider
- no bloquea la corrección principal del catálogo, pero conviene revisar esa limpieza de dependencias si queremos dejar la UX completamente consistente

## Validación manual en UI - 2026-03-20 (séptima iteración)

### Objetivo

Revalidar la ejecución real del bloque tras recrear el contenedor `opencode` con el entrypoint y el compose actualizados.

### Verificación de infraestructura

Se recreó localmente el servicio:

- `docker compose -f docker-compose.local.yml up -d --build opencode`

Comprobaciones posteriores:

- el contenedor quedó `healthy`
- `env` dentro del contenedor expone:
  - `GEMINI_API_KEY`
  - `GOOGLE_GENERATIVE_AI_API_KEY`
  - `OPENCODE_REPOS`
- el builder siguió resolviendo:
  - `Repository = tp-ai-hackathon`

### Resultado

El error anterior desapareció:

- ya no se reproduce:
  - `Google Generative AI API key is missing`

Eso confirma que el problema previo sí estaba en el runtime efectivo del contenedor y quedó resuelto al recrearlo con la imagen y entrypoint actuales.

## Validación manual en UI - 2026-03-20 (octava iteración)

### Nuevo fallo reproducido

Con el runtime ya corregido, la primera ejecución real del bloque falló con:

- `models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent`

### Causa observada

El workflow estaba intentando ejecutar con:

- provider: `google`
- model: `gemini-1.5-flash`

Ese modelo dejó de ser válido para esta llamada concreta del provider en OpenCode/Google, aunque siguiera apareciendo como opción histórica en el selector.

### Acción tomada

Se actualizó la configuración del bloque en UI a:

- `modelId = gemini-2.5-flash`

No se aplicó fix de código en esta iteración porque el bloqueo no estaba ya en el runtime del bloque sino en la selección concreta del modelo configurado en el workflow.

## Validación manual en UI - 2026-03-20 (novena iteración)

### Ejecución exitosa

Con:

- `repository = tp-ai-hackathon`
- `provider = google`
- `modelId = gemini-2.5-flash`
- `newThread = false`

la ejecución del bloque terminó correctamente.

Salida observada en terminal:

- `content`:
  - `This repository contains a multi-agent incident analysis service built with FastAPI and Google Vertex AI. It includes a backend API and a static frontend UI served by the same FastAPI application.`
- `threadId`:
  - `ses_2f43c43b3ffeK7F3Sl3BgQxIzV`
- `cost`:
  - `0.0023645`

Esto valida que:

- el bloque llega a OpenCode
- el repo correcto se usa en runtime
- el provider ya tiene credenciales efectivas
- el prompt devuelve contenido real del repo

## Validación manual en UI - 2026-03-20 (décima iteración)

### Validación de continuidad de hilo

Se repitió la ejecución con:

- `newThread = false`
- prompt:
  - `What did I just ask you to describe?`

Resultado:

- `content`:
  - `You asked me to describe what this repository is for.`
- `threadId`:
  - `ses_2f43c43b3ffeK7F3Sl3BgQxIzV`

Conclusión:

- el `threadId` se reutilizó
- la respuesta demuestra memoria conversacional del turno anterior
- la continuidad de sesión del bloque quedó validada en UI

## Riesgo residual observado

Queda una mejora potencial de producto:

- el selector de modelos todavía permite escoger modelos históricos como `gemini-1.5-flash` que ya no son válidos para esta ejecución concreta

No bloquea el funcionamiento del bloque porque con `gemini-2.5-flash` funciona correctamente, pero sería razonable decidir más adelante si:

1. se filtran esos modelos en el catálogo del builder
2. o se deja el catálogo tal como lo devuelve OpenCode y se documenta qué modelos están recomendados
