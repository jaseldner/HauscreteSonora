# CRM Hauscrete — sesión dedicada

## Regla de sesiones (decisión del usuario, 25/08/2026)
**Esta sesión trabaja SOLO Hauscrete.** Baja, A2M y Bucas tienen cada uno su propia sesión en su carpeta (`C:\Negocios\Hauscrete BAJA ERP`, `C:\Negocios\Atelier Dos Mares\CRM Atelier`, `C:\Negocios\Bucas\Bucas ERP`). Si el usuario pide algo de otro sistema, avisarle que le toca a la sesión de ese sistema.

**EXCEPCIÓN importante:** Hauscrete y **Baja son gemelos exactos** — todo cambio de código de Hauscrete debe llegar también a Baja. Coordinar con la sesión de Baja vía `SendMessage`/`ListAgents` para acordar quién aplica el cambio en los dos archivos y no pisarse. Divergencias intencionales de Baja: letrero "BAJA" del login y color gris oscuro (`--navy:#343A40`).

## Qué es este sistema
- ERP/CRM en un solo archivo `modulo-proyectos.html` + `server.mjs` (node:sqlite), base `hauscrete.sqlite`, puerto local **3000** (pruebas: copiar la base al scratchpad y `PORT=3010 DB_FILE=<copia> node server.mjs`). App móvil `entregas.html` en `/movil`.
- **Nube: https://hauscrete-crm.fly.dev** (usuario `hauscrete` / `Hauscrete2026`). **La nube es la fuente de verdad**; el .sqlite local se refresca solo (tarea programada, ~1 día atrás, no es bug).
- Cambios se registran en `REQUERIMIENTOS.md` (marcadores RF-###). Desplegar: `flyctl deploy --now` (login jaseldner@gmail.com). La máquina corre con **512 MB** (no bajarla: con 256 hubo OOM).

## Contexto del 25/08/2026 (importante)
- **Incidente**: la nube amaneció vaciada (OOM en 256 MB + un navegador en blanco que guardó encima). Se restauró desde snapshot (116 proyectos/102 clientes/155 cotizaciones) y quedó protegida:
  - **RF-394 guardarraíl anti-vaciado** en `server.mjs`: rechaza con HTTP 409 un guardado donde projects/clientes/cotizaciones caigan a <20% de lo guardado (GUARD_MIN=8). Scripts de restauración legítimos deben mandar `{"force":true}` en el POST `/api/storage/set`.
  - **RF-389/395 guardado con acuse**: letrero de guardado abajo a la derecha; ante 409 muestra el mensaje del servidor y no reintenta.
- Perdido en el incidente (recapturar a mano si el usuario lo pide): lo del 24/08 después de la 1:07 pm y 3 prospectos (Altio, GASTEL, Ing Jesús Castro). También la cotización 172 (Briayan, IN-0054 Arq Claudia Barraza, MUROS $93,635.59 — los datos completos están en REQUERIMIENTOS.md 23.78 y el PDF lo tiene el usuario).

## Reglas de trabajo heredadas
- Nunca borrar/reiniciar datos en la base viva al probar; siempre COPIA del .sqlite.
- OneDrive ya NO se usa: todo vive en `C:\Negocios\...`. No escribir nada bajo `C:\Users\jasel\OneDrive` (queda una carpeta vacía `...\OneDrive\Personal\Negocios\Hauscrete\CRM Hauscrete` por borrar).
- Todo permiso del super usuario se le da también al rol `programador` (`rolActual()` ya mapea programador→super aquí). JAST es programador; su ficha no la ve nadie más (RF-386).
- Comisiones: solo se liberan con factura cobrada 100% Y remisión firmada — no relajar.
- Fechas siempre en hora LOCAL (`hoy()`/`ahora()`), nunca UTC.
- Tras editar, verificar con `grep -c RF-###` que los marcadores quedaron en el archivo.
- Ediciones grandes: patrón de bloques `===VIEJO:/===NUEVO:` con script que exige coincidencia única (hay uno en el scratchpad de sesiones previas: `ap.mjs`).

## Pendientes al 25/08/2026
- **Token de Fly de Baja vencido** (lo maneja la sesión de Baja, pero el usuario debe renovarlo; con él: deploy de Baja + `flyctl scale memory 512 -a hauscrete-baja-erp`).
- Recapturar la cotización 172 si el usuario lo confirma (datos en 23.78).
- Utilidad de cuentas por cobrar: preguntas al usuario sin responder (qué costo usar, si se descuenta comisión, prorrateo en parcialmente cobradas).
- Mortero: cuadre físico julio/agosto sigue esperando conteo del usuario. A38 sobra $90,000 de depósito; A42 faltan $55,752.26; A35 (SEYPET) no existe en el sistema — decisiones del usuario pendientes.
