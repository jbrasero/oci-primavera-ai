# MCP para Primavera Unifier

Servidor MCP por `stdio` y aplicación web agentic para Oracle Primavera Unifier. Autentica un usuario de integración contra el endpoint V2 de token y reutiliza el `access_token` como `Bearer` para las llamadas REST V1/V2.

> **Proyecto comunitario de demostración.** No es un producto oficial de Oracle, no está afiliado, patrocinado, respaldado ni mantenido por Oracle. Oracle, OCI, Primavera y Unifier son marcas comerciales de Oracle Corporation y/o sus afiliadas.

> **Sin soporte ni garantías.** El código se proporciona «tal cual», exclusivamente para evaluación y demostración. Los autores y mantenedores no asumen ninguna obligación de soporte, mantenimiento, actualización, corrección de errores o parches de seguridad. Cada usuario debe validar la solución, permisos, endpoints, costes y controles de seguridad en su propio entorno antes de utilizarla.

Este repositorio no incluye credenciales, documentos de cliente ni datos extraídos. Utiliza secretos de entorno y documentos sintéticos para las pruebas. Consulta [SUPPORT.md](SUPPORT.md), [SECURITY.md](SECURITY.md) y [LICENSE](LICENSE) antes de utilizar el proyecto.

## Herramientas disponibles

- `unifier_connection_test`: comprueba autenticación y acceso de lectura.
- `unifier_list_shells`: lista proyectos y shells (`GET /ws/rest/service/v1/admin/projectshell`).
- `unifier_read_shell_360`: workflow de dos lecturas encadenadas: valida el shell en V1 y obtiene sus metadatos activos en V2. Devuelve únicamente campos operativos seleccionados.
- `unifier_list_bp_records`: consulta registros de un BP de un shell (`POST /ws/rest/service/v1/bp/records/{project_number}`). Este POST es una consulta y se mantiene habilitado en modo de solo lectura.
- `unifier_rest_request`: acceso a cualquier endpoint REST V1/V2 documentado. Solo permite `GET` y `HEAD` de inicio; las mutaciones requieren una habilitación explícita.

### Workflows Enterprise AI de solo lectura

- `unifier_inspect_bp`, `unifier_find_bp_record` y `unifier_approval_control`: inspección de BPs, búsqueda acotada por destinos y control de pendientes.
- `unifier_project_health` y `unifier_cost_sheet_budget`: visión de proyecto, Cost Sheet, snapshots, paquetes de trabajo y BPs financieros configurados.
- `unifier_project_autopilot_snapshot`: snapshot compacto y comparable de coste, planificación, BPs y aprobaciones; no devuelve registros completos ni escribe en Unifier.
- `unifier_risk_center`: centro de riesgos con evidencia de shell, Cost Sheet, planificación y BPs seleccionados; clasifica señales y prepara borradores de acción, sin escribir en Unifier.
- `unifier_schedule_health`: Schedule Sheets y, con `source_project_id`, actividades del System Activity Sheet.
- `unifier_search_documents`: metadatos y documentos de una ruta de Document Manager, sin descargas.
- `unifier_audit_inactive_shells` y `unifier_compare_projects`: auditoría de inactivos y comparación de varios shells.
- `unifier_bp_permissions`: permisos de visualización, edición y administración de registros de un BP.

Los nombres técnicos de BPs, la ruta de Document Manager y el `source_project_id` dependen de cada configuración de Unifier. Los workflows los solicitan solo cuando son necesarios.

## Configuración

Instala las dependencias y compila:

```bash
npm install
npm run build
```

Configura las variables como secretos de tu cliente MCP (no uses un `.env` versionado):

```json
{
  "mcpServers": {
    "primavera-unifier": {
      "command": "node",
      "args": ["/RUTA/ABSOLUTA/mcp_primavera/dist/index.js"],
      "env": {
        "UNIFIER_BASE_URL": "https://your-unifier-host.example.com/companycode/unifier",
        "UNIFIER_USERNAME": "<usuario-integracion>",
        "UNIFIER_PASSWORD": "<secreto>"
      }
    }
  }
}
```

Para desarrollo local, guarda los valores en un archivo `.env` (que ya está ignorado por Git) y arranca con `node --env-file=.env dist/index.js`. No uses `.env.example` para secretos: debe quedar como plantilla sin valores reales.

