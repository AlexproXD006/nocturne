package es.alexcloudweb.nocturne.widget;

/** Small home-screen widget (see res/xml/nocturne_widget_small.xml). */
public final class SmallWidgetProvider extends NocturneWidgetProvider {
    @Override
    WidgetRenderer.Kind kind() {
        return WidgetRenderer.Kind.SMALL;
    }
}
