# Changelog

Historial de versiones de Nocturne. Las versiones `-beta` se publican en el canal beta de Android.

## 1.0.8 — 2026-11-18

**Ajuste de letras y edición de letras en Admin** · web, android, windows, linux

### Novedades

- Botones −0,5 s / +0,5 s en la vista de letras para ajustar la sincronización de cada canción; el ajuste se guarda en el servidor.
- Editar letras desde Admin: pega el texto o sube un .lrc, con vista previa; tiene prioridad sobre las letras automáticas.
- Revisor de letras: cuando un .lrc está incompleto o mal sincronizado se usa la letra de LRCLIB (sin tocar tus archivos).

### Correcciones

- El panel de dispositivos en el PC ya se abre hacia arriba y no atraviesa la barra de tareas.

## 1.0.7 — 2026-11-17

**Nocturne Connect, cola estilo Spotify y temas adaptativos** · web, android, windows, linux

### Novedades

- Control remoto con Nocturne Connect: elige desde el móvil canciones, álbumes o playlists para que suenen en otro dispositivo, y cambia su volumen, con la barra "Escuchando en…" y el panel de dispositivos.
- Cola estilo Spotify: lo que añades a la cola suena en tu orden aunque tengas el aleatorio, y después sigue con la playlist.
- Botón rápido "Añadir a la cola" en cada canción, con Deshacer.
- Tema Adaptive configurable con estilos: Classic, Subtle, Immersive, Vinyl, Concert y Reading.
- Ya se pueden repetir canciones en una playlist ("Añadir de nuevo").
- Títulos y artistas limpios de Spotify para las canciones importadas.
- Portadas oficiales para las canciones importadas.

### Correcciones

- Letras desincronizadas: se ignoran los .lrc generados con tiempos inventados y se vuelve a buscar la letra sincronizada de verdad.
- Canciones importadas sin letra.
- Registro de descargas duplicado.

## 1.0.6 — 2026-11-17

**Playlists, importar de Spotify y letras automáticas** · web, android, windows, linux

### Novedades

- Crea tus propias playlists: añade canciones desde cualquier lista, el reproductor o un álbum entero; renombra, reordena y quita canciones.
- Importa tus playlists de Spotify: conecta tu cuenta, elige la playlist y Nocturne reconoce las canciones que ya tienes y descarga las que faltan, en el mismo orden.
- Letras sincronizadas automáticas también para canciones con títulos de YouTube (unas 400 canciones de la biblioteca ganan letra).
- Aviso de nueva versión con notificación del sistema en Android (aunque la app esté cerrada) y en escritorio.
- Instalador de Windows y versiones para Linux (AppImage, .deb y .rpm) publicados en GitHub.

### Correcciones

- El servidor ya anuncia correctamente la integración con Spotify.
- Las listas de la app se actualizan solas al crear o editar playlists.

## 1.0.5 — 2026-11-17

**Firma de release para Android** · web, android

### Novedades

- La app de Android pasa a estar firmada con la clave oficial de Nocturne: la APK de esta web y la de GitHub son la misma y se actualizan entre sí.
- Las versiones de GitHub (releases) incluyen la APK firmada y la app de escritorio.

### Correcciones

- Esta actualización requiere desinstalar la app anterior UNA sola vez, porque cambia la firma. Tu biblioteca, likes y playlists están en el servidor y no se pierden; solo tendrás que volver a iniciar sesión y elegir tu tema.

## 1.0.4 — 2026-11-17

**Notificación multimedia, carátulas oficiales y arreglos** · web, android

### Novedades

- Notificación multimedia nueva en Android (Media3): portada, barra de progreso que avanza y permite saltar, Me gusta y Aleatorio, pantalla de bloqueo, Now Bar y auriculares Bluetooth.
- Carátulas oficiales automáticas: las canciones descargadas o subidas buscan su portada en iTunes y Deezer (hasta 1400 px).
- Las subidas conservan el nombre original del archivo y, si no traen etiquetas, el título y el artista se sacan de él.
- Canal Beta para probar versiones antes que nadie.

### Correcciones

