# Compartir en historias de Instagram

Las tarjetas de Nocturne (letra de una canción y resumen de Stats) pueden enviarse directamente a una **historia de Instagram** desde las apps de **Android** e **iOS**. La tarjeta aparece como *sticker* sobre un fondo degradado con los colores de la portada.

Para que el botón **"Historia de Instagram"** aparezca, el servidor tiene que conocer un **Facebook App ID**. Es un identificador **público** (no es un secreto): Instagram lo pide como `source_application` para saber qué app comparte. Si no está configurado, el botón simplemente no se muestra (y nunca aparece en escritorio ni en la web).

## 1. Crear la app en Meta for Developers

1. Entra en <https://developers.facebook.com/> con tu cuenta de Facebook y acepta las condiciones de desarrollador si es la primera vez.
2. **Mis apps → Crear app**.
3. Elige un caso de uso (vale **Otro**) y el tipo de app **Consumidor** (o **Ninguno**, según lo que te ofrezca el asistente).
4. Ponle un nombre (por ejemplo "Nocturne de <tu nombre>") y un correo de contacto, y crea la app.
5. En el panel de la app, **Configuración de la app → Básica**: copia el **Identificador de la app** (App ID). Es un número de unos 15-16 dígitos.

No necesitas pasar la revisión de la app, ni activar el modo "Live", ni añadir productos: compartir a historias con `source_application` solo necesita el ID.

## 2. Configurar el servidor

Añade la variable de entorno y reinicia el servidor:

```bash
NOCTURNE_FACEBOOK_APP_ID=123456789012345
```

- systemd: añade `Environment=NOCTURNE_FACEBOOK_APP_ID=123456789012345` a la unidad (o a su `EnvironmentFile`) y ejecuta `systemctl restart music-server`.
- Docker: añade la variable al `.env` / `docker-compose.yml` y recrea el contenedor.

Solo se aceptan valores numéricos (5 a 25 dígitos); cualquier otra cosa se ignora.

## 3. Comprobarlo

```bash
curl -s https://tu-servidor/v1/info
```

Con el ID configurado verás `"capabilities": { …, "instagramStories": true }` y `"integrations": { "instagramStories": { "appId": "123456789012345" } }`. Sin él, `instagramStories` es `false` y no existe `integrations`.

Cierra sesión y vuelve a entrar (o reinicia la app) para que el móvil lea la información del servidor. Abre una tarjeta de letra o de resumen: aparece el botón **Historia de Instagram**.

## Cómo funciona

- **Android:** la app guarda el sticker (PNG de hasta 1080 px de ancho) en su caché, lo expone con un `FileProvider` y lanza `com.instagram.share.ADD_TO_STORY` con los colores de fondo. Si Instagram no está instalado se muestra "Instagram no está instalado" y se abre el menú de compartir normal.
- **iOS:** la app copia el sticker y los colores al portapapeles (caduca a los 5 minutos) y abre `instagram-stories://share?source_application=<App ID>`. Si Instagram no está instalado, se abre el menú de compartir normal.

## Problemas frecuentes

- **No sale el botón:** comprueba `/v1/info` (paso 3), que usas la app de Android/iOS y que has reiniciado sesión tras configurar el ID.
- **Instagram se abre pero sin sticker:** revisa que el App ID es el de la app creada en Meta y que no tiene espacios ni comillas.
- **Meta cambia las condiciones de la API de Stories:** el ID solo identifica a tu instancia; no se envían datos tuyos ni de tu servidor a Meta más allá del propio contenido que compartes.
