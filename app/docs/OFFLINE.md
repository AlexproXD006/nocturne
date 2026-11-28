# Modo sin conexión y descargas

Nocturne puede reproducir sin red de dos maneras que conviven:

1. **Caché automática**: las últimas **30** canciones que has reproducido (ajustable: 30 / 50 / 100 / 200, o por
   tamaño: 1 / 2 / 5 GB) se guardan solas mientras suenan. Solo conserva las N más recientes (LRU por reproducción).
2. **Descargas** (estilo Netflix): botón **Descargar** en listas, álbumes, mixes y canciones. Lo descargado queda
   *fijado*: no entra en la rotación de la caché automática y nunca se expulsa solo. Las listas descargadas se
   **sincronizan** cuando hay conexión (las canciones nuevas se descargan, las quitadas se borran).

Todo usa las URL firmadas de siempre (`/v1/tracks/:id/stream`, `/v1/media/art`); no hay endpoints públicos nuevos.
El servidor añade `GET /v1/tracks/:id/offline-manifest` y `POST /v1/offline/manifest` (ver `docs/API.md`) para
obtener stream + portada + letra + metadatos en una sola petición.

## Arquitectura por plataforma

| | Android | Escritorio (Electron) | Web / iOS |
|---|---|---|---|
| Audio | Media3 `SimpleCache` único (`files/offline/media`) con `CacheDataSource` envolviendo el resolvedor de URL firmadas. **Clave de caché = id de la pista** (no la URL firmada). Se escribe *mientras suena*: sin doble descarga. | Proceso principal: `userData/offline/audio` + `index.json`. Se sirve por el protocolo `nocturne-offline://` (con `Range`). Lo que suena pasa por `nocturne-stream://`, que hace *tee* del stream a disco (sin doble descarga). | IndexedDB (`nocturne-offline`, blobs). La caché automática hace **una petición extra** de la misma URL firmada tras unos segundos (el caché HTTP del navegador suele contestarla). |
| Política N-recientes | `CachePolicy` + `RecentTracksEvictor` (Java, `CacheEvictor`) | `src/shared/offlinePolicy.ts` (compartida con la web) | `src/shared/offlinePolicy.ts` |
| Descargas | Media3 `DownloadManager` (2 en paralelo) + `NocturneDownloadService` (servicio en primer plano `dataSync`, notificación con progreso, `PlatformScheduler` para reanudar al volver el Wi-Fi o tras reiniciar; funciona con la app cerrada). Comparte la caché con la reproducción. | Cola del renderer (concurrencia 2, persistida), descarga en el proceso principal | Cola del renderer (concurrencia 2, persistida) |
| Solo Wi-Fi | `Requirements.NETWORK_UNMETERED` | siempre permitido (sin noción de tarifa) | `navigator.connection` si existe (Chrome); en Safari/iOS no se puede saber y se permite |
| Portada / letra / metadatos | Ficheros nativos en `files/offline/meta/<id>` (portada 512 px, `lyrics.json`, `meta.json`) para widgets, notificación y Android Auto, **y** copia en IndexedDB del WebView para la interfaz | IndexedDB del renderer | IndexedDB |
| Android Auto / widgets | Nodo **Descargas** (se lee del índice de descargas: funciona sin red); el servicio salta las canciones no guardadas sin conexión; la portada offline se incrusta en la notificación | – | – |

### Reproducción

`resolveStream` (en `services.ts`) pasa por `useOffline.playbackFor`: si la pista está guardada se reproduce la copia
local (blob / `nocturne-offline://`); si no, se usa la URL firmada (en escritorio, a través del *tee*). Un reintento
tras un error de reproducción (`force`) ignora las copias locales y las cachés.

### Qué es "disponible sin conexión"

`useOffline.available` (id → `pinned` | `auto`). En Android lo rellena el estado del `DownloadManager` y
`availability()` (pistas completamente cacheadas); en el resto, el índice del backend.

## Modo sin conexión (UX)

* Detección (`store/connectivity.ts`): `navigator.onLine`, conectividad nativa en Android (`ConnectivityManager`) y
  fallos de red reales de la API (`ApiClient.onResult`). Mientras el servidor no responde se sondea cada 15 s.
