package es.alexcloudweb.nocturne.widget;

/** Medium home-screen widget (see res/xml/nocturne_widget_medium.xml). */
public final class MediumWidgetProvider extends NocturneWidgetProvider {
    @Override
    WidgetRenderer.Kind kind() {
        return WidgetRenderer.Kind.MEDIUM;
    }
}