Para permitir altas, actualizaciones o borrados por `unifier_rest_request`, añade `UNIFIER_ALLOW_WRITE=true`. Déjalo desactivado durante el descubrimiento.

Si ya dispones de un token de Unifier, puedes configurar `UNIFIER_ACCESS_TOKEN` como secreto de entorno. Tiene prioridad sobre usuario y contraseña; úsalo solo hasta su vencimiento. Usa `UNIFIER_TOKEN_AUTH_SCHEME=Bearer` para un token V2/OAuth o `UNIFIER_TOKEN_AUTH_SCHEME=Basic` para un token de sesión V1.

## Límites y seguridad

Con `UNIFIER_AUTH_MODE=credentials`, el servidor obtiene el token V2 con el usuario y contraseña del entorno, lo mantiene en memoria y lo renueva; en este modo ignora cualquier `UNIFIER_ACCESS_TOKEN` antiguo. `UNIFIER_BASE_URL` puede ser la URL de la interfaz o terminar en `/ws/rest/service`: el cliente normaliza ambos formatos y evita duplicar ese tramo.

La URL de la interfaz puede terminar en `/unifier`; el cliente elimina ese sufijo para llamar a la raíz REST `https://<host>/<companycode>/ws/rest/service/...`, según la [configuración de conexiones de Oracle](https://docs.oracle.com/en/industries/construction-engineering/smart-construction-platform/integrate-primavera-cloud-with-unifier/configure-unifier-connections.html).
La conexión solo se considera validada con un listado JSON y `status: 200`. Un HTTP 200 que contenga una página HTML de login es un error, no una conexión correcta. Las llamadas REST no siguen redirecciones al SSO.

El servidor no almacena ni devuelve contraseñas o tokens. Solo acepta rutas bajo `/ws/rest/service/v1/` o `/ws/rest/service/v2/`, y renueva el token tras un `401`.

Las capacidades reales dependen de los permisos del usuario de integración y de los módulos publicados en la instancia Unifier.

Si el endpoint V2 redirige a Oracle Identity/SSO en lugar de responder JSON, el usuario no está listo para Basic Authentication. Un administrador debe confirmar que sea un **Integration User** activo con tipo de autenticación **Basic**, o proporcionar los parámetros del flujo OAuth habilitado para la instancia.

## Interfaz conversacional local

El proyecto incluye una interfaz de chat en `http://127.0.0.1:3000`. El navegador conserva el historial visual y el backend conserva el contexto lógico de la conversación mediante `previous_response_id`. En cada turno, el modelo decide qué herramienta del MCP necesita ejecutar.

### Primer workflow Enterprise AI: Ficha 360

La interfaz usa OCI Responses API con funciones MCP, por lo que el modelo ejecuta el workflow cuando se pide una ficha, detalle o visión 360 de un shell. `unifier_read_shell_360` valida primero el `project_number` en `GET /ws/rest/service/v1/admin/projectshell` y encadena `GET /ws/rest/service/v2/admin/shell` para recuperar metadatos activos. Es una operación estrictamente de lectura.

Ejemplo: `Dame la ficha 360 del shell P-0001`.

Además de las variables de Unifier, configura en tu `.env` el proveedor de modelo. OCI GenAI usa la Responses API compatible con OpenAI y es la opción preferida:

```bash
# OCI Generative AI (API key de Generative AI, no la clave privada de tu perfil OCI)
OCI_GENAI_API_KEY=<api-key-de-generative-ai>
OCI_GENAI_REGION=<region-oci, por-ejemplo-us-chicago-1>
OCI_GENAI_PROJECT_OCID=<ocid-del-generative-ai-project>
OCI_GENAI_MODEL=<id-de-modelo-soportado-en-tu-region>

# Opcional: habilita RAG con documentos cargados en un Vector Store de OCI.
OCI_VECTOR_STORE_ID=<id-del-vector-store>

# Opcional: auditoría periódica de shells inactivos; 0 o vacío la desactiva.
AGENT_MONITOR_INTERVAL_MINUTES=0

# Para el token V1 que se envía como Authorization: Basic <token>
UNIFIER_ACCESS_TOKEN=<token-unifier>
UNIFIER_TOKEN_AUTH_SCHEME=Basic
```

Como alternativa a `OCI_GENAI_API_KEY`, puedes usar el perfil IAM local que indicaste. La aplicación usa `oci raw-request` para firmar cada llamada mediante el perfil; necesita que la CLI de OCI esté instalada y que el perfil contenga región y una clave válida:

```bash
OCI_GENAI_PROFILE=DEFAULT
OCI_GENAI_PROJECT_OCID=<ocid-del-generative-ai-project>
OCI_GENAI_MODEL=<id-de-modelo-soportado-en-tu-region>
# OCI_GENAI_REGION es opcional si ya está configurada en el perfil indicado.
```

Como última alternativa, admite `OPENAI_API_KEY` y `OPENAI_MODEL`. Si existen varias configuraciones, la prioridad es API key de OCI, IAM de OCI y, finalmente, OpenAI.

Después, inicia la interfaz con:

```bash
npm run build
node --env-file=.env dist/web.js
```

La interfaz exige autenticación antes de acceder a cualquier ruta `/api`. Configura el usuario, la contraseña y la duración de la sesión en `.env`:

```dotenv
APP_AUTH_USERNAME=admin
APP_AUTH_PASSWORD=change-this-before-running
APP_AUTH_SESSION_HOURS=8
```

La sesión se mantiene en memoria mediante una cookie `HttpOnly` y `SameSite=Strict`; por tanto, se cierra al reiniciar el servidor o al pulsar **Salir**. Cambia la contraseña de demostración antes de exponer la aplicación fuera de un equipo de desarrollo.

El proceso escucha únicamente en `127.0.0.1`. Si necesitas acceso remoto, colócalo detrás de un proxy HTTPS, cambia la contraseña de demostración, activa `APP_AUTH_SECURE_COOKIE=true` y aplica controles de red adecuados. Para reiniciar el contexto, pulsa **Nueva conversación**.

### Portlet de Unifier

La ruta `/unifier-portlet` está diseñada para mostrarse en un Portlet Block de Unifier sin relajar la protección anti-iframe de la ruta principal. La plantilla `deploy/nginx-primavera-agentica.conf.template` necesita dos valores antes de instalarse:

```bash
export PUBLIC_HOST=demo.example.com
export UNIFIER_PARENT_ORIGIN=https://your-unifier-host.example.com
```

La ruta principal conserva `X-Frame-Options: DENY` y `frame-ancestors 'none'`. La ruta del portlet usa una cookie de sesión independiente con `Secure`, `SameSite=None` y `Partitioned`. Para un uso real, emplea un certificado emitido por una CA de confianza.

## Historial de decisiones de contratos

El panel colapsable «Historial de decisiones» muestra los eventos de **la sesión actual** para el shell activo y permite buscar por campo, contrato, responsable o motivo. Antes de confirmar un bloqueo, indica el responsable y el motivo/fuente en el agente de contratos. Las correcciones se registran al salir del campo; cambiar un dato confirmado vuelve a abrir su bloqueo.

Se conservan propuestas de extracción y revalidación, valores anteriores/nuevos, evidencia textual, nombres y hashes SHA-256 de los PDF analizados, confirmaciones, excepciones y eventos de publicación. Cada expediente tiene un identificador incluido en el JSON revisado. La revalidación conserva la historia anterior y registra nuevas propuestas; no restaura automáticamente correcciones manuales.

**El destino persistente es Unifier, no el disco local.** Al pulsar «Publicar contrato e historial» y confirmar, el backend genera en memoria `historial-decisiones-<expediente>.pdf` y `.json`. Ambos se adjuntan al mismo registro BP y en la misma llamada REST que los contratos y anexos. No requieren nuevos campos de uDesigner. Se mantienen los requisitos existentes del BP, permisos para adjuntos, configuración de Auto Creation y mapeo de campos.

El PDF permite leer la secuencia de decisiones, valores finales, campos técnicos, responsables, motivos, evidencias y hashes. El JSON conserva los valores y texto Unicode completos. Ambos son una **foto previa al envío**: no certifican la creación ni incluyen la respuesta de esa misma publicación. Los eventos de respuesta se muestran solo en la pestaña; consulta el estado real y los adjuntos del registro en Unifier. El estado inicial del BP depende de su configuración, no del nombre «borrador» usado en la UI.

Hasta publicar, las decisiones y archivos solo permanecen en memoria de la pestaña. **Recargar o cerrar pierde la revisión pendiente**; el navegador avisa si hay decisiones sin publicar. Si falla el envío, conserva la pestaña y comprueba primero en Unifier si se creó el registro para evitar duplicados. Se bloquea la publicación si el shell no coincide con el análisis o si los hashes de los documentos han cambiado: revalida en ese caso. Máximo: 6 PDF de origen + 2 informes, 25 MB en conjunto; historial de hasta 1000 eventos / 2 MB.

Los historiales publicados se consultan en los **adjuntos del contrato en Unifier**; el panel no los descarga automáticamente. El backend ya no lee ni escribe `data/decisions.jsonl` y `/api/decisions` responde 410 a clientes antiguos. Un archivo local de una versión anterior no se migra ni elimina automáticamente.

Esta demo registra identidad y fechas declaradas por el navegador, sin autenticarlas. Los informes no son una auditoría inalterable ni reemplazan el Audit Log nativo de Unifier. Las decisiones anteriores a esta funcionalidad no se reconstruyen.

Pruebas: `npm test` valida generación, empaquetado y controles del historial. `RUN_INTEGRATION_TESTS=1 npm test` añade el recorrido web → MCP → servidor Unifier simulado en loopback, sin cargar `.env` ni usar credenciales reales. Para comprobar visualmente el informe con datos sintéticos: `npm run build && node scripts/preview-decision-report.mjs`; el PDF de QA se genera en `tmp/pdfs/` (excluido de Git).

## Autopilot de proyecto

El panel «Autopilot de proyecto» de Mission Control permite activar la vigilancia del shell seleccionado. Configura nombres técnicos de BPs separados por comas, los BPs que representan aprobaciones y, opcionalmente, el `source_project_id` para contar actividades vencidas. Si se omite, intenta descubrirlo desde los metadatos Gateway/Primavera Cloud del shell. Al activar, hace una lectura real y crea una línea base sin alerta.

Mientras `dist/web.js` siga ejecutándose, cada mañana compara una nueva lectura de Cost Sheet, paquetes, Schedule Sheets, actividades, estados e importes de BPs y carga de aprobaciones. Solo abre una alerta en Mission Control si cambia una métrica material, el estado del shell o la disponibilidad de una fuente. Los cambios financieros inferiores a `PROJECT_AUTOPILOT_AMOUNT_DELTA` (1000 por defecto) se ignoran. Errores idénticos consecutivos no duplican alertas.

La hora se configura con `PROJECT_AUTOPILOT_HOUR`, `PROJECT_AUTOPILOT_MINUTE` y `PROJECT_AUTOPILOT_TIMEZONE` (por defecto `08:00 Europe/Madrid`). Si el proceso arranca después de esa hora y aún no ha ejecutado ese día, realiza la revisión pendiente. «Ejecutar ahora» permite demostrar el flujo sin esperar. Para garantizar la ejecución diaria en producción, mantén el proceso bajo `systemd`, Docker, Kubernetes o un servicio equivalente.

El Autopilot es de solo lectura en Unifier. Su línea base, configuración y alertas de Mission Control se guardan en `data/project-autopilot.json`, con métricas agregadas y sin credenciales ni registros completos. «Marcar revisada» solo reconoce la alerta en la aplicación; no crea ni modifica un BP de Unifier.

## Referencias

- [Autenticación REST V2 de Unifier](https://docs.oracle.com/cd/F88970_01/English/Integration_Documentation/integration/unifier_integration_interface.pdf)
- [Listado de proyectos y shells](https://docs.oracle.com/en/industries/construction-engineering/primavera-unifier/26/integration-interface/getprojectshelllist-10293761a.html)
- [Metadatos de un shell V2](https://docs.oracle.com/en/industries/construction-engineering/primavera-unifier/26/integration-interface/getshell-10310993a.html)
- [OCI Enterprise AI Agents y Responses API](https://docs.oracle.com/en-us/iaas/Content/generative-ai/agents.htm)
- [Guía de integración REST de Unifier](https://docs.oracle.com/en/industries/construction-engineering/primavera-unifier/26/integration.html)