* Banner **«Sin conexión · Mostrando lo disponible»** con botón *Reintentar*.
* En las listas, las canciones guardadas llevan el icono ⬇ y, sin conexión, las no guardadas se atenúan; tocarlas
  avisa en lugar de intentar reproducirlas. El reproductor **salta** lo no reproducible (`isPlayable`) y, en Android,
  el servicio salta al siguiente elemento en caché si falla uno.
* Filtro **«Disponibles sin conexión»** en las listas (Biblioteca, Me gusta, listas, álbumes) y en Buscar. Sin
  conexión, Biblioteca muestra las listas/álbumes/mixes descargados y las canciones guardadas, y Buscar busca solo
  en lo guardado.
* Las páginas de lista/álbum/mix descargados se reconstruyen desde los metadatos guardados si no hay red.
* Reproducciones y *me gusta* hechos sin red se encolan (`playQueue` existente y `pendingLikes`) y se envían al volver.
* Letras y portadas salen de la copia guardada cuando no hay red (`lyricsWithOffline`, `Artwork`).

## Ajustes

*Ajustes → Sin conexión y descargas*: caché automática (por canciones o por tamaño), *Solo con Wi-Fi* para la
precarga/caché, *Descargar solo con Wi-Fi* (por defecto activado), calidad (solo «Original» mientras el servidor no
anuncie `capabilities.transcode`), límite de almacenamiento de descargas (aviso al 90 %, rechazo al alcanzarlo) y
**Vaciar caché** (nunca toca las descargas).

La pantalla **Descargas** (menú lateral / barra inferior) lista lo que está en curso (n/total, pausa, reanudar,
cancelar), las listas/álbumes/mixes descargados, las canciones sueltas, el tamaño por elemento y total, la barra de
almacenamiento y «Borrar todas las descargas».

## Límites conocidos

* **iOS (WKWebView)**: el audio vive en IndexedDB. iOS puede **liberar ese almacenamiento** si el dispositivo va
  justo de espacio y las cuotas son pequeñas y no consultables; si el navegador rechaza la escritura (`QuotaError`)
  la caché se degrada en silencio y las descargas muestran «El navegador no tiene más espacio…». No hay descargas
  con la app cerrada (iOS suspende la web); la cola se reanuda al abrir. Sin API de red de tarifa: «Solo Wi-Fi» no
  puede aplicarse.
* **Web / iOS: la caché automática hace una segunda petición** de la URL firmada (no se puede interceptar el
  `<audio>` sin service worker). En escritorio y Android no hay descarga doble.
* **Calidad comprimida**: el servidor de referencia no transcodifica (`capabilities.transcode: false`); solo
  «Original».
* **Android**: la API de Media3 `DownloadService` en primer plano con tipo `dataSync` tiene límites de tiempo en
  Android 15+ (≈6 h/día) y exige que la descarga se inicie con la app visible. La caché automática no se expulsa al
  pausar, solo al cambiar la política o al superar N.
* **Registro hospedado (cookie)**: restaurar la sesión sin red cierra la sesión (el refresh token es una cookie
  HttpOnly); el modo sin conexión de la web hospedada requiere haber iniciado sesión en esa pestaña.
* Android Auto: solo el nodo *Descargas* funciona totalmente sin red.

## Pruebas pendientes en dispositivo

Android (descarga con la app cerrada, reanudar al volver el Wi-Fi, límite Android 14/15, reproducir el nodo
Descargas en un coche/DHU, notificación con progreso), Electron (protocolos `nocturne-offline` / `nocturne-stream`
con Web Audio + ecualizador, *tee* con saltos de posición), iOS (cuotas de IndexedDB, evicción por el sistema).

## Archivos

Renderer: `store/offline.ts`, `store/connectivity.ts`, `lib/offline/*`, `platform/offline/*`, `platform/nativeOffline.ts`,
`pages/Downloads.tsx`, `pages/OfflineSettings.tsx`, `components/DownloadButton.tsx`, `components/OfflineBanner.tsx`.
Electron: `src/main/offline.ts`, `src/shared/offlinePolicy.ts`. Android: `media/{CachePolicy, RecentTracksEvictor,
OfflineCache, OfflineMeta, OfflinePrefs, DownloadPlan, DownloadsController, NocturneDownloadService,
NocturneOfflinePlugin, NetMonitor}.java`. Servidor: `nocturne_api/routes_offline.py`.
