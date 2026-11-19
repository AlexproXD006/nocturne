# Widgets de Android

Nocturne incluye tres widgets para la pantalla de inicio de Android (beta). Controlan la reproducción nativa
(`NocturneMediaService`), así que funcionan con la app cerrada.

## Cómo añadirlos

1. Mantén pulsado un hueco libre de la pantalla de inicio y elige **Widgets**.
2. Busca **Nocturne** y arrastra el que quieras. Al soltarlo se abre la pantalla **Aspecto del widget**
   (colores, transparencia y esquinas); pulsa **Guardar**. Si cancelas, el widget no se añade.
3. Para cambiarlo más tarde: en Android 12 o superior, mantén pulsado el widget y elige **Reconfigurar**
   (o el icono de ajustes). En Android 8-11 elimina el widget y vuelve a añadirlo.

## Tamaños

| Widget | Celdas | Contenido |
| --- | --- | --- |
| Nocturne mini | 2x1 | Miniatura de la portada, play/pausa y siguiente. |
| Nocturne reproductor | 4x2 | Portada, título, artista, barra de progreso, anterior/play/siguiente y me gusta. |
| Nocturne en reproducción | 4x4 | Portada grande, título y artista, controles, línea actual de la letra sincronizada y las 3 próximas canciones. |

Son redimensionables. En Android 12+ cambian de diseño según el tamaño real (por ejemplo, el de 4x2 pasa a una
sola fila si lo reduces a una celda de alto, y el de 4x4 oculta la cola por debajo de 4 filas). En Android 8-11 se
elige el diseño al redimensionar.

## Qué hace cada toque

- **Play/pausa, anterior, siguiente**: van a la sesión multimedia. Si el servicio no está en marcha, **play**
  restaura la última sesión guardada (cola, canción y posición) y la reproduce.
- **Me gusta**: guarda o quita la canción actual en el servidor, también con la app cerrada.
- **Portada, título o fondo**: abre Nocturne en el reproductor a pantalla completa. Si no hay nada que
  reproducir, solo abre la app.

## Colores

En **Aspecto del widget** hay cuatro modos:

- **Adaptativo (según la portada)**: fondo, texto y acento salen de la portada actual (AndroidX Palette). El
  fondo es una versión oscura del color dominante.
- **Material You (colores del sistema)**: usa los colores dinámicos del sistema (`system_neutral1_*` y
  `system_accent1_*`), en claro u oscuro según el tema del sistema. Solo aparece en Android 12 o superior.
- **Temas de Nocturne**: **Como la app** (el tema y el acento que tenga la app en ese momento, guardados de forma
  nativa para que sigan valiendo con la app cerrada), **Midnight Glass + acento de la portada**, y los temas
  Midnight Glass, Oscuro, OLED, Atenuado, Medianoche, Dracula, Nord, Tokyo Night, Catppuccin, Rosé Pine y Gruvbox.
- **Personalizado**: un color de fondo (muestras o hexadecimal, `#rrggbb` o `#rgb`); el texto se elige solo.

Además, para todos los modos:

- **Transparencia del fondo**: 0 % (opaco) a 100 % (sin fondo).
- **Radio de las esquinas**: cuadrado, pequeño, medio, grande o redondo.

El texto se ajusta siempre para tener un contraste de al menos 4,5:1 con el fondo (3:1 para el acento de la barra
y del corazón). Con mucha transparencia el contraste real depende del fondo de pantalla.

## Actualizaciones y consumo

El servicio actualiza los widgets al cambiar de canción, al pausar o reanudar, al cambiar el me gusta y al
cambiar la cola. Solo mientras suena, y solo si hay un widget grande, se refresca la letra y el progreso del
widget de 4x4 (como máximo una vez por segundo, con actualización parcial). En pausa no hay ningún temporizador.
El widget de 4x2 actualiza su barra de progreso con esos mismos eventos, no cada segundo.

La portada se descarga una vez por canción (máximo 512 px), se guarda la última en la caché y nunca se carga en el
hilo principal. Si la dirección firmada de la portada ha caducado y la app está cerrada, se usa la copia en caché.

## Para desarrolladores

- Código: `android/app/src/main/java/es/alexcloudweb/nocturne/widget/` y `media/WidgetBridge.java`.
- Manifiesto, `res/xml/nocturne_widget_*.xml` y la dependencia de Palette los genera `scripts/patch-android.mjs`
  (CI ejecuta `--check`).
- Puente de tema: `NocturneMedia.setAppTheme({ theme, accent })` desde `src/renderer/src/services.ts`.
- Enlace profundo: `es.alexcloudweb.nocturne://widget/player` (`src/renderer/src/lib/widgetLink.ts`).
