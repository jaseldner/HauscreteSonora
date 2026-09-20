# CRM Hauscrete — Servidor local (Ruta A · SQLite)

CRM/ERP de Hauscrete corriendo en tu máquina, con los datos guardados en un
archivo **SQLite** (`hauscrete.sqlite`) en vez del `localStorage` del navegador.
Así los datos ya no se pierden al editar el código y quedan separados del programa.

## Requisitos

- **Node.js 24+** (ya instalado). SQLite viene integrado (`node:sqlite`), sin paquetes de npm.

## Cómo usarlo

```powershell
# 1. Iniciar el servidor
npm start

# 2. Abrir en el navegador
#    http://localhost:3000
```

El servidor sirve `modulo-proyectos.html` e inyecta un pequeño shim que redirige
`window.storage` (get/set/delete/list) a la base SQLite. **El HTML no se modifica.**

## Importar tu respaldo actual

Exporta el respaldo desde el CRM viejo (Ajustes → Generales → respaldo) y córrelo:

```powershell
node import-json.mjs "C:\ruta\a\respaldo.json"
```

Esto llena `hauscrete.sqlite` con tu historial (proyectos, cotizaciones, productos…).

## Archivos

| Archivo | Qué es |
|---|---|
| `modulo-proyectos.html` | La app (tu archivo, sin cambios) |
| `server.mjs` | Servidor local + API de storage sobre SQLite |
| `db.mjs` | Esquema y traducción `state ↔ tablas normalizadas` |
| `import-json.mjs` | Importa un respaldo JSON a la base |
| `test-db.mjs` | Prueba de fidelidad round-trip + consultas SQL |
| `hauscrete.sqlite` | **Tus datos** (no se versiona; respáldalo) |
| `package.json` | Scripts `npm start` / `npm run import` |

## Tablas de la base

Aunque la app guarda su estado completo, el servidor lo **descompone en tablas
normalizadas** consultables con SQL y lo **reensambla** al leer (la app no cambia):

`projects`, `cotizaciones` (+`cotizacion_partidas`), `ocs` (+`oc_partidas`),
`productos`, `proveedores`, `clientes`, `usuarios`, `sistemas`, catálogos y `config`.

Cada fila guarda además su JSON original (columna `data`), así que el
reensamblado es exacto; un auto-test lo verifica en cada guardado. La tabla `kv`
conserva un respaldo del estado crudo y los adjuntos (`arch-*`, `fact-*`).

## Respaldos

`hauscrete.sqlite` es tu fuente de verdad. Cópialo periódicamente a un lugar
seguro. Para volver a la nube más adelante (Turso/Supabase), este mismo archivo
se sube sin perder nada.

## Nota

Los adjuntos e imágenes (PDFs/XML de factura, fotos) también se guardan como
claves en `window.storage`, así que ahora viven en SQLite igual que el resto.