- Las descargas se quedaban en cola para siempre y YouTube las rechazaba (error 403).
- Subir archivos desde el panel de administración fallaba siempre.
- El botón Admin desaparecía en Android al cabo de unas horas hasta volver a iniciar sesión.
- La cola del reproductor se salía de la pantalla con títulos largos en el móvil.
- Las descargas de YouTube se guardaban con la extensión duplicada (canción.opus.opus).
- El índice de búsqueda de la biblioteca estaba dañado e impedía editar algunas canciones.
- Los controles deslizantes eran invisibles en pantallas táctiles y algunas hojas inferiores quedaban pegadas a la barra de gestos.

## 1.0.4-beta.1 (beta) — 2026-11-16

**Notificación multimedia nueva (Media3)** · android

### Novedades

- Notificación multimedia moderna con AndroidX Media3: portada en alta resolución, título, artista y álbum.
- Barra de progreso que avanza en tiempo real y permite saltar a cualquier punto de la canción.
- Botones de Me gusta y Aleatorio en el panel de notificaciones (Repetir disponible en Bluetooth, Android Auto y relojes).
- Controles en la pantalla de bloqueo, la Now Bar de One UI y los botones de auriculares Bluetooth.
- Servicio en primer plano para que la música no se corte con la pantalla apagada.
- Canal Beta: las versiones de prueba se instalan aparte y avisan de nuevas betas y de la siguiente versión estable.

### Correcciones

- Las versiones beta ya no se confunden con las estables al buscar actualizaciones (comparación SemVer real).
- El código interno de versión de Android ahora deja hueco para betas, así que siempre se pueden instalar encima.

## 1.0.3 — 2026-11-16

**Temas y colores de acento** · web, android

### Novedades

- 11 temas de interfaz: Dark, Adaptive, OLED (negro puro), Dim, Midnight, Dracula, Nord, Tokyo Night, Catppuccin, Rosé Pine y Gruvbox.
- Tema Adaptive: el fondo es la portada que suena, difuminada, con un ambiente del color que predomina y fundido entre canciones.
- Selector de color de acento: Adaptive (color de la portada) u 8 colores fijos.

### Correcciones

- El color de la portada ya no pisa el acento que elijas manualmente.

## 1.0.2 — 2026-11-16

**Actualizaciones automáticas y pulido** · web, android

### Novedades

- Aviso de actualización dentro de la app con botón Actualizar ahora, y sección Updates en Ajustes.
- Animaciones nuevas: entrada y salida de la tarjeta de letras, cambio de pestaña en la biblioteca y selección de líneas. Respetan el ajuste Movimiento reducido.

### Correcciones

- Las pestañas de la biblioteca ya no se salen de la pantalla en móviles estrechos.
- La pestaña Canciones muestra un esqueleto de carga acorde a la lista.

## 1.0.1 — 2026-11-16

**Biblioteca, búsqueda y tarjetas de letras** · web, android

### Novedades

- Pestaña Canciones en la biblioteca con todas tus canciones y el total.
- Tarjeta de letras para Instagram: elige de 1 a 10 líneas y expórtalas como imagen 1080p (cuadrada o historia).
- Copia de seguridad del keystore de firma Android descargable desde el panel de administración.

### Correcciones

- La búsqueda volvía vacía en muchos casos (índice de texto completo roto): ahora encuentra artistas y canciones como Duki.
- La lista de artistas mezclaba colaboraciones («A, B») y le faltaban artistas: ahora cada artista aparece una sola vez.
- La página de un artista no mostraba las canciones en las que colabora.
- En Android, el buscador quedaba debajo de la cámara: la barra superior respeta ahora el notch.
- Las carátulas no cargaban en la notificación ni en la tarjeta de letras (faltaba CORS).

## 1.0.0 — 2026-11-08

**Primera versión de Nocturne** · web, android, windows

### Novedades

- Nueva interfaz web Nocturne sobre el servidor NOVA, con API /v1, sesiones seguras y panel de administración.
- Nocturne Connect: controla la reproducción de otro dispositivo (por ejemplo el PC desde el móvil).
- App para Android y app portable para Windows, con página de descargas.

### Correcciones

- Android: la app se cerraba al reproducir la primera canción (fallo en la notificación). Corregido en una reedición del 16 de noviembre.
