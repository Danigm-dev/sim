  ## OpenCode interno en SIMAI (infraestructura Docker, persistencia y multi-repo)

  ### Resumen

  - Añadir un servicio interno opencode accesible solo dentro de la red Docker de SIMAI, sin exponer puertos al exterior.
  - Mantener sesiones y storage de OpenCode en un volumen persistente, y repos clonados en otro volumen dedicado.
  - Dejar la infraestructura lista para un bloque futuro que use @opencode-ai/sdk, sin tocar bloques, tools, endpoints ni
    lógica de ejecución de SIMAI.

  ### Cambios de implementación

  - Contenedor OpenCode
      - Crear docker/opencode.Dockerfile con una base Node 22 Debian slim, siguiendo el patrón actual de CA corporativa y
        utilidades del repo.
      - Instalar opencode-ai globalmente con npm, además de git, cron, curl y certificados.
      - Crear usuario no root opencode.
      - Crear y usar estos directorios:
          - /app/repos para repos sincronizados
          - /home/opencode/.config/opencode para config global
          - /home/opencode/.local/share/opencode para datos persistentes
      - Fijar HOME=/home/opencode.
      - Usar WORKDIR /app o /home/opencode, no /app/repos, para dejar claro que opencode serve no depende del cwd y que el
        repo se seleccionará por directory.
  - Entrypoint y sync de repos
      - Crear un script de sync reutilizable llamado por el entrypoint y por cron.
      - Leer OPENCODE_REPOS como lista separada por comas.
      - Para cada repo:
          - derivar el basename sin .git
          - detectar colisiones de nombre y omitir duplicados con log claro
          - si existe /app/repos/<nombre>/.git, ejecutar git pull --ff-only
          - si no existe, ejecutar git clone
      - Manejo de errores:
          - si clone o pull falla por URL inválida, credenciales, red o divergencia, registrar el error y continuar con el
            siguiente repo
          - el contenedor no debe fallar por un repo individual
      - Si OPENCODE_REPOS está vacío o no definido, arrancar normalmente sin repos.
      - Configurar cron cada 15 minutos para reintentar sync.
      - Soportar repos privados siguiendo este orden:
          - GIT_USERNAME + GIT_TOKEN para HTTPS genérico
          - GITHUB_TOKEN como fallback para GitHub
      - No persistir credenciales en remotes ni en archivos bajo /app/repos.
  - Configuración global de OpenCode
      - Crear ~/.config/opencode/opencode.json como config global.
      - Configurar server.port y server.hostname para el servicio.
      - Configurar permisos read-only con este criterio:
          - permitir explícitamente read, grep, glob, list
          - denegar edit, bash, webfetch, task, todowrite, websearch, codesearch
          - usar permission."*": "deny" como default de seguridad para acciones no especificadas, condicionado a validación
            funcional obligatoria antes de aceptar el despliegue
      - Si en verificación real * bloquea indebidamente las acciones permitidas, fallback explícito:
          - eliminar *
          - mantener deny por herramienta conocida y dejar documentado el riesgo de tools futuras
      - Permitir que cada repo tenga su propio AGENTS.md y opencode.json.
  - Compose y publicación
      - Añadir opencode a docker-compose.local.yml con build: sobre el Dockerfile nuevo.
      - Añadir opencode a docker-compose.prod.yml siguiendo la convención actual de imágenes publicadas.
      - No fijar rígidamente el nombre de imagen a un namespace único en el diseño:
          - usar la convención actual del repo por defecto
          - dejar el nombre de imagen parametrizable para forks o registries corporativos
          - ejemplo: ${OPENCODE_IMAGE:-ghcr.io/simstudioai/opencode:latest}
      - Añadir volúmenes:
          - opencode_repos para /app/repos
          - opencode_data para /home/opencode/.local/share/opencode
      - No publicar ports; opcionalmente usar expose: ["4096"].
      - Añadir healthcheck autenticado contra /global/health.
      - Añadir variables de entorno del servicio:
          - OPENCODE_IMAGE si se parametriza la imagen
          - OPENCODE_PORT
          - OPENCODE_SERVER_USERNAME
          - OPENCODE_SERVER_PASSWORD
          - OPENCODE_REPOS
          - GIT_USERNAME
          - GIT_TOKEN
          - GITHUB_TOKEN
          - al menos una API key de proveedor compatible con OpenCode
      - Ampliar CI de imágenes si este repo realmente publica imágenes para producción desde aquí.
      - Si el despliegue corporativo usa otro registry distinto al que aparece en el repo, ajustar el workflow a ese destino
        en vez de asumir ghcr.io/simstudioai.
  - Dependencias y documentación
      - Añadir @opencode-ai/sdk a apps/sim/package.json, sin integrarlo aún en runtime.
      - Añadir variables nuevas a apps/sim/.env.example.
      - Crear documentación del servicio, por ejemplo en docker/opencode/README.md, explicando:
          - qué es el servicio
          - cómo añadir repos con OPENCODE_REPOS
          - cómo verificar salud y creación de sesiones
          - cómo funciona la persistencia
          - que cada repo puede tener su propio AGENTS.md
          - que el SDK permite inyectar contexto adicional por sesión sin generar respuesta usando noReply: true en
            session.prompt, para que un bloque futuro pueda complementar el AGENTS.md estático con skills o configuración
            dinámica por sesión
          - que no existe aún política automática de retención de sesiones y que la limpieza queda como tarea futura
      - Crear docker/opencode/AGENTS.example.md como plantilla de referencia, sin inyectarlo en repos clonados.

  ### Interfaces y contratos nuevos

  - Servicio interno
      - hostname Compose: opencode
      - URL interna: http://opencode:${OPENCODE_PORT:-4096}
  - Variables nuevas
      - OPENCODE_IMAGE si se parametriza imagen en compose
      - OPENCODE_PORT
      - OPENCODE_SERVER_USERNAME
      - OPENCODE_SERVER_PASSWORD
      - OPENCODE_REPOS
      - GIT_USERNAME
      - GIT_TOKEN
  - Persistencia
      - opencode_repos conserva clones para evitar reclonado completo en cada restart
      - El bloque futuro podrá inyectar contexto dinámico por sesión con session.prompt({ body: { noReply: true, ... } }),
        además del contexto estático cargado desde el repo.

  ### Plan de verificación
      - edición, bash y web deben quedar bloqueados
      - si permission."*": "deny" rompe read/grep/glob/list, aplicar inmediatamente el fallback antes de dar por válido el
        despliegue
  - Validar compose con docker compose -f ... config.
  - Construir y arrancar el servicio en local y comprobar que queda healthy.
  - Verificar salud desde otro servicio del compose con auth básica.
  - Verificar creación de sesión vía POST /session.
  - Verificar que el reinicio del contenedor hace pull --ff-only donde corresponda y no pierde sesiones.
  - Verificar persistencia tras down y up -d sin borrar volúmenes.
  - Verificar arranque con OPENCODE_REPOS vacío.

  ### Suposiciones y defaults

  - La documentación oficial actual de OpenCode indica:
      - config global en ~/.config/opencode/opencode.json
  - Observabilidad más allá de logs de contenedor y healthcheck queda fuera de esta primera entrega.
  - No se modificará código funcional de SIMAI fuera de packaging, compose, CI, dependencias y documentación.

  ### Implementación realizada

  #### Resumen de ejecución

  - El alcance implementado se ha mantenido dentro de infraestructura, packaging, CI y documentación.
  - No se ha tocado lógica funcional de bloques, tools, endpoints API, runtime de workflows, stores ni componentes React.
  - Se añadió la dependencia @opencode-ai/sdk únicamente como preparación para consumo futuro.
  - Se creó y verificó un servicio Docker local de OpenCode con auth básica, sync de repos, persistencia y healthcheck.

  #### Archivos creados

  - docker/opencode.Dockerfile
  - docker/opencode/entrypoint.sh
  - docker/opencode/sync-repos.sh
  - docker/opencode/git-askpass.sh
  - docker/opencode/healthcheck.sh
  - docker/opencode/README.md
  - docker/opencode/AGENTS.example.md

  #### Archivos modificados

  - docker-compose.local.yml
  - docker-compose.prod.yml
  - apps/sim/.env.example
  - apps/sim/package.json
  - bun.lock
  - README.md
  - .github/workflows/images.yml
  - .github/workflows/ci.yml

  #### Contenedor OpenCode - decisiones tomadas

  - Se usó una imagen base node:22-bookworm-slim para mantener la instalación de npm simple y alineada con el requisito del servicio.
  - Se replicó el patrón local actual de CA corporativa presente en los Dockerfiles del workspace:
      - COPY docker/certs/company-ca.crt
      - configuración de SSL_CERT_FILE, NODE_EXTRA_CA_CERTS y npm_config_cafile
  - Se instalaron bash, ca-certificates, cron, curl, git y gosu.
  - Se instaló opencode-ai globalmente mediante npm install -g opencode-ai.
  - Se creó el usuario opencode con uid/gid 1001.
  - Se fijó WORKDIR /app en lugar de /app/repos para no acoplar el arranque al directorio de trabajo del repo.

  #### Ajustes de runtime detectados durante la implementación

  - OpenCode necesitó acceso de escritura a /home/opencode/.local/state además de /home/opencode/.local/share/opencode.
  - Este requisito no estaba explícito en el plan inicial y se añadió tras una prueba real de arranque:
      - se creó /home/opencode/.local/state en el Dockerfile
      - se añadió chown en el entrypoint
  - Sin este cambio, opencode serve fallaba con EACCES al intentar crear ~/.local/state.

  #### Entrypoint y sincronización - decisiones tomadas

  - Se separó el arranque en dos scripts:
      - entrypoint.sh para bootstrap del contenedor y lanzamiento del servidor
      - sync-repos.sh para la lógica reusable de clone/pull
  - El entrypoint:
      - valida OPENCODE_SERVER_PASSWORD
      - prepara directorios y ownership
      - genera ~/.config/opencode/opencode.json
      - genera un runtime-env.sh para que cron herede variables
      - instala el cron file en /etc/cron.d/opencode-sync
      - ejecuta un sync inicial
      - arranca cron
      - hace exec de opencode serve con gosu
  - El sync inicial ya no tumba el contenedor si falla un repo:
      - se envuelve con if ! sync; then log; fi
  - El cron corre cada 15 minutos como usuario opencode.
  - Se usa git pull --ff-only para evitar merges automáticos.
  - Se implementó detección de colisión de basenames.
  - Si un clone falla, se hace cleanup del directorio parcial para permitir reintentos limpios posteriores.

  #### Credenciales Git - decisiones tomadas

  - No se persistieron credenciales en remotes ni se reescribieron URLs con tokens.
  - Se implementó autenticación mediante GIT_ASKPASS:
      - git-askpass.sh responde a prompts de Username/Password
      - GIT_USERNAME + GIT_TOKEN cubren HTTPS genérico
      - GITHUB_TOKEN actúa como fallback para GitHub
  - Este enfoque evita problemas de URL encoding de credenciales y reduce el riesgo de dejar tokens escritos en .git/config.

  #### Configuración global de OpenCode - decisiones tomadas

  - La config se genera dinámicamente en runtime para poder interpolar OPENCODE_PORT.
  - Se dejó server.hostname=0.0.0.0 y server.port=${OPENCODE_PORT}.
  - Se implementó permission."*": "deny".
  - Se permitieron explícitamente:
      - read
      - grep
      - glob
      - list
  - Se denegaron explícitamente:
      - edit
      - bash
      - webfetch
      - task
      - todowrite
      - websearch
      - codesearch
  - En read se añadió una protección adicional para archivos de entorno:
      - *.env deny
      - *.env.* deny
      - *.env.example allow
  - Se verificó en runtime que la config cargada por el servidor coincide con la esperada mediante GET /config.

  #### Compose - decisiones tomadas

  - Se añadió el servicio opencode a docker-compose.local.yml con build.
  - Se añadió el servicio opencode a docker-compose.prod.yml con image parametrizable:
      - ${OPENCODE_IMAGE:-ghcr.io/simstudioai/opencode:latest}
  - No se publicaron puertos al host.
  - Se usó expose: ["4096"] para documentar el puerto interno.
  - Se añadieron dos volúmenes:
      - opencode_repos
      - opencode_data
  - Se configuró healthcheck con un script dentro del contenedor:
      - /usr/local/bin/opencode-healthcheck.sh
  - Se añadieron variables de entorno de proveedor con fallback desde el esquema ya usado por SIM:
      - OPENAI_API_KEY desde OPENAI_API_KEY o OPENAI_API_KEY_1
      - ANTHROPIC_API_KEY desde ANTHROPIC_API_KEY o ANTHROPIC_API_KEY_1
      - GEMINI_API_KEY desde GEMINI_API_KEY o GEMINI_API_KEY_1
  - En local se dejó OPENCODE_SERVER_PASSWORD con valor por defecto de desarrollo para facilitar pruebas.
  - En prod OPENCODE_SERVER_PASSWORD queda obligatoria desde entorno.

  #### CI e imagen - decisiones tomadas

  - Se añadió docker/opencode.Dockerfile a las matrices de:
      - .github/workflows/images.yml
      - .github/workflows/ci.yml
  - Se asumió una nueva imagen GHCR:
      - ghcr.io/simstudioai/opencode
  - Se asumió un nuevo secret/repositorio ECR:
      - ECR_OPENCODE
  - Esta parte queda implementada en código, pero depende de que el secret y el repo existan en la infraestructura del pipeline.

  #### Dependencias y documentación - decisiones tomadas

  - Se añadió @opencode-ai/sdk@0.8.0 a apps/sim/package.json usando bun add para mantener bun.lock consistente.
  - Se documentaron en apps/sim/.env.example las nuevas variables del servicio.
  - Se añadió una referencia breve en README.md hacia docker/opencode/README.md.
  - En docker/opencode/README.md se documentó:
      - propósito del servicio
      - OPENCODE_REPOS
      - verificación de health y creación de sesiones
      - comportamiento multi-repo
      - inyección futura de contexto con noReply: true
      - ausencia de política de limpieza de sesiones en esta fase

  #### Verificación ejecutada

  - Validación sintáctica:
      - docker compose -f docker-compose.local.yml config
      - docker compose -f docker-compose.prod.yml config
      - bash -n sobre todos los scripts nuevos
  - Build real:
      - docker compose -f docker-compose.local.yml build opencode
  - Arranque real del servicio:
      - se levantó el contenedor opencode aislado
  - Healthcheck:
      - el contenedor quedó healthy
      - se obtuvo {"healthy":true,"version":"1.2.27"} contra /global/health con auth básica
  - Config cargada:
      - GET /config devolvió la config read-only esperada
  - Sesiones:
      - POST /session devolvió una sesión válida
      - se recreó el contenedor y se confirmó que la sesión seguía listada en GET /session
  - Repos:
      - se verificó sync real con https://github.com/octocat/Hello-World.git
      - se comprobó el checkout dentro de /app/repos/Hello-World

  #### Ajustes durante la verificación

  - La primera prueba usó https://github.com/simstudioai/sim.git como repo de smoke.
  - Ese checkout resultó demasiado pesado para una verificación rápida y dejó un clone en curso durante el arranque.
  - Para completar la validación funcional del servicio, se cambió el repo de prueba a https://github.com/octocat/Hello-World.git.
  - El volumen de repos quedó persistente y por eso mantiene también el directorio sim creado durante la prueba inicial.
  - Esto no afecta a la implementación del servicio, solo al estado local de los volúmenes usados en la validación.

  #### Scope real frente al plan

  - No hubo ampliación de scope funcional.
  - Sí hubo un ajuste técnico no explícito en el plan:
      - creación y ownership de ~/.local/state para que OpenCode pudiera arrancar
  - No se añadieron features no pedidas en SIMAI.
  - No se crearon bloques, endpoints ni integración de ejecución.

  #### Puntos pendientes o incompletos

  - No se validó end-to-end el comportamiento del agente con una prompt real sobre repositorio y proveedor válido.
  - La razón es que no había una API key real de proveedor disponible en el entorno de prueba.
  - Queda pendiente la validación funcional crítica del wildcard deny:
      - comprobar con un prompt real que read/grep/glob/list siguen funcionando
      - comprobar con un prompt real que edit/bash/web siguen bloqueados
      - si falla, aplicar el fallback del plan eliminando permission."*"
  - No se implementó limpieza o retención automática de sesiones.
  - No se añadió observabilidad extra fuera de logs del contenedor y healthcheck.
  - La parte de CI requiere provisionar ECR_OPENCODE si ese pipeline debe quedar operativo en main/staging.

  #### Registro operativo

  - El contenedor de prueba se dejó parado al final de la verificación.
  - Los volúmenes Docker de prueba no se borraron para preservar la comprobación de persistencia realizada.
  - El repo local ya contenía cambios ajenos al alcance en otros Dockerfiles y archivos AGENTS.md; no se revirtieron.

  ### Estrategia recomendada para no perder OpenCode al actualizar SIMAI upstream

  #### Problema a resolver

  - La implementación actual de OpenCode vive dentro de este repo de trabajo.
  - Si el despliegue cloud actualiza directamente desde el repositorio oficial de SIMAI y ese upstream no incorpora estos cambios:
      - se perderá el servicio opencode en el siguiente update
      - se perderán los Dockerfiles, scripts y wiring de compose que hoy hacen que exista el servicio
      - aunque los volúmenes Docker puedan seguir existiendo en el host, el servicio dejará de declararse en compose y por tanto no volverá a levantarse
  - El requisito operativo adicional es claro:
      - OpenCode debe seguir usando la misma infraestructura donde ya corre SIMAI
      - no se quiere mover a otra máquina ni a otro entorno distinto

  #### Decisión recomendada

  - No depender de que opencode exista en el repositorio oficial de SIMAI.
  - Mantener SIMAI upstream lo más intacto posible.
  - Mover la customización de OpenCode a una capa de despliegue propia superpuesta sobre SIMAI.
  - Esa capa debe vivir en un repositorio de infraestructura o wrapper de despliegue controlado por nosotros.

  #### Arquitectura objetivo

  - Repositorio A:
      - SIMAI upstream
      - se actualiza desde el repositorio oficial
      - no contiene cambios obligatorios para que exista OpenCode
  - Repositorio B:
      - wrapper o repo de infraestructura de despliegue
      - contiene el overlay de OpenCode
      - contiene los secrets, variables, scripts de despliegue y compose adicionales necesarios
  - Despliegue final:
      - ambos se combinan sobre la misma máquina o cluster actual
      - OpenCode comparte red Docker con SIMAI
      - OpenCode comparte el mismo contexto operativo de infraestructura
      - OpenCode mantiene sus propios volúmenes para repos y sesiones

  #### Enfoque técnico recomendado

  - Extraer OpenCode de docker-compose.prod.yml principal y pasarlo a un fichero overlay dedicado.
  - Nombre recomendado:
      - docker-compose.opencode.yml
  - Ese overlay debe declarar:
      - servicio opencode
      - variables de entorno del servicio
      - volúmenes opencode_repos y opencode_data
      - healthcheck
      - image o build según el entorno
  - El despliegue debe ejecutarse combinando el compose oficial de SIMAI con el overlay:
      - docker compose -f docker-compose.prod.yml -f docker-compose.opencode.yml up -d
  - Si el despliegue actual ya usa varios compose files, el overlay de OpenCode debe añadirse al final para que quede desacoplado y fácilmente mantenible.

  #### Qué debe quedarse en upstream y qué debe salir

  - Debe salir del repo principal de SIMAI si queremos robustez frente a updates upstream:
      - el servicio opencode de docker-compose.prod.yml
      - el wiring de producción estrictamente necesario para que exista ese servicio
      - cualquier cambio de despliegue cuya única razón sea OpenCode
  - Puede quedarse dentro del repo si tiene valor general o si finalmente se acepta upstream:
      - documentación genérica del concepto, si aplica
      - integración futura del SDK si llega a ser parte oficial del producto
  - Debe vivir en el overlay o repo de infraestructura:
      - docker-compose.opencode.yml
      - .env o secret management asociado
      - pipeline de build/push de la imagen opencode si no se publica desde upstream
      - scripts operativos para verify, rollout y rollback

  #### Estructura propuesta del repo de infraestructura

  - deploy/
      - docker-compose.base.yml o referencia al compose upstream
      - docker-compose.opencode.yml
      - .env.example
      - scripts/
          - deploy.sh
          - verify-opencode.sh
          - rollback.sh
      - README.md
  - Si el repo wrapper contiene un checkout o submódulo del upstream:
      - dejar fijada una versión o commit de SIMAI
      - actualizarlo conscientemente en cada release

  #### Gestión de imagen de OpenCode

  - Opción preferida:
      - publicar una imagen propia de opencode en nuestro registry corporativo o cuenta GHCR/ECR
      - usar esa imagen desde docker-compose.opencode.yml
  - Motivo:
      - evita depender de que la imagen exista en la pipeline del upstream
      - desacopla OpenCode del release cycle de SIMAI
  - Alternativa válida:
      - construir la imagen en la propia máquina de despliegue con build:
      - útil para entornos simples
      - peor para trazabilidad y rollback
  - Recomendación operativa:
      - en cloud/prod usar image publicada y versionada
      - en local o staging pequeño se puede aceptar build local

  #### Gestión de secretos y variables

  - El overlay debe recibir al menos:
      - OPENCODE_SERVER_PASSWORD
      - OPENCODE_REPOS
      - credenciales Git para privados si aplica
      - al menos una API key de proveedor si se quiere validar prompting real
  - Estas variables no deben quedar repartidas entre varios repos sin control.
  - Deben centralizarse en el sistema de secrets ya usado por la infraestructura actual de SIMAI.
  - Si hoy el despliegue usa:
      - .env en servidor
      - secrets del CI
      - secret manager externo
    entonces OpenCode debe colgar del mismo mecanismo.

  #### Red y convivencia con la infraestructura actual

  - OpenCode no necesita infraestructura separada.
  - Debe unirse a la misma red Docker de SIMAI.
  - No debe publicar puertos al host.
  - Debe exponerse internamente por hostname de compose:
      - opencode
  - El consumo interno futuro desde SIMAI o tooling podrá usar:
      - http://opencode:${OPENCODE_PORT:-4096}

  #### Flujo de despliegue recomendado

  - Paso 1:
      - actualizar o fijar la versión upstream de SIMAI en el wrapper o repo de infraestructura
  - Paso 2:
      - mantener el overlay de OpenCode independiente del upstream
  - Paso 3:
      - desplegar todo junto con compose base + compose overlay
  - Paso 4:
      - verificar que SIMAI sigue healthy
  - Paso 5:
      - verificar que OpenCode sigue healthy en la misma red
  - Paso 6:
      - verificar que los volúmenes previos siguen montados y que las sesiones/repos persisten

  #### Flujo de actualización futura de SIMAI sin perder OpenCode

  - Cuando salga una nueva versión de SIMAI:
      - actualizar solo el upstream/base deployment
      - no tocar el overlay de OpenCode salvo que haya un cambio real de compatibilidad
  - Reejecutar despliegue combinado:
      - docker compose -f docker-compose.prod.yml -f docker-compose.opencode.yml up -d
  - Como OpenCode vive en el overlay:
      - seguirá existiendo aunque el compose oficial no lo declare
  - Como sus datos viven en volúmenes dedicados:
      - no debería perder repos ni sesiones entre updates

  #### Riesgos residuales del enfoque overlay

  - Si upstream cambia nombres de red, proyecto compose o convenciones de despliegue, el overlay puede requerir ajuste.
  - Si upstream cambia de Docker Compose a Helm, ECS, Nomad o similar, habrá que trasladar el overlay al mecanismo nuevo.
  - Si OpenCode necesita hablar con SIMAI en el futuro mediante variables, URLs o secretos adicionales, habrá que versionar también ese contrato.
  - Si se mantiene la build de imagen dentro del repo upstream y no en un pipeline propio, se vuelve a introducir acoplamiento.

  #### Medidas para minimizar mantenimiento

  - Mantener OpenCode como servicio lo más autónomo posible.
  - No tocar ficheros core del despliegue oficial salvo lo estrictamente imprescindible.
  - Evitar parches directos recurrentes sobre docker-compose.prod.yml del upstream.
  - Mantener la imagen de OpenCode en registry propio.
  - Mantener documentación operativa en el repo de infraestructura, no repartida entre varios sitios.

  #### Plan de ejecución recomendado

  - Fase 1:
      - crear repo wrapper o repo de infraestructura para despliegue
      - mover allí la definición de opencode a docker-compose.opencode.yml
  - Fase 2:
      - decidir si la imagen de OpenCode se publica en registry propio o se construye en deploy
  - Fase 3:
      - mover secrets y variables a la capa de despliegue real
  - Fase 4:
      - desplegar con compose base + overlay en el mismo host actual
  - Fase 5:
      - validar health, sesiones, persistencia y conectividad interna
  - Fase 6:
      - documentar procedimiento estándar de update upstream sin tocar OpenCode

  #### Criterio de éxito

  - Se puede actualizar SIMAI desde upstream sin perder OpenCode.
  - OpenCode sigue desplegado en la misma infraestructura.
  - OpenCode sigue usando su red y volúmenes internos.
  - El despliegue no depende de que el repositorio oficial de SIMAI conozca esta customización.
