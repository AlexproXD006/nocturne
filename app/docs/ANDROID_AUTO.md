# Android Auto en Nocturne

Desde la 1.1.1 la app de Android reproduce con **ExoPlayer nativo** (Media3) dentro de un servicio
`MediaLibraryService`. Ese mismo servicio es el que Android Auto (y cualquier otro cliente de
`MediaBrowser`: Bluetooth, Wear OS, el panel multimedia del sistema) usa para navegar por tu biblioteca y
controlar la reproducción.

## Cómo funciona

- **Reproducción nativa**: foco de audio, "becoming noisy" (auriculares desconectados), wake lock, gapless y
  servicio en primer plano los gestiona Android, no el WebView. La música sigue aunque la interfaz web esté
  suspendida o cerrada.
- **La interfaz web es un mando a distancia**: el store del reproductor (`store/player.ts`) mantiene el modelo de
  cola (cola de usuario, contexto, autoplay, aleatorio) y se lo envía al servicio por el plugin `NocturneMedia`
  (`setQueue`, `play`, `pause`, `seek`, ...). El servicio devuelve eventos (estado, posición, canción actual,
  errores). En web, escritorio e iOS no cambia nada: siguen usando `<audio>`.
- **Sesión**: al iniciar sesión (y al renovar el token) la app guarda la sesión cifrada con una clave del
  Android Keystore (`NocturneAuth`). El servicio la usa para listar la biblioteca, pedir la URL firmada de cada
  canción (`/v1/tracks/{id}/stream`) y renovar el token solo, así funciona con el móvil bloqueado y con el
  proceso arrancado en frío por Android Auto. Los tokens no se escriben nunca en el log.
- **Escuchas**: el servicio cuenta los segundos escuchados y envía `POST /v1/tracks/{id}/played` con un `playId`
  único; si no hay red o el WebView no existe, la escucha queda en una cola persistente y se reenvía después.
- **Cronómetro de sueño, Connect y autoplay** siguen funcionando: Connect llama a las mismas acciones del store,
  el "fin de canción" usa `setPauseAtEndOfMediaItems` y el autoplay amplía la cola a través del puente.

## Árbol de navegación

```
Nocturne
├── Hecho para ti   (/v1/mixes)
├── Playlists       (/v1/library/playlists)
├── Me gusta        (/v1/library/tracks)
├── Recientes       (sección "recent" de /v1/home)
├── Álbumes         (/v1/library/albums)
├── Artistas        (/v1/library/artists)
└── Descargas       (índice local de descargas: funciona sin conexión, ver docs/OFFLINE.md)
```

Cada nodo devuelve como mucho 100 elementos por página (Android Auto pide páginas) y con carátulas. Tocar una
canción reproduce **todo el contenedor** (playlist, álbum, mix...) empezando por ella. Los textos están en
`values/` (inglés) y `values-es/` (español).

**Búsqueda por voz** ("Ok Google, pon X en Nocturne"): se busca en `/v1/search`. Si hay un artista, playlist o
álbum que se llame igual, se reproduce entero; si no, las canciones que coinciden. Sin término ("pon música") se
reproducen tus canciones que te gustan.

**Botones personalizados**: Me gusta, Aleatorio y Repetir. Me gusta llama directamente al servidor. Aleatorio y
Repetir los resuelve la interfaz web si está viva; si no, los aplica el propio ExoPlayer.

## Probar en un coche real: activar "Fuentes desconocidas"

Android Auto solo muestra apps de la Play Store, salvo que actives las fuentes desconocidas (necesario para el
APK de GitHub):

1. En el móvil abre **Ajustes → Aplicaciones → Android Auto** (o la app Android Auto) → **Ajustes de Android Auto**.
2. Baja hasta **Versión** y púlsala **10 veces** seguidas. Confirma el aviso de "modo desarrollador".
3. Menú de tres puntos (arriba a la derecha) → **Ajustes para desarrolladores**.
4. Activa **Fuentes desconocidas** (*Unknown sources*).
5. Conecta el móvil al coche (o al DHU). Nocturne aparece en el lanzador de apps multimedia. Abre Nocturne en el
   móvil al menos una vez e inicia sesión para que el servicio tenga credenciales.

