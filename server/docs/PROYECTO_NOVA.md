# NOVA Music Server - Documentación Completa del Proyecto

> **Nota (legacy):** documentación histórica del servidor NOVA original, en español. La interfaz web antigua de NOVA (`frontend/`, `app.v2.js`, `bg.js`…) ya **no forma parte de este repositorio**: la reemplaza la app web de Nocturne servida en `/`, y la API `/api/*` sin autenticación está desactivada por defecto (`NOVA_LEGACY_API=off`). Para instalar hoy, sigue el `README.md` de la raíz (Docker).


## Tabla de Contenidos

1. [Visión General del Proyecto](#visión-general-del-proyecto)
2. [Historia y Origen](#historia-y-origen)
3. [Arquitectura del Sistema](#arquitectura-del-sistema)
4. [Tecnologías Utilizadas](#tecnologías-utilizadas)
5. [Componentes del Backend](#componentes-del-backend)
6. [Estructura del Frontend](#estructura-del-frontend)
7. [Diseño Visual y UI/UX](#diseño-visual-y-uiux)
8. [Sistema de Reproducción de Audio](#sistema-de-reproducción-de-audio)
9. [Gestión de Biblioteca y Metadatos](#gestión-de-biblioteca-y-metadatos)
10. [Sistema de Descargas](#sistema-de-descargas)
11. [Playlists y Colaboración](#playlists-y-colaboración)
12. [Persistencia de Datos](#persistencia-de-datos)
13. [Seguridad y Despliegue](#seguridad-y-despliegue)
14. [Instalación y Configuración](#instalación-y-configuración)
15. [Resolución de Problemas](#resolución-de-problemas)
16. [Características Avanzadas](#características-avanzadas)
17. [Comparación con Alternativas](#comparación-con-alternativas)
18. [Futuro y Hoja de Ruta](#futuro-y-hoja-de-ruta)
19. [Licencia y Consideraciones Legales](#licencia-y-consideraciones-legales)

---

## 1. Visión General del Proyecto

### 1.1 ¿Qué es NOVA?

NOVA es un servidor de música autohospedado de última generación que proporciona una experiencia de streaming de música comparable a servicios comerciales como Spotify, Apple Music o Tidal, pero con la privacidad, control y personalización que solo el almacenamiento local puede ofrecer. El proyecto representa la convergencia entre tecnología moderna de desarrollo web, diseño visual de vanguardia y la filosofía de autosuficiencia digital que impulsa el movimiento de software libre y código abierto.

A diferencia de los servicios de streaming comerciales, NOVA no requiere suscripción mensual, no tiene limitaciones en la cantidad de canciones que puedes almacenar, no impone restricciones geográficas sobre el contenido, y fundamentalmente, no monetiza tus hábitos de escucha ni recopila datos personales sobre tu comportamiento musical. Todo el contenido que reproduces reside en tu propia infraestructura, bajo tu control total, disponible las 24 horas del día los 7 días de la semana sin dependencia de servidores externos.

### 1.2 Propuesta de Valor

La propuesta de valor central de NOVA se articula en varios pilares fundamentales que lo distinguen de cualquier alternativa comercial o de código abierto:

**Privacidad Absoluta**: Ningún dato sale de tu infraestructura local. Tu historial de reproducción, tus playlists, tus hábitos de escucha, todo permanece en tu servidor y tu navegador. No hay trackers, no hay análisis de comportamiento, no hay terceros involucrados.

**Control Total**: Tienes propiedad absoluta sobre tu contenido musical. Puedes agregar archivos desde cualquier fuente, organizar tu biblioteca como prefieras, y tienes acceso completo a los archivos para respaldos, migración o uso en otras aplicaciones.

**Experiencia Premium**: La interfaz de usuario es tan refinada y visualmente atractiva como las mejores aplicaciones comerciales. El diseño glassmorphism, los efectos visuales reactivos, los visualizadores de audio en tiempo real, y la thematización dinámica basada en portadas crean una experiencia inmersiva que supera expectativas.

**Flexibilidad de Contenido**: A diferencia de servicios que dependen únicamente de catálogos propietarios, NOVA puede obtener música desde Spotify (metadatos) y YouTube (audio), permitiéndote construir tu biblioteca con contenido de múltiples fuentes de manera unificada.

**Eficiencia de Recursos**: Diseñado originalmente para ejecutarse en un contenedor LXC de Proxmox con recursos modestos (2GB RAM, 1-2 CPU cores), el sistema es extremadamente eficiente en comparación con alternativas que requieren servidores dedicados con especificaciones mucho mayores.

### 1.3 Público Objetivo

NOVA está diseñado para usuarios que caen en varias categorías overlap:

El **entusiasta de la privacidad** valora sus datos personales y busca alternativas a servicios quelos monetizan, alguien que prefiere mantener su biblioteca musical en infraestructura propia en lugar de confiar en servidores externos con modelos de negocio basados en datos de usuarios.

El **coleccionista de música** tiene una biblioteca existente de archivos digitales adquiridos a lo largo de los años, CDs rippeados, descargas legales, y desea una forma atractiva y funcional de acceder y reproducir su colección sin los límites de los servicios de streaming.

El **usuario técnico** con conocimientos de administración de sistemas que aprecia la elegante combinación de tecnologías (FastAPI, SQLite, WebGL, vanilla JavaScript) y valora la simplicidad de una solución autohospedada que puede personalizar y extender según sus necesidades.

El **aficionado al home lab** que ya opera su propia infraestructura (Proxmox, Docker, etc.) y busca expandir sus servicios con una aplicación de música que se integre naturalmente en su ecosistema existente.

---

## 2. Historia y Origen

### 2.1 Contexto del Desarrollo

El proyecto NOVA emergió como respuesta a una frustración común entre usuarios de servicios de streaming: la falta de propiedad real sobre la música que consumimos. Cuando pagas una suscripción mensual a Spotify o Apple Music, no estás comprando música; estás rentando acceso a un catálogo que puede cambiar, remover contenido, o simplemente dejar de estar disponible según las decisiones corporativas de la plataforma. Los algoritmos de recomendación priorizan contenido que beneficia a la plataforma, no necessarily lo que más te gusta. Y en el caso de terminar tu suscripción, pierdes acceso a toda la música que "descubriste" durante ese tiempo.

La idea de crear un servidor de música autohospedado no era nueva en 2024; existen alternativas como Navidrome, Koel, Ampache, y Subsonic que han existido durante años. Sin embargo, la mayoría de estas soluciones presentan interfaces anticuadas que reflejan sus edades (muchas se diseñaron hace una década), carecen de integración moderna con fuentes de música como Spotify y YouTube, y no aprovechan las capacidades visuales y de interacción que los navegadores modernos permiten. NOVA surge con la ambición de demostrar que una aplicación de música autohospedada puede ser tan visualmente impresionante y funcionalmente avanzada como cualquier aplicación comercial.

### 2.2 Evolución del Nombre

El nombre "NOVA" no es accidental. En astronomía, una nova es una estrella que aumenta dramáticamente su brillo debido a una explosión termonuclear, un evento estelar que transforma algo que era relativamente poco notable en algo brillante y visible a través de vastas distancias. Este nombre captura la esencia del proyecto: transformar la experiencia de música autohospedada de algo utilitario pero visualmente apagado en algo que irradia calidad y sofisticación. El subtítulo "Deep Space Observatory" refuerza esta temática espacial y sugiere la vastedad de posibilidades que el proyecto abre para los usuarios.

### 2.3 Filosofía de Desarrollo

El desarrollo de NOVA ha seguido principios que guiaron cada decisión técnica y de diseño:

**Minimalismo de Dependencias**: A diferencia de muchas aplicaciones modernas que requieren build tools complejos, bundlers, frameworks de JavaScript como React o Vue, y múltiples capas de abstracción, NOVA funciona con vanilla JavaScript y CSS puro. Esta decisión reduce dramáticamente la superficie de bugs potenciales, facilita el mantenimiento a largo plazo, y garantiza que la aplicación funciona en cualquier navegador moderno sin configuración adicional.

**Progresividad Natural**: Cada característica funciona de manera independiente. Puedes usar el reproductor sin el visualizador, la búsqueda sin las descargas, la biblioteca sin playlists. No hay dependencias forzadas entre funcionalidades, lo que permite que el sistema funcione robustamente incluso cuando某些 componentes no están disponibles.

**Mejora Continua con Conservadurismo**: El proyecto adopta un enfoque cauteloso hacia nuevos features. Cada funcionalidad pasa por un proceso de diseño, implementación, prueba, y refinamiento antes de considerarse lista para producción. Los bugs identificados durante el uso en producción se documentan y corrigen sistemáticamente.

---

## 3. Arquitectura del Sistema

### 3.1 Diagrama de Arquitectura General

La arquitectura de NOVA sigue un patrón cliente-servidor clásico optimizado para eficiencia y simplicidad, donde el servidor provee datos y el cliente maneja toda la presentación e interacción:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USUARIO (Navegador)                           │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         FRONTEND (NOVA)                             │   │
│  │  HTML5 + CSS3 Glassmorphism + JavaScript ES6+                     │   │
│  │  • WebGL2 Background (shaders, partículas, audio-reactivo)        │   │
│  │  • Audio API (analizador FFT, crossfade dual)                     │   │
│  │  • WebSocket Client (progress de descargas en tiempo real)        │   │
│  │  • SPA Routing (tabs sin reload)                                  │   │
│  │  • LocalStorage (persistencia de preferencias)                    │   │
│  └────────────────────────────┬────────────────────────────────────────┘   │
│                               │                                            │
│  ┌────────────────────────────▼────────────────────────────────────────┐   │
│  │                    nginx (Reverse Proxy)                           │   │
│  │  Puerto 80 → /api/* → localhost:8000 (FastAPI)                     │   │
│  │            → /ws/* → WebSocket upstream                            │   │
│  │            → /* → Archivos estáticos (frontend)                   │   │
│  │            → /music/* → Archivos de audio                         │   │
│  └────────────────────────────┬────────────────────────────────────────┘   │
└───────────────────────────────┼─────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────────┐
│                         BACKEND (FastAPI)                                   │
│  Puerto 8000 (internal)                                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     API REST + WebSocket                            │   │
│  │  • Endpoints de biblioteca (CRUD tracks, búsqueda)                  │   │
│  │  • Streaming de audio (HTTP Range requests)                        │   │
│  │  • Gestión de descargas (spotdl + yt-dlp)                         │   │
│  │  • Importación de playlists Spotify                                │   │
│  │  • WebSocket para progreso de descargas                            │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────┐     │
│  │  database.py    │  │  downloader.py   │  │  main.py (FastAPI)     │     │
│  │  (SQLite/WAL)   │  │  (spotdl/yt-dlp) │  │  (Uvicorn + Endpoints)│     │
│  └──────────────────┘  └──────────────────┘  └────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────────┐
│                      SISTEMA DE ARCHIVOS                                    │
│  /opt/music-server/ → Código Python + Frontend                            │
│  /music/             → Archivos de audio + library.db                     │
│  ~/.cache/          → Cache de spotdl/yt-dlp                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Flujo de Datos

El flujo de datos en NOVA sigue patrones predecibles que facilitan el debugging y la comprensión del sistema:

**Flujo de Reproducción**: Cuando un usuario hace click en una canción, el frontend solicita el stream al endpoint `/api/stream/{track_id}`. El backend verifica que el track existe en la base de datos, construye la ruta al archivo de audio, y devuelve el archivo usando HTTP Range requests que permiten seek y scrub. El navegador reproduce el audio directamente sin intermediarios.

**Flujo de Búsqueda**: Cuando el usuario escribe en el campo de búsqueda, el frontend envía la consulta al backend, que la deriva al endpoint correspondiente (Spotify o YouTube según el modo seleccionado). Spotify usa la API oficial a través de spotipy, mientras YouTube usa la API de yt-dlp. Los resultados se devuelven al frontend y se renderizan en cards interactivos.

**Flujo de Descarga**: Cuando el usuario inicia una descarga, el backend crea un job asíncrono y responde inmediatamente. El proceso de descarga corre en background, reportando progreso via WebSocket cada segundo. Cuando completa, el job se marca como done, el track se inserta en la base de datos, y el frontend recibe la actualización automáticamente.

**Flujo de Actualización de UI**: El sistema usa polling y WebSockets selectivamente. Para datos que cambian frecuentemente (progreso de descargas), el WebSocket proporciona actualizaciones instantáneas. Para datos más estáticos (library, playlists), la carga ocurre cuando el usuario visita la pestaña correspondiente.

### 3.3 Componentes Principales y sus Responsabilidades

**Frontend (app.v2.js)**: Con más de 1800 líneas de JavaScript vanilla, este archivo contiene toda la lógica de la aplicación del lado del cliente. Maneja el estado global de la aplicación, la renderización de componentes, la interacción con el reproductor de audio, la comunicación con la API, y la gestión de eventos de usuario. Su arquitectura sigue un patrón de estado centralizado donde un objeto `state` contiene todas las variables reactivas, y funciones update/render mantienen la UI sincronizada.

**Backend (main.py)**: Implementa la API RESTful usando FastAPI, con endpoints para biblioteca, búsqueda, descargas, playlists, streaming de audio, y estadísticas. Usa Uvicorn como servidor ASGI, lo que permite manejo eficiente de múltiples conexiones concurrentes con un solo proceso.

**Base de Datos (database.py)**: Gestiona SQLite con modo WAL (Write-Ahead Logging) para permitir operaciones concurrentes sin bloqueos. Maneja tres tablas principales: tracks (metadatos de canciones), playlists (listas de reproducción), y playlist_tracks (relación muchos-a-muchos con posición).

**Downloader (downloader.py)**: Wrapper alrededor de spotdl y yt-dlp que añade tracking de progreso, manejo de errores, y coordinación con el sistema de notificaciones WebSocket. Corre como proceso asíncrono sin bloquear el servidor principal.

**Estilos (style.css)**: Más de 1200 líneas de CSS moderno usando variables CSS para theming, glassmorphism con backdrop-filter, gradientes complejos, y animaciones smooth. El diseño es completamente responsive y funciona en escritorio y móvil.

**Fondo Visual (bg.js)**: Implementa un sistema WebGL2 que crea un fondo atmosférico con partículas flotantes y efectos de audio-reacción. Usa shaders personalizados para crear profundidad y movimiento orgánico.

---

## 4. Tecnologías Utilizadas

### 4.1 Stack del Backend

**Python 3.11+**: El backend está escrito completamente en Python, aprovechando las capacidades async de versiones modernas del lenguaje para manejar múltiples conexiones concurrentes eficientemente. Python proporciona acceso a un ecosistema rico de librerías para prácticamente cualquier tarea imaginable.

**FastAPI**: Framework web moderno que combina la simplicidad de Flask con capacidades async nativas de primera clase. FastAPI genera automáticamente documentación Swagger/OpenAPI, permite validación automática de tipos con Pydantic, y ofrece rendimiento comparable a Node.js en muchos escenarios. Su diseño orientado a funciones asíncronas lo hace ideal para aplicaciones con muchas conexiones concurrentes como streaming y WebSockets.

**Uvicorn**: Servidor ASGI (Asynchronous Server Gateway Interface) de referencia que corre la aplicación FastAPI. Proveer un único proceso que maneja múltiples requests concurrentemente mediante event loops, significativamente más eficiente que servidores multi-proceso para I/O bound workloads como HTTP y WebSockets.

**SQLite**: Base de datos embebida que no requiere servidor separado, perfecta para aplicaciones autohospedadas donde la simplicidad de despliegue es prioridad. El modo WAL (Write-Ahead Logging) permite lecturas y escrituras concurrentes sin bloqueos, mientras que la simplicidad de un archivo único facilita backups.

**spotdl**: Herramienta de terceros que combina Spotify con YouTube, usando metadatos de Spotify para buscar y descargar audio desde YouTube. Es el motor que permite a NOVA ofrecer la funcionalidad de "buscar en Spotify, descargar desde YouTube".

**yt-dlp**: fork mantenido de youtube-dl que soporta cientos de sitios de video/audio además de YouTube. Proporciona la infraestructura de descarga para el modo YouTube de la búsqueda.

**mutagen**: Librería Python para lectura y escritura de metadatos ID3 en archivos de audio. Permite extraer título, artista, álbum, duración, y portadas embebidas de archivos MP3, FLAC, y otros formatos.

**aiofiles**: Extensión asíncrona para operaciones de I/O de archivos, permite al servidor servir archivos de audio sin bloquear el event loop principal.

**python-dotenv**: Carga variables de entorno desde archivos .env, simplifica la configuración sin hardcodear credenciales en el código.

### 4.2 Stack del Frontend

**HTML5**: Estructura semántica de la aplicación, usando elementos apropiados para cada sección (aside para sidebar, main para contenido, section para tabs, etc.).ARIA labels proporcionan accesibilidad para usuarios de screen readers.

**CSS3 Moderno**: El CSS aprovecha características recientes como custom properties (variables CSS), backdrop-filter para glassmorphism, grid y flexbox para layouts, calc() para cálculos dinámicos, y animation/transition para movimiento suave. No se usa preprocesador como Sass, reduciendo la cadena de build.

**Vanilla JavaScript (ES6+)**: La aplicación evita deliberadamente frameworks como React, Vue, Svelte, o Angular. Esto no es nostalgia; es una decisión pragmática. Sin frameworks, no hay dependencias de npm que mantener, no hay version mismatches, no hay virtual DOM overhead, y el debugging es más directo. El código usa async/await, arrow functions, destructuring, template literals, y otras características modernas del lenguaje.

**WebGL2**: El fondo visual usa WebGL2 con shaders GLSL personalizados. A diferencia de canvas 2D o CSS animations, WebGL permite efectos visuales complejos como partículas con física, distorsiones de imagen, y procesamiento de audio en GPU que serían imposible o muy lento en alternativas.

**Web Audio API**: Proveedor de análisis de frecuencia FFT para visualizadores y audio-reacción del fondo. Crea un AnalyserNode conectado al elemento de audio, proporcionando datos de frecuencia en tiempo real a 60fps.

**WebSockets**: Comunicación bidireccional con el servidor para actualizaciones en tiempo real de progreso de descargas. Permite que el usuario vea barras de progreso animándose sin polling.

**LocalStorage API**: Persistencia de preferencias del usuario (tema, volumen, EQ, shuffle, repeat, vista de biblioteca) entre sesiones del navegador.

### 4.3 Infraestructura de Despliegue

**nginx**: Servidor web y reverse proxy que acelera todo el tráfico. Configurado para servir archivos estáticos del frontend con cache de un año, proxy reverso hacia el backend FastAPI, y upgrade de WebSocket para conexiones en tiempo real.

**systemd**: Sistema de init de Linux que gestiona el servicio del servidor. Provee auto-start en boot, restart automático en crashes, logging con journalctl, y control via systemctl.

**Proxmox LXC**: Entorno de ejecución esperado. Los contenedores LXC son más eficientes que VMs completas porque comparten el kernel del host, permitiendo mayor densidad de servicios con menor overhead.

---

## 5. Componentes del Backend

### 5.1 main.py - API Principal

El archivo main.py contiene la implementación de FastAPI con todos los endpoints de la API REST:

**Endpoints de Biblioteca**:
- `GET /api/library` - Devuelve todos los tracks en la biblioteca
- `GET /api/library/search` - Búsqueda con query en la base de datos local
- `DELETE /api/library/{track_id}` - Elimina un track (archivo y base de datos)
- `GET /api/stream/{track_id}` - Stream de audio con soporte Range
- `GET /api/cover/{track_id}` - Devuelve la portada del album

**Endpoints de Búsqueda**:
- `GET /api/search` - Búsqueda en Spotify (usa spotipy)
- `GET /api/yt-search` - Búsqueda en YouTube (usa yt-dlp)
- `GET /api/yt-download` - Descarga desde YouTube dado URL

**Endpoints de Descargas**:
- `POST /api/download` - Inicia descarga de track de Spotify
- `GET /api/download/status/{job_id}` - Estado de un job específico
- `GET /api/download/jobs` - Lista todos los jobs

**Endpoints de Playlists**:
- `GET /api/playlists` - Lista todas las playlists
- `POST /api/playlists` - Crea nueva playlist
- `DELETE /api/playlists/{id}` - Elimina playlist
- `GET /api/playlists/{id}/tracks` - Tracks de una playlist
- `POST /api/playlists/{id}/tracks` - Agrega track a playlist
- `DELETE /api/playlists/{id}/tracks/{track_id}` - Remueve track
- `PUT /api/playlists/{id}/tracks/reorder` - Reordena tracks

**Endpoints Especiales**:
- `GET /api/stats` - Estadísticas de la biblioteca
- `POST /api/import/spotify-playlist` - Importa playlist de Spotify

**WebSocket**:
- `GET /ws/downloads` - Canal de progreso de descargas

### 5.2 database.py - Gestión de Datos

El módulo database.py implementa una capa de abstracción sobre SQLite con las siguientes características:

**Tabla Tracks**:
```sql
CREATE TABLE tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration INTEGER,  -- en segundos
    file_path TEXT NOT NULL,
    cover_path TEXT,
    spotify_id TEXT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Tabla Playlists**:
```sql
CREATE TABLE playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Tabla Playlist Tracks**:
```sql
CREATE TABLE playlist_tracks (
    playlist_id INTEGER,
    track_id INTEGER,
    position INTEGER,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (playlist_id, track_id)
);
```

**Funciones Principales**:
- `init_db()` - Inicializa las tablas si no existen
- `get_all_tracks()` - Devuelve todos los tracks
- `search_tracks(query)` - Búsqueda full-text en título, artista, álbum
- `add_track(metadata, file_path)` - Inserta nuevo track
- `delete_track(track_id)` - Elimina track y su archivo
- `get_playlists()` / `create_playlist(name)` / `delete_playlist(id)`
- `get_playlist_tracks(playlist_id)` - Tracks de playlist con posición
- `add_track_to_playlist(playlist_id, track_id)` - Agrega con posición
- `remove_track_from_playlist(playlist_id, track_id)`
- `reorder_playlist(playlist_id, track_ids)` - Actualiza posiciones

### 5.3 downloader.py - Motor de Descargas

El módulo downloader.py encapsula la complejidad de spotdl y yt-dlp:

**Clase DownloadManager**:
- `add_spotify_download(track_info)` - Añade job de Spotify
- `add_youtube_download(url, title, artist)` - Añade job de YouTube
- `process_queue()` - Loop principal que procesa jobs
- `_download_with_spotdl()` - Wrapper para spotdl
- `_download_with_ytdlp()` - Wrapper para yt-dlp

**Características**:
- Progress callback que se ejecuta cada segundo
- Manejo de errores con retry automático (3 intentos)
- Cleanup de archivos parciales en caso de falla
- Extracción de metadatos post-download para actualizar DB

**Integración con WebSocket**:
- El downloader no se ejecuta en el proceso principal
- Usa un sistema de callbacks que envía mensajes al WebSocket
- El frontend recibe actualizaciones de estado en tiempo real

---

## 6. Estructura del Frontend

### 6.1 app.v2.js - Lógica Principal

El archivo JavaScript principal sigue una arquitectura de estado centralizado:

**Estado Global**:
```javascript
const state = {
  activeTab: 'search',
  searchResults: [], searchQuery: '', searchMode: 'spotify',
  library: [], libraryView: 'grid', libraryFilter: '',
  selectedTracks: new Set(),
  playlists: [], activePlaylistId: null,
  queue: [], queueIndex: -1, shuffle: false, repeat: 'none',
  currentTrack: null, isPlaying: false,
  transitionType: 'none', transitionDuration: 3,
  downloads: new Map(), dlPanelOpen: false,
  queueDrawerOpen: false,
  nowPlayingOpen: false,
  likedTracks: new Set(),
  theme: 'dark',
  ws: null,
  playHistory: [],
};
```

**Funciones Principales**:

*Navegación*:
- `switchTab(tabName)` - Cambia entre Search/Library/Playlists
- Manejo de keyboard shortcuts (1,2,3 para tabs, Space para play)

*Reproducción*:
- `playTrack(track, contextQueue)` - Reproduce track con contexto
- `playNext()` / `playPrev()` - Navegación de cola
- `togglePlay()` - Play/Pause
- `toggleShuffle()` / `toggleRepeat()` - Modos de reproducción
- `queueTracks(tracks)` / `queueNext(track)` / `removeFromQueue(index)`
- `seekFromEvent(e, trackElem)` - Manejo de scrubber de progreso

*Biblioteca*:
- `loadLibrary()` - Carga tracks desde API
- `renderLibrary(tracks)` - Renderiza grid o lista
- `filterLibrary(query)` - Búsqueda con debounce
- `toggleTrackSelection(id)` - Selección múltiple

*Playlists*:
- `loadPlaylists()` - Carga playlists desde API
- `renderPlaylistSidebar()` / `renderPlaylistDetail(id)`
- `addTracksToPlaylist(playlistId, trackIds)`
- `removeTrackFromPlaylist(playlistId, trackId)`
- `setupPlaylistDragAndDrop()` - Reordenamiento

*Descarga*:
- `handleDownload(btn)` - Inicia descarga
- `renderDownloadPanel()` - Renderiza panel
- `processDownloadJob(job)` - Procesa updates WebSocket

*UI/UX*:
- `toast(message, type, duration)` - Notificaciones
- `showModal(config)` / `closeModal()` - Diálogos
- `showContextMenu(x, y, items)` / `hideContextMenu()`
- `extractColorAndApply(imgEl)` - Color dinámico de portadas
- `drawVisualizers()` - Canvas spectrum y waveform
- `applyDynamicTheme(primary, secondary)` - Theming

### 6.2 index.html - Estructura

La estructura HTML sigue una semántica clara:

```html
<!-- WebGL Background -->
<canvas id="bg-canvas">

<!-- App Container -->
<div id="app">

  <!-- Sidebar -->
  <aside id="sidebar">
    <div class="sidebar-brand">NOVA</div>
    <nav class="nav-items">
      <div class="nav-item" data-tab="search">Search</div>
      <div class="nav-item" data-tab="library">Library</div>
      <div class="nav-item" data-tab="playlists">Playlists</div>
    </nav>
    <div class="sidebar-footer">
      <button id="dl-toggle-btn">Downloads</button>
      <button id="theme-toggle-btn">Theme</button>
      <div id="stats-text">Loading...</div>
    </div>
  </aside>

  <!-- Main Content -->
  <main id="main">
    <!-- Search Tab -->
    <section id="tab-search" class="tab-panel active">
      <!-- Search input, mode toggle, results -->
    </section>

    <!-- Library Tab -->
    <section id="tab-library" class="tab-panel">
      <!-- View toggle, search, tracks grid/list -->
    </section>

    <!-- Playlists Tab -->
    <section id="tab-playlists" class="tab-panel">
      <!-- Playlist sidebar + detail -->
    </section>
  </main>

  <!-- Player Bar (fixed bottom) -->
  <footer id="player">
    <div class="player-track">
      <div class="player-cover-wrap">...</div>
      <div class="player-info">...</div>
      <button class="player-like">...</button>
    </div>
    <div class="player-controls">
      <!-- prev, play/pause, next, shuffle, repeat -->
      <!-- progress bar, time display -->
    </div>
    <div class="player-extra">
      <!-- volume, queue, now playing, eq, transition -->
    </div>
  </footer>

  <!-- Overlays -->
  <div id="now-playing-overlay">...</div>
  <div id="queue-drawer">...</div>
  <div id="download-panel">...</div>
  <div id="eq-panel">...</div>
  <div id="transition-popover">...</div>
  <div id="context-menu">...</div>
  <div id="modal-overlay">...</div>
  <div id="toast-container">...</div>
  <div id="kbd-help-overlay">...</div>
</div>

<!-- Audio Elements (hidden) -->
<audio id="audio-element">
<audio id="audio-element-2">
```

### 6.3 style.css - Sistema de Estilos

El CSS está organizado en secciones claramente marcadas:

**Variables CSS (根部)**:
- Colores (accent, background, text, surface, etc.)
- Border radius
- Transitions timing
- Glass effect properties

**Layout**:
- Sidebar (224px fixed)
- Main (flex, fills remaining)
- Player (96px fixed bottom)
- Overlay modals (full screen with backdrop)

**Glassmorphism**:
```css
.glass {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
```

**Componentes**:
- Track rows (grid/list)
- Album cards (with 3D tilt effect)
- Buttons (primary, ghost, danger, icon)
- Inputs (search, modal)
- Modals, toasts, context menus

**Animations**:
- Fade in/out para overlays
- Ripple effect en botones
- Playing bars animation
- Spectrum visualizer bars

### 6.4 bg.js - Fondo WebGL

El módulo de fondo implementa un sistema de partículas con características avanzadas:

**Inicialización**:
- Crea WebGL2 context del canvas
- Compila vertex y fragment shaders
- Genera initial particle positions

**Shaders**:
- Vertex shader maneja posición y tamaño de partículas
- Fragment shader maneja color y alpha (gradients)
- Uniforms reciben tiempo y datos de audio

**Loop de Animación**:
- requestAnimationFrame a 60fps
- Actualiza posiciones de partículas (drift suave)
- Lee datos de audio del AnalyserNode
- Modula brillo/tamaño de partículas basado en frecuencia
- Renderiza frame completo

**Audio Reactivity**:
- Extrae frequency data del Web Audio API
- Aplica smoothing para evitar flicker
- Mapea rangos de frecuencia a diferentes efectos
- Bass frequencies hacen partículas más grandes
- Treble frequencies aumentan brillo

---

## 7. Diseño Visual y UI/UX

### 7.1 Filosofía de Diseño

El diseño de NOVA sigue el principio de que las aplicaciones autohospedadas no tienen por qué parecer anticuadas. Cada elemento visual ha sido cuidadosamente considerado para crear una experiencia que compite con las mejores aplicaciones comerciales:

**Glassmorphism Moderno**: Las superficies translúcidas con desenfoque de fondo no son solo un efecto visual; proporcionan jerarquía visual clara mientras mantienen la sensación de profundidad y conexión con el contenido visual subyacente. El fondo WebGL se ve a través de los elementos de UI, creando una experiencia cohesiva.

**Espaciado Generoso**: El uso de whitespace abundante reduce la carga cognitiva y hace que la interfaz sea más fácil de escanear visualmente. Los elementos no compiten por atención; cada componente tiene espacio para respirar.

**Feedback Visual**: Cada interacción del usuario produce respuesta visual inmediata. Los botones tienen hover states, las transiciones tienen duración apropiada, y las acciones asíncronas muestran indicadores de progreso. El usuario siempre sabe qué está pasando.

**Tipografía Distintiva**: La combinación de Syne (geometric, moderna) con DM Sans (legible, neutral) crea una identidad visual única. Los headings usan Syne para personalidad, el texto de lectura usa DM Sans para claridad.

### 7.2 Sistema de Colores

El sistema de colores tiene dos niveles:

**Colores Estáticos** (definidos en CSS):
```css
--accent: #7C3AFF;          /* Púrpura principal */
--accent-bright: #9D6FFF;   /* Más claro para hovers */
--accent-dim: #4A1FBF;      /* Más oscuro para borders */
--cyan: #00D4FF;            /* Acento secundario */
--rose: #FF4757;            /* Para likes/errores */
--success: #2ED573;         /* Para confirmaciones */
```

**Colores Dinámicos** (extraídos de portadas):
Cuando se carga una canción con portada, el sistema:
1. Crea un canvas de 150x150
2. Dibuja la imagen redimensionada
3. Lee los datos de pixel
4. Agrupa colores similares (cuantización)
5. Filtra colores no deseados (muy oscuros, muy claros, desaturados)
6. Selecciona el color primario (más frecuente, mejor balanceado)
7. Aplica el color a variables CSS dinámicas
8. Actualiza el fondo del overlay Now Playing

### 7.3 Navegación y Pestañas

El sistema de navegación usa tres pestañas principales:

**Search (Pestaña 1)**:
- Campo de búsqueda con detección automática de URLs
- Toggle Spotify/YouTube para modo de búsqueda
- Resultados en lista con thumbnails, títulos, artistas, duración
- Botones de descarga en cada resultado
- Click en resultado reproduce si ya está descargado

**Library (Pestaña 2)**:
- Toggle grid/list view
- Campo de búsqueda con filtering en tiempo real
- Grid: Album cards con cover, título, artista
- List: Track rows con más metadatos
- Soporte de selección múltiple
- Click en track reproduce, long-press o right-click da opciones

**Playlists (Pestaña 3)**:
- Sidebar con lista de playlists
- Área de detalle cuando una playlist está seleccionada
- Tracks de la playlist con drag & drop reordering
- Play All button
- Opciones de eliminar tracks

### 7.4 Reproductor Fijo

El reproductor en la parte inferior siempre visible incluye:

**Sección Izquierda**:
- Cover art (58x58px con placeholder)
- Título de canción (truncado con ellipsis)
- Artista (truncado)
- Botón de like (agrega a playlist)

**Sección Central**:
- Botones de control: Previous, Play/Pause, Next
- Shuffle y Repeat (con indicador de estado)
- Progress bar con scrubber
- Tiempo actual / Duración total

**Sección Derecha**:
- Control de volumen con slider
- Botón de mute
- Botón de cola de reproducción
- Botón de Now Playing (overlay fullscreen)
- Botón de EQ
- Botón de configuración de transición

### 7.5 Atajos de Teclado

NOVA implementa un sistema comprehensivo de atajos de teclado:

| Atajo | Acción |
|-------|--------|
| `Space` | Play/Pause |
| `←` / `→` | Seek -5s / +5s |
| `Shift+←` / `Shift+→` | Previous / Next track |
| `M` | Mute/Unmute |
| `F` | Like/Unlike track |
| `Ctrl+F` | Focus campo de búsqueda |
| `1` | Ir a Search |
| `2` | Ir a Library |
| `3` | Ir a Playlists |
| `?` | Mostrar ayuda de atajos |
| `Esc` | Cerrar overlay actual |

### 7.6 Overlays y Paneles

**Now Playing Overlay**: Vista fullscreen con cover grande, información de track, spectrum visualizer, controls completos, y progress bar.

**Queue Drawer**: Panel lateral que muestra la cola de reproducción actual, permite reordenar y eliminar tracks.

**Download Panel**: Panel de descargas con lista de jobs, progress bars, y estados (downloading, done, error).

**EQ Panel**: Panel de ecualizador con 10 bandas de frecuencia, presets (Flat, Bass, Treble, Rock, Jazz, Pop, Classical), y sliders individuales.

**Transition Popover**: Configuración de tipo de transición (none, fade, crossfade) y duración.

---

## 8. Sistema de Reproducción de Audio

### 8.1 Arquitectura de Reproducción

NOVA usa una arquitectura de reproducción dual que permite transiciones sofisticadas:

**Dos Elementos de Audio**:
- `audio-element`: El reproductor "activo" actualmente
- `audio-element-2`: El reproductor "inactivo" para crossfade

Cuando una canción termina y comienza la siguiente:
- Si crossfade está habilitado y la canción actual está reproduciéndose
- Se swap los elementos activo/inactivo
- La nueva canción se carga en el elemento activo
- Se ejecuta el crossfade (fade in nuevo, fade out antiguo)

**Web Audio API Integration**:
```javascript
audioCtx = new AudioContext();
analyser = audioCtx.createAnalyser();
analyser.fftSize = 256;

source1 = audioCtx.createMediaElementSource(audio);
source2 = audioCtx.createMediaElementSource(audio2);

source1.connect(analyser);
source2.connect(analyser);

// EQ chain
analyser.connect(eqFilters[0]);
// ... filters ...
eqFilters[last].connect(audioCtx.destination);
```

### 8.2 Modos de Reproducción

**Normal**: Reproduce las canciones en orden secuencial según la cola. Cuando llega al final, se detiene o reinicia según el setting de repeat.

**Shuffle**: Aleatoriza el orden de reproducción. El algoritmo evita que la misma canción se seleccione dos veces consecutivas:

```javascript
if (state.shuffle && state.queue.length > 1) {
  let nextIdx = state.queueIndex;
  while(nextIdx === state.queueIndex) {
    nextIdx = Math.floor(Math.random() * state.queue.length);
  }
  state.queueIndex = nextIdx;
}
```

**Repeat Three States**:
1. `none`: Reproduce la cola una vez, se detiene al final
2. `all`: Reproduce la cola en loop无限amente
3. `one`: Repite la canción actual infinitamente

### 8.3 Cola de Reproducción

La cola es una estructura de datos simple con índice:

```javascript
state.queue = [track1, track2, track3, ...];
state.queueIndex = 0; // Índice de la canción actual
```

**Operaciones**:
- `queueTracks(tracks)`: Reemplaza la cola con nuevo array
- `queueNext(track)`: Inserta después de la canción actual
- `removeFromQueue(index)`: Elimina canción en índice
- `playTrack(track, contextQueue)`: Reproduce con contexto

### 8.4 Crossfade Engine

El crossfade permite transiciones suaves entre canciones:

```javascript
if (transitionType === 'crossfade' && isPlaying) {
  // Swap
  const temp = activeAudio;
  activeAudio = inactiveAudio;
  inactiveAudio = temp;

  activeAudio.src = streamUrl;
  activeAudio.volume = 0;
  activeAudio.play().then(() => {
    // Fade in
    const step = targetVolume / (duration * 20);
    const crossfadeIn = setInterval(() => {
      volume += step;
      if (volume >= targetVolume) {
        activeAudio.volume = targetVolume;
        clearInterval(crossfadeIn);
      }
    }, 50);

    // Fade out old
    const oldStep = oldVolume / (duration * 20);
    const crossfadeOut = setInterval(() => {
      oldVolume -= oldStep;
      if (oldVolume <= 0) {
        inactiveAudio.pause();
        inactiveAudio.volume = 0;
        clearInterval(crossfadeOut);
      }
    }, 50);
  });
}
```

### 8.5 Visualización de Audio

El sistema proporciona dos tipos de visualización:

**Mini Spectrum (Player Bar)**:
- Canvas de 200x24 pixels
- 40 bars representando bins de frecuencia
- Colores based en intensity (accent-bright para normal, cyan para peak)
- Actualizado a 60fps via requestAnimationFrame

**Full Spectrum (Now Playing Overlay)**:
- Canvas responsive (ancho del container, 60px alto)
- 64 bars con gradient fill (accent a cyan)
- Same FFT data que mini spectrum
- Efecto más elaborado por mayor espacio

**Waveform Progress**:
- Canvas de 6px de alto en el progress bar
- dibuja forma de onda del audio
- Muestra progreso como línea fill desde la izquierda
- Proporciona indicación visual del contenido de audio

---

## 9. Gestión de Biblioteca y Metadatos

### 9.1 Estructura de la Biblioteca

La biblioteca musical se almacena en `/music/` del contenedor (que puede ser un bind mount a un NAS o almacenamiento local). El sistema escanea recursivamente este directorio buscando archivos de audio compatibles.

**Formatos Soportados**:
- MP3 (más común, mejor soporte de metadata)
- FLAC (lossless, mayor tamaño)
- M4A/AAC (común en compras de iTunes)
- OGG (menos común pero soportado)

**Estructura de Archivos**:
```
/music/
├── Artist Name/
│   ├── Album Name/
│   │   ├── 01 - Song Title.mp3
│   │   ├── 02 - Another Song.mp3
│   │   ├── cover.jpg
│   │   └── folder.jpg
│   └── Another Album/
│       └── ...
└── Various Artists/
    └── ...
```

### 9.2 Extracción de Metadatos

Cuando el servidor inicia, ejecuta un escaneo que para cada archivo de audio:

1. Lee los metadatos ID3 usando mutagen
2. Extrae: título, artista, álbum, duración, número de pista
3. Intenta extraer portada embebida (Priority 1)
4. Si no hay portada embebida, busca archivos adyacentes:
   - cover.jpg, cover.png, folder.jpg, album.jpg (Priority 2)
5. Genera una ruta relativa para storage en DB
6. Inserta el registro en la tabla tracks

**La extracción de metadata es determinista**: el mismo archivo siempre producirá los mismos metadatos, lo que permite re-escaneos sin duplicados usando UPSERT logic.

### 9.3 Sistema de Portadas

El sistema de portadas tiene múltiples fallback:

```
Priority 1: Metadatos embebidos
    └── [Track.cover] - si existe en ID3 tags

Priority 2: Archivos adyacentes
    └── /music/Artist/Album/cover.jpg
    └── /music/Artist/Album/folder.jpg

Priority 3: API del servidor
    └── /api/cover/{track_id} - devuelve placeholder
```

El endpoint `/api/cover/{track_id}`:
1. Busca `cover_path` en la base de datos
2. Si existe y el archivo es accesible, lo sirve
3. Si no, devuelve un SVG placeholder con nota musical

### 9.4 Búsqueda en Biblioteca

La búsqueda local permite filtrar por:
- Título de canción
- Nombre de artista
- Nombre del álbum

Usa una combinación de filtering client-side y server-side:
- Si la query tiene menos de 2 caracteres, usa filtering client-side sobre todos los tracks cargados
- Si tiene 2+ caracteres, hace request al endpoint `/api/library/search` que ejecuta SQL LIKE query

### 9.5 Vistas de Biblioteca

**Vista Grid**:
- Muestra Album cards con cover grande
- Título y artista debajo
- Efecto 3D tilt en hover
- Click reproduce la canción

**Vista List**:
- Muestra Track rows como una tabla
- Cover pequeño, título, artista, duración
- Más información visible sin hover
- Click reproduce, right-click da opciones

La vista se persiste en localStorage:
```javascript
localStorage.setItem('nova_library_view', state.libraryView);
```

---

## 10. Sistema de Descargas

### 10.1 Flujo de Descarga

El sistema de descargas sigue un flujo asíncrono:

1. **Inicio**: Usuario hace click en "Download" en un resultado de búsqueda
2. **Request**: Frontend envía POST a `/api/download` con track metadata
3. **Respuesta**: Backend responde inmediatamente con job_id
4. **Cola**: El downloader añade el job a su cola de procesamiento
5. **Progreso**: Mientras descarga, envía updates via WebSocket
6. **Completado**: Cuando termina, marca como "done", guarda en DB
7. **Notificación**: Frontend muestra toast notification

### 10.2 Modos de Descarga

**Desde Spotify**:
- El usuario busca en Spotify (metadatos ricos)
- Selecciona una canción para descargar
- El backend usa spotdl que:
  - Toma el ID de Spotify de la canción
  - Busca en YouTube el video correspondiente
  - Descarga el audio (m4a o mp3)
  - Extrae metadata de Spotify y embeber en archivo
  - Guarda en /music/

**Desde YouTube**:
- El usuario busca en YouTube
- Selecciona un video para descargar
- El backend usa yt-dlp que:
  - Descarga el video
  - Extrae solo el audio
  - Guarda como mp3
  - Metadatos del título del video

**Desde URL Directa**:
- El usuario pega una URL de Spotify o YouTube
- El sistema detecta el tipo de URL
- Ejecuta la descarga correspondiente

### 10.3 Progress Tracking

El WebSocket `/ws/downloads` proporciona updates de progreso:

```javascript
{
  "id": "job_123",
  "title": "Song Name",
  "artist": "Artist Name",
  "cover_url": "https://...",
  "progress": 45,  // 0-100
  "status": "downloading" | "processing" | "done" | "error",
  "error": "optional error message"
}
```

El frontend renderiza el panel de descargas con estas actualizaciones en tiempo real.

### 10.4 Panel de Descargas

Accesible desde la sidebar, muestra:
- Lista de todos los jobs (ordenados por más recientes)
- Cover thumbnail
- Título y artista
- Progress bar
- Estado text (downloading %, processing, complete, error)
- Para jobs completados, botón para agregar a playlist

---

## 11. Playlists y Colaboración

### 11.1 Gestión de Playlists

El sistema de playlists permite:

**Crear Playlist**:
- Click en "New Playlist" en la pestaña Playlists
- Ingresa nombre en el input que aparece
- Enter para confirmar, ESC para cancelar

**Ver Playlist**:
- Click en una playlist en la sidebar
- Carga los tracks de esa playlist en el área de detalle
- Muestra número de tracks, duración total

**Reproducir Playlist**:
- Click en "Play All" reproduce todas las canciones
- La cola se pobla con los tracks de la playlist
- Reproducción comienza automáticamente (tras fix)

**Eliminar Playlist**:
- Click en el ícono de trash en el item de playlist
- Pide confirmación en modal
- Elimina la playlist y sus relaciones en DB

### 11.2 Agregar Tracks a Playlist

**Desde Library**:
1. Selectiona uno o más tracks (checkbox o Ctrl+click)
2. Click en "Add to Playlist" en la selection bar
3. Aparece el submenu con lista de playlists
4. Click en la playlist destino
5. Los tracks se agregan a esa playlist

**Desde Context Menu**:
1. Right-click en un track en la library
2. Selecciona "Add to playlist..."
3. Same submenu de playlists

**Desde Search (descargado)**:
1. Una vez que la canción se descarga y está en library
2. Mismo proceso que desde library

### 11.3 Reordenamiento de Playlists

NOVA soporta drag & drop para reordenar tracks en una playlist:

1. Los items de track son draggable
2. Al hacer drop sobre otro track, reordena
3. El frontend actualiza el DOM inmediatamente
4. Envía PUT a `/api/playlists/{id}/tracks/reorder` con el nuevo orden
5. El backend actualiza las posiciones en la DB

### 11.4 Importar desde Spotify

NOVA puede importar playlists públicas de Spotify:

1. Usuario click en "Import Playlist"
2. Pega la URL de la playlist de Spotify
3. Confirma
4. El backend:
   - Descarga la lista de tracks de Spotify
   - Crea una nueva playlist en la DB
   - Para cada track, intenta descargar desde YouTube
   - Reporta progreso de importación
5. La playlist aparece en NOVA lista para reproducir

---

## 12. Persistencia de Datos

### 12.1 Base de Datos SQLite

La base de datos se guarda en `/music/library.db` (en el directorio de música) para facilitar backups. Usa modo WAL que permite lecturas concurrentes incluso mientras hay escrituras.

**Inicialización**: Al primer inicio, el backend crea las tablas si no existen y hace un escaneo inicial de todos los archivos de audio en /music/.

**Mantenimiento**: No requiere mantenimiento regular. SQLite maneja la limpieza internamente. El archivo de la base puede grow con el uso pero raramente necesita compactación.

### 12.2 LocalStorage del Frontend

El navegador del usuario guarda preferencias en localStorage:

| Key | Descripción | Default |
|-----|-------------|---------|
| `nova_theme` | Tema claro/oscuro | "dark" |
| `nova_vol` | Volumen del player (0-100) | 80 |
| `nova_eq_state` | Estado del EQ (preset + valores) | null |
| `nova_trans_type` | Tipo de transición | "none" |
| `nova_trans_dur` | Duración de transición (segundos) | 3 |
| `nova_shuffle` | Estado de shuffle | false |
| `nova_library_view` | Vista grid/list | "grid" |

### 12.3 Carga Inicial

Cuando la página carga:

1. `loadTheme()`: Aplica tema desde localStorage
2. Carga volumen inicial (default 80 si no hay)
3. Carga estado de shuffle y repeat
4. Carga vista de library
5. Carga estado de EQ (si existe)
6. Carga preferencias de transición

Esto garantiza que el usuario ve la interfaz exactamente como la dejó.

---

## 13. Seguridad y Despliegue

### 13.1 Modelo de Usuario

El servicio corre bajo un usuario dedicado `musicserver`:

```ini
[Service]
User=musicserver
Group=musicserver
```

Este usuario:
- No tiene acceso sudo
- Solo tiene permisos de lectura en /opt/music-server
- Tiene permisos de lectura/escritura en /music
- No puede modificar archivos del sistema

### 13.2 Hardening de systemd

El servicio tiene múltiples protecciones:

```ini
[Service]
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ProtectHome=true
```

- `NoNewPrivileges`: Previene que el proceso obtiene privilegios adicionales
- `ProtectSystem=strict`: Monta /usr, /boot, /etc como solo lectura
- `PrivateTmp`: Aísla /tmp del proceso
- `ProtectHome`: Oculta /home del proceso

### 13.3 Recomendaciones de Seguridad

**No Exponer a Internet Directamente**: El servidor no tiene autenticación por defecto. Si lo expones a Internet, cualquiera puede acceder.

**Usar VPN**: La forma recomendada de acceso remoto es via VPN (Tailscale, WireGuard, OpenVPN). Crea un túnel a tu red doméstica y accede via la IP interna.

**HTTP Basic Auth (Opcional)**: Si necesitas acceso sin VPN, agrega HTTP basic auth en nginx:

```nginx
location / {
    auth_basic "NOVA Music Server";
    auth_basic_user_file /etc/nginx/.htpasswd;
    # ... rest of config
}
```

**Mantener Actualizado**: Actualiza regularmente el contenedor:
```bash
apt update && apt upgrade
```

### 13.4 Permisos de Archivos

**Música**: El usuario musicserver debe poder leer todos los archivos de música. Si usas un bind mount desde el host, asegura que los permisos permitan acceso.

**Directorio de Aplicación**: Solo musicserver necesita acceso de lectura. Otros usuarios pueden tener acceso de lectura a los archivos estáticos (frontend) si sirven via nginx.

---

## 14. Instalación y Configuración

### 14.1 Requisitos

**Hardware (LXC)**:
- OS: Debian 12 o Ubuntu 22.04 LTS
- RAM: 1GB mínimo, 2GB recomendado
- CPU: 1 core mínimo, 2 recomendados
- Disk: 10GB para OS + almacenamiento para música

**Software del Host**:
- Proxmox (cualquier versión reciente)
- Acceso a internet para descargar dependencias

### 14.2 Pasos de Instalación

1. **Crear LXC**: En Proxmox UI, crear contenedor Debian 12 con 2GB RAM, 20GB disk

2. **Subir Archivos**: Copiar install.sh, nginx.conf, music-server.service al contenedor
   ```bash
   pct push 100 install.sh /root/
   ```

3. **Ejecutar Instalador**:
   ```bash
   chmod +x /root/install.sh
   bash /root/install.sh
   ```

4. **Configurar Spotify**: Obtener Client ID/Secret de developer.spotify.com y configurar via systemctl edit o .env

5. **Acceder**: Navegar a la IP del contenedor en el navegador

### 14.3 Configuración de Almacenamiento

**Opción A - Bind Mount (Recomendado)**:
En el Proxmox host:
```bash
pct set 100 -mp0 /mnt/nas/music,mp=/music
```
El directorio del host se mapea directamente al contenedor.

**Opción B - NFS/CIFS**:
Inside container:
```bash
# NFS
apt install nfs-common
echo "nas.local:/exports/music /music nfs defaults,_netdev 0 0" >> /etc/fstab
mount -a

# CIFS
apt install cifs-utils
echo "//nas.local/music /music cifs credentials=/root/.smbcreds,_netdev 0 0" >> /etc/fstab
mount -a
```

---

## 15. Resolución de Problemas

### 15.1 El Servicio No Inicia

**Síntoma**: `systemctl status music-server` muestra failed

**Causas posibles**:
- Puerto 8000 ocupado: `ss -tlnp | grep 8000`
- FastAPI app no encontrada: Verificar path en main.py
- Paquetes pip faltantes: Re-run install.sh
- Archivo .env faltante o malformado

**Solución**:
```bash
journalctl -u music-server -n 50 --no-pager
```

### 15.2 nginx 502 Bad Gateway

**Síntoma**: La página web no carga, nginx retorna 502

**Causa**: El backend no está corriendo

**Solución**:
```bash
systemctl status music-server
systemctl restart music-server
```

### 15.3 Descargas Fallan

**Síntoma**: Las descargas no completan, stuck en downloading

**Causas posibles**:
- spotdl/yt-dlp no instalado correctamente
- Credenciales de Spotify faltantes o incorrectas
- Sin espacio en disco
- YouTube bloqueado (geo-restricción)

**Solución**:
```bash
# Verificar credenciales
systemctl show music-server | grep SPOTIPY

# Verificar spotdl
sudo -u musicserver /opt/music-server/venv/bin/spotdl --version
```

### 15.4 Archivos No Aparecen en Library

**Síntoma**: Tengo archivos en /music pero no aparecen en la UI

**Causas posibles**:
- Permisos incorrectos: `ls -la /music`
- Formato no soportado
- El escaneo aún no corrió

**Solución**:
```bash
chown -R musicserver:musicserver /music
# Restart el servicio
systemctl restart music-server
```

---

## 16. Características Avanzadas

### 16.1 Ecualizador

El ecualizador de 10 bandas permite ajuste fino del sonido:

**Frecuencias**: 60Hz, 170Hz, 310Hz, 600Hz, 1kHz, 3kHz, 6kHz, 12kHz, 14kHz, 16kHz

**Presets**:
- Flat: Sin cambios
- Bass: +6dB en graves, reduce agudos
- Treble: Lo inverso de Bass
- Rock: V-shape con boost en graves y agudos
- Jazz: Similar a Rock pero más sutil
- Pop: Boost en medios, reducción en extremos
- Classical: U-shape con ambiente

**Persistencia**: Los ajustes del EQ se guardan en localStorage automáticamente cuando se cambia un preset o se mueve un slider.

### 16.2 Transiciones de Reproducción

**None**: La canción nueva comienza inmediatamente cuando termina la anterior

**Fade**: La canción actual hace fade out mientras la nueva hace fade in. Configurable de 1-10 segundos.

**Crossfade**: Similar a fade pero las dos canciones overlap. Usado por muchos servicios de streaming comerciales.

### 16.3 Color Dinámico de Portadas

Cuando una canción con portada se reproduce:
1. La imagen se carga en un canvas de 150x150
2. Se extraen los pixels
3. Se filtran colores no deseados (muy oscuros, muy claros, desaturados)
4. Se cuantizan colores similares
5. Se selecciona el color primario (más frecuente y bien balanceado)
6. Se aplica a variables CSS dinámicas:
   - `--dynamic-accent`
   - `--dynamic-glow`
   - Colores de accent del theme
7. El fondo del overlay Now Playing se actualiza

### 16.4 Notificaciones de Escritorio

Cuando una descarga completa y el navegador tiene permisos, se envía una notificación del sistema operativo:
```javascript
new Notification(`♪ ${title}`, {
  body: artist || 'Download complete',
  icon: coverUrl,
  tag: 'nova-download'
});
```

---

## 17. Comparación con Alternativas

### 17.1 vs. Servicios de Streaming Comerciales

| Aspecto | NOVA | Spotify/Apple Music |
|---------|------|---------------------|
| Costo | Gratis (solo hardware) | $10-15/mes |
| Biblioteca | Ilimitada | Limitada a catálogo |
| Metadatos | Los tuyos | Los de Spotify |
| Offline | Local | Cacheo temporal |
| Privacidad | Total | Recopilan datos |
| Actualizaciones | Cuando quieras | Cuando ellos quieran |
| Formato | Cualquiera | Solo sufijo propietarios |

### 17.2 vs. Otros Servidores de Música Autohospedados

| Aspecto | NOVA | Navidrome | Koel | Ampache |
|---------|------|-----------|------|---------|
| UI Moderna | ★★★★★ | ★★☆☆☆ | ★★★★☆ | ★☆☆☆☆ |
| Búsqueda Spotify | ★★★★★ | ★★☆☆☆ | ★★☆☆☆ | ★☆☆☆☆ |
| YouTube DL | ★★★★★ | ★★☆☆☆ | ★☆☆☆☆ | ★★★☆☆ |
| WebGL | ★★★★★ | ★☆☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ |
| Ecualizador | ★★★★★ | ★★☆☆☆ | ★★★☆☆ | ★★☆☆☆ |
| Velocidad | ★★★★★ | ★★★★★ | ★★★☆☆ | ★★☆☆☆ |
| Mantenimiento | Bajo | Bajo | Medio | Alto |

### 17.3 Por Qué Elegir NOVA

- **UI excepcional**: La más bonita entre servidores autohospedados
- **Integración YouTube**: La única con búsqueda y descarga nativa
- **Features modernos**: EQ, crossfade, visualizers, color dinámico
- **Código simple**: Vanilla JS, sin frameworks, fácil de modificar
- **Eficiente**: Corre en un LXC con 2GB RAM

---

## 18. Futuro y Hoja de Ruta

### 18.1 Potenciales Mejoras

**Características Possibles**:
- Importación de playlists desde Apple Music
- Sincronización de progreso entre dispositivos
- Casting a dispositivos Chromecast/AirPlay
- Last.fm scrobbling
- Lyrics (desde archivos LRC o API)
- Radio (streams de internet)
- Mode de podcast (audiobooks, podcasts)
- Mejoras de sonido (replay gain, normalization)
- API pública para integración con Home Assistant

**Mejoras de UI**:
- Tabs adicionales (favorites, recently played)
- Drag & drop en library
- Bulk metadata editing
- Queue de favoritos
- Mini player opcional
- PWA (Progressive Web App) para offline

### 18.2 Contribuciones

El proyecto es open source y las contribuciones son bienvenidas:
- Reportar bugs en GitHub issues
- Sugerir features
- Pull requests con fixes o mejoras
- Documentación y traducciones

---

## 20. Características Recientes (v1.1.0)

### 20.1 Mejoras en Búsqueda

- **Spotify + YouTube Híbrido**: Búsqueda en Spotify con fallback automático a YouTube cuando no hay resultados o credenciales no configuradas
- **spotipy Integration**: Uso de la API oficial de Spotify para búsquedas más confiables
- Encoding mejorado en la interfaz

### 20.2 Sistema de Upload

- **Subir archivos directamente**: Los usuarios pueden subir archivos de audio desde el navegador
- Formatos soportados: MP3, FLAC, M4A, OGG, WAV, OPUS, WebM, AAC
- Límite de 100MB por archivo
- Extracción automática de metadatos y portada

### 20.3 Exploración por Carpetas

- **Explorador de carpetas**: Ver estructura de carpetas en `/music/`
- **Reproducir álbum completo**: Nueva opción en el menú contextual para reproducir todas las canciones de un álbum
- Navegación por carpetas desde la API

### 20.4 Estadísticas Mejoradas

- Conteo de artistas y álbumes
- Duración formateada (horas y minutos)
- Tamaño total formateado (B, KB, MB, GB)

### 20.5 Nuevas Dependencias

- `python-multipart`: Para subida de archivos
- `spotipy`: API oficial de Spotify

---

## 19. Licencia y Consideraciones Legales

### 19.1 Licencia

El código de NOVA está disponible bajo licencia MIT. Esto significa que puedes usar, modificar, y distribuir el software libremente, incluso para proyectos comerciales, siempre que incluyas la licencia original.

### 19.2 Consideraciones Legales

**spotdl/ytdlp**: Estas herramientas usan YouTube como fuente de audio, lo cual puede violar los Términos de Servicio de YouTube. La descarga de contenido con derechos de autor sin permiso puede ser ilegal en ciertas jurisdicciones.

**Uso Personal**: Esta herramienta está diseñada para uso personal. No debe usarse para:
- Distribución de contenido con derechos de autor
- Descarga masiva de contenido protegido
- Cualquier propósito comercial

**Responsabilidad**: El usuario es responsable de cumplir con las leyes locales y los términos de servicio de las plataformas utilizadas.

**Spotify**: La API de Spotify permite acceso a metadatos para uso personal. Asegúrate de usar tus propias credenciales de desarrollador y no compartir claves.

---

## Apéndice: Glosario

- **Backend**: El código del servidor que maneja datos, API, descargas
- **Frontend**: El código del navegador que muestra la UI
- **LXC**: Linux Containers - tecnología de virtualización ligera
- **Proxmox**: Plataforma de virtualización open source
- **SQLite**: Base de datos embebida en un archivo
- **FastAPI**: Framework Python moderno para APIs web
- **WebSocket**: Comunicación bidireccional en tiempo real
- **WebGL**: Graphics library para el navegador
- **Glassmorphism**: Estilo de diseño con superficies translúcidas
- **Crossfade**: Transición donde dos canciones overlap
- **FFT**: Fast Fourier Transform - análisis de frecuencia
- **ID3**: Metadatos de archivos de audio (título, artista, etc.)

---

## 21. Actualizaciones Recientes (v1.2.0)

### 21.1 Sistema de Letras/Lyrics

- **Búsqueda automática**: Al descargar una canción, se buscan automáticamente las letras usando la API gratuita lyrics.ovh
- **Guardado en formato LRC**: Las letras se guardan en archivos .lrc con timestamps sincronizados
- **Panel de lyrics**: Nuevo panel lateral que muestra las letras sincronizadas con la reproducción
- **Resaltado en tiempo real**: La línea actual se destaca y hace scroll automático
- **Fallback**: Si no se encuentran lyrics, muestra un mensaje indicando "No lyrics available"

### 21.2 Exportar Imagen Personalizada

- **Botón de Share**: Nuevo botón para exportar una imagen con la portada del álbum
- **Mensajes personalizados**: El usuario puede escribir un mensaje o lyrics custom que aparecen en la imagen
- **Calidad alta**: Genera imágenes de 1200x1200px con gradiente de fondo y diseño profesional

### 21.3 Mejoras en Biblioteca

- **Ordenar por**: Nueva opción para ordenar la biblioteca por:
  - Date Added (más reciente primero)
  - Title (alfabético)
  - Artist
  - Album
  - Duration

### 21.4 Mejoras en Playlists

- **Shuffle play**: Botón para reproducir la playlist en orden aleatorio
- **Export M3U**: Exportar playlist como archivo M3U para uso externo

### 21.5 Mejoras en Reproducción

- **Fade in**: Fade in de 1.5 segundos al inicio de cada canción
- **Fade out**: Fade out automático en los últimos 3 segundos de reproducción
- **Keyboard shortcuts adicionales**:
  - ArrowUp / ArrowDown: Subir/bajar volumen 10%

### 21.6 Fixes y Optimizaciones

- **Thumbnail embedding**: Desactivado EmbedThumbnail para evitar errores con formatos no soportados (webm/opus)
- **Canvas gradients**: Cambiadas variables CSS por colores hexadecimales en visualizadores (var(--accent) no funciona en canvas)
- **Mejora en búsqueda**: Fallback automático de Spotify a YouTube cuando no hay resultados

### 21.7 Diseño Responsive para Móviles

- **Navigation**: Menu de navegación inferior (bottom bar) con 4 botones: Search, Library, Playlists, Downloads
- **Player**: Reproductor fijo encima del menú de navegación, con todos los botones visibles
- **Library**: Grid de 2 columnas optimizado para pantallas pequeñas
- **Touch**: Botones y elementos con tamaño mínimo de 44px para mejor interacción táctil
- **Paneles**: Modales y drawers ocupan todo el ancho en móvil
- **Ocultar elementos**: Elementos no esenciales ocultos en pantallas pequeñas
- **Export Image**: Botón para exportar imagen con portada y mensaje personalizado

### 21.8 Botón de Lyrics

- **Ubicación**: En la barra de controles del reproductor (icono de partitura musical)
- **Funcionalidad**: Al hacer clic abre un panel lateral con las lyrics sincronizadas
- **Sincronización**: La línea actual se destaca automáticamente durante la reproducción
- **Búsqueda**: Las lyrics se buscan automáticamente al descargar canciones (vía API lyrics.ovh)
- **Formato**: Se guardan en archivos .lrc junto con el audio

### 21.9 Sistema de Logs

- **Panel de actividad**: Muestra todos los errores y eventos del sistema
- **Ubicación**: Esquina inferior derecha (botón flotante)
- **Contenido**: Timestamp (fecha y hora), tipo de mensaje (error/warn/info), mensaje
- **Persistencia**: Mantiene los últimos 50 mensajes
- **Acceso**: Botón de toggle para mostrar/ocultar, botón para limpiar
- **Captura automática**: Errors de JavaScript, promises rejections, y console errors/warns

### 21.7 Dependencias Actualizadas

- `python-multipart`: Para subida de archivos
- `spotipy`: API oficial de Spotify para búsquedas
- `requests`: Para llamadas a API de lyrics

---

*Este documento fue generado automáticamente como documentación comprehensiva del proyecto NOVA Music Server. Para la versión más actualizada, consultar el repositorio oficial.*