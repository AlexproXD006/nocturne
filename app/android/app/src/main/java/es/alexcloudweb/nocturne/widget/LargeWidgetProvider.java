package es.alexcloudweb.nocturne.widget;

/** Large home-screen widget (see res/xml/nocturne_widget_large.xml). */
public final class LargeWidgetProvider extends NocturneWidgetProvider {
    @Override
    WidgetRenderer.Kind kind() {
        return WidgetRenderer.Kind.LARGE;
    }
}
