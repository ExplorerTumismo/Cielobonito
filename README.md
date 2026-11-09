# Cielo — PWA del tiempo multimodelo para España

App web instalable (PWA) pensada para iPhone 17 (402 × 874 pt, Dynamic Island, modo claro/oscuro automático).
Compara varios modelos y predicciones para cualquier punto de España, Baleares, Canarias, Ceuta y Melilla.

## Pestañas
- **Mapa** — temperaturas de ~55 capitales con el modelo elegido (AROME / ECMWF / ICON), deslizador de +0 a +48 h y capa de radar (RainViewer). Toca el mapa para elegir una ubicación.
- **Ahora** — temperatura de consenso (mediana), indicador de coincidencia entre modelos, próximas 24 h y el valor de cada modelo ahora mismo; rango de máx/mín de hoy.
- **Meteograma** — hasta 7 días: temperatura (una línea por modelo + banda de dispersión), precipitación (mediana y máximo) y viento con rachas. Desliza el dedo para leer los valores hora a hora; toca las etiquetas para ocultar modelos.

## Fuentes
| Modelo | Origen | Clave | Alcance |
|---|---|---|---|
| AEMET | AEMET OpenData, predicción municipal horaria | Sí, gratuita | ~3 días, toda España |
| AROME | Météo-France vía Open-Meteo (`meteofrance_arome_france`, 2,5 km) | No | ~2 días; no cubre Canarias |
| Meteocat | API Meteocat, predicció municipal horària | Sí | ~3 días, solo Catalunya |
| ECMWF | IFS 0,25° vía Open-Meteo | No | 7 días |
| ICON | DWD ICON seamless vía Open-Meteo | No | 7 días |

AEMET y Meteocat no publican sus modelos crudos para un punto, sino la predicción municipal (que en AEMET se apoya en HARMONIE-AROME). La app elige el municipio más cercano al punto y muestra su nombre.

## Publicarla (5 minutos, gratis)
Cualquier hosting estático con HTTPS sirve. Con GitHub Pages:
1. Crea un repositorio y sube el contenido de esta carpeta (sin la carpeta `proxy` si no la usas).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Abre la URL `https://tuusuario.github.io/repositorio/` en **Safari** del iPhone → botón Compartir → **Añadir a pantalla de inicio**.

También vale Netlify Drop (arrastrar la carpeta) o Cloudflare Pages.

## Claves de AEMET y Meteocat
- AEMET: solicítala en https://opendata.aemet.es/centrodedescargas/altaUsuario (llega por correo).
- Meteocat: https://apidocs.meteocat.gencat.cat/ (formulario de acceso ciudadano).

Pégalas en **Ajustes** (icono de controles, arriba a la derecha). Se guardan solo en el navegador del teléfono.

### Si aparece «Bloqueado (CORS): usa proxy»
Algunas APIs oficiales no aceptan peticiones directas desde una web. Despliega el proxy incluido (gratis en Cloudflare Workers):
```
npm i -g wrangler
cd proxy
wrangler deploy worker.js --name cielo-proxy --compatibility-date 2026-01-01
wrangler secret put AEMET_KEY       # pega tu clave AEMET
wrangler secret put METEOCAT_KEY    # pega tu clave Meteocat
```
Pon la URL que devuelve (`https://cielo-proxy.<tu-cuenta>.workers.dev`) en Ajustes → URL del proxy. Con el proxy, las claves quedan en el servidor y no hace falta escribirlas en la app. Opcionalmente define `ALLOWED_ORIGIN` con la URL de tu PWA para que nadie más use tu proxy.

## Detalles técnicos
- Sin dependencias de compilación: `index.html`, `app.js`, `sw.js`, `manifest.webmanifest`. Leaflet 1.9.4 desde unpkg.
- Funciona sin conexión con la última predicción descargada (caché local de 20 min, se refresca al volver a la app).
- Datos Open-Meteo bajo CC BY 4.0, uso no comercial gratuito. Respeta las condiciones de reutilización de AEMET y Meteocat (citar la fuente).