## Probar con el Desktop Head Unit (DHU)

1. Instala el DHU desde el SDK Manager de Android Studio (**SDK Tools → Android Auto Desktop Head Unit Emulator**).
2. En Android Auto (móvil) activa el modo desarrollador (pasos 1-3 anteriores) y en el menú de tres puntos
   **Iniciar servidor de unidad principal** (*Start head unit server*). Activa también *Fuentes desconocidas*.
3. Conecta el móvil por USB y redirige el puerto: `adb forward tcp:5277 tcp:5277`.
4. Lanza el DHU: `$ANDROID_SDK/extras/google/auto/desktop-head-unit` (en Linux/macOS) o `desktop-head-unit.exe`.
5. Elige Nocturne en el lanzador, navega por las pestañas, reproduce, usa el micrófono simulado del DHU para la
   búsqueda por voz y prueba bloquear el móvil.

Para depurar el árbol sin coche, también sirve la app **Media Controller Test** de Android o `adb shell dumpsys
media_session`.

## Letra en el coche (opcional, desactivada por defecto)

Ajustes → Reproducción → **Mostrar la línea de la letra en el coche**. Si la canción tiene letra sincronizada
(`GET /v1/tracks/{id}/lyrics`, campo `synced` y `offsetMs`), el servicio escribe la línea actual en el
*subtítulo / descripción* de los metadatos de la sesión (como mucho una vez por segundo y solo cuando cambia de
línea); el artista sigue siendo el campo `artist`.

**No es una función oficial de Android Auto**: las normas de distracción al volante de Google no permiten una
pantalla de letras en apps multimedia. Es un truco con los metadatos y puede verse distinto (o no verse) según el
coche y la versión de Android Auto. Por eso viene apagado.

- **Sin conexión**: solo el nodo *Descargas* (y lo que ya esté en la caché automática, si lo abres desde la cola) funciona sin red; el resto de nodos necesitan el servidor. Las canciones no guardadas se saltan solas.

## Límites conocidos

- **Crossfade**: no está disponible con el reproductor nativo de Android (ExoPlayer no mezcla dos pistas y el
  gapless sí funciona). El ajuste se oculta en Android; en web y escritorio sigue igual.
- **Visualizador**: depende del analizador de Web Audio del `<audio>`, así que en Android no reacciona al audio.
- **Cola con el WebView cerrado**: si arrancas algo desde el coche con la app cerrada, la cola la gestiona el
  servicio. Al abrir la app, la interfaz *adopta* esa cola. Sin WebView no hay autoplay (canciones parecidas) y el
  aleatorio se aplica sobre ExoPlayer, no sobre el modelo de la app.
- **Sin sesión**: si el servicio no tiene sesión (o el refresh token ya no vale), Android Auto muestra un error de
  autenticación; abre Nocturne en el móvil e inicia sesión.
- **Tokens rotativos**: el servicio renueva el token por su cuenta y avisa al WebView (`auth`); si la interfaz
  estaba suspendida, lo recoge al volver a primer plano.
- **Carátulas**: usan las URLs firmadas del servidor; si caducan hasta recargar la lista, Android Auto puede
  mostrar el icono por defecto un momento.
- Probado solo en compilación y pruebas unitarias; ver la lista de pruebas pendientes en un coche/DHU en el
  informe de la rama `android-auto`.

## Archivos

- `android/app/src/main/java/es/alexcloudweb/nocturne/media/`: `NocturneMediaService` (ExoPlayer + sesión +
  navegación), `NocturneMediaPlugin` (puente Capacitor), `EventHub`, `Library` (árbol), `NocturneApi`,
  `NocturneAuth`, `PlayReporter`, y las piezas puras con tests: `MediaIds`, `LrcParser`, `ListenTracker`.
- `scripts/patch-android.mjs`: servicio y filtros de intents en el manifiesto, `meta-data
  com.google.android.gms.car.application`, `res/xml/automotive_app_desc.xml` y las dependencias de Media3.
- `src/renderer/src/platform/nativePlayer*.ts`, `player/nativeEngine.ts`, `store/player.ts`: el lado JS.
