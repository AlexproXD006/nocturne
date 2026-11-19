package es.alexcloudweb.nocturne.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * Guards the widget resources against what makes a launcher refuse to inflate a RemoteViews
 * ("No se ha podido añadir el widget"): classes outside the RemoteViews allow-list (a plain
 * {@code <View>} was the beta.8 bug), theme attribute references and unsupported drawables.
 */
public class WidgetResourcesTest {
    /** Classes RemoteViews may inflate (CheckBox/Switch/RadioButton/RadioGroup only on API 31+, never used here). */
    private static final Set<String> ALLOWED = new HashSet<>(Arrays.asList(
        "FrameLayout", "LinearLayout", "RelativeLayout", "GridLayout", "AnalogClock", "Button", "Chronometer",
        "ImageButton", "ImageView", "ProgressBar", "TextView", "ViewFlipper", "ListView", "GridView", "StackView",
        "AdapterViewFlipper", "ViewStub"));

    private static File res() {
        for (String p : new String[] {"src/main/res", "app/src/main/res", "android/app/src/main/res"}) {
            File f = new File(p);
            if (f.isDirectory()) return f;
        }
        throw new IllegalStateException("res dir not found from " + new File(".").getAbsolutePath());
    }

    private static Document parse(File f) throws Exception {
        DocumentBuilderFactory fac = DocumentBuilderFactory.newInstance();
        fac.setNamespaceAware(false);
        return fac.newDocumentBuilder().parse(f);
    }

    private static List<File> files(String dir, String prefix) {
        File[] all = new File(res(), dir).listFiles((d, n) -> n.startsWith(prefix) && n.endsWith(".xml"));
        assertTrue(dir + "/" + prefix + "* not found", all != null && all.length > 0);
        Arrays.sort(all);
        return Arrays.asList(all);
    }

    private static List<File> widgetLayouts() {
        List<File> l = new ArrayList<>(files("layout", "widget_"));
        assertTrue(l.size() >= 9);
        return l;
    }

    private static void walk(Node n, File f, List<String> problems) {
        if (n.getNodeType() == Node.ELEMENT_NODE) {
            String tag = n.getNodeName();
            if (!ALLOWED.contains(tag)) problems.add(f.getName() + ": element <" + tag + "> not allowed in RemoteViews");
            NamedNodeMap attrs = n.getAttributes();
            for (int i = 0; i < attrs.getLength(); i++) {
                Node a = attrs.item(i);
                String v = a.getNodeValue();
                if (v.startsWith("?")) problems.add(f.getName() + ": " + a.getNodeName() + "=" + v + " uses a theme attribute");
                if (a.getNodeName().startsWith("app:")) problems.add(f.getName() + ": " + a.getNodeName() + " (app: attribute)");
                if (a.getNodeName().equals("style") && !v.startsWith("@android:style/")) problems.add(f.getName() + ": style attribute " + v);
                if (tag.equals("ProgressBar") && !(a.getNodeName().equals("style") && v.contains("Horizontal")) && a.getNodeName().equals("android:id")
                        && !((Element) n).getAttribute("style").contains("Horizontal")) {
                    problems.add(f.getName() + ": ProgressBar without a Horizontal style (renders as a spinner)");
                }
                if (a.getNodeName().equals("android:foreground")) problems.add(f.getName() + ": android:foreground");
            }
        }
        NodeList kids = n.getChildNodes();
        for (int i = 0; i < kids.getLength(); i++) walk(kids.item(i), f, problems);
    }

    @Test
    public void widgetLayoutsUseOnlyRemoteViewsClasses() throws Exception {
        List<String> problems = new ArrayList<>();
        for (File f : widgetLayouts()) walk(parse(f).getDocumentElement(), f, problems);
        assertEquals(problems.toString(), 0, problems.size());
    }

    @Test
    public void everyProviderLayoutExists() {
        for (String n : new String[] {"small", "medium", "large"}) {
            assertTrue(new File(res(), "layout/widget_" + n + ".xml").isFile());
            assertTrue(new File(res(), "layout/widget_preview_" + n + ".xml").isFile());
            assertTrue(new File(res(), "drawable/widget_preview_" + n + ".xml").isFile());
        }
    }

    @Test
    public void widgetDrawablesHaveNoThemeAttributes() throws Exception {
        List<File> all = new ArrayList<>(files("drawable", "widget_"));
        all.addAll(files("drawable", "ic_widget_"));
        List<String> problems = new ArrayList<>();
        for (File f : all) {
            String root = parse(f).getDocumentElement().getNodeName();
            if (!Arrays.asList("shape", "layer-list", "vector", "selector", "ripple", "bitmap").contains(root)) {
                problems.add(f.getName() + ": root <" + root + ">");
            }
            collectThemeRefs(parse(f).getDocumentElement(), f, problems);
        }
        assertEquals(problems.toString(), 0, problems.size());
    }

    private static void collectThemeRefs(Node n, File f, List<String> problems) {
        if (n.getNodeType() == Node.ELEMENT_NODE) {
            NamedNodeMap attrs = n.getAttributes();
            for (int i = 0; i < attrs.getLength(); i++) {
                if (attrs.item(i).getNodeValue().startsWith("?")) problems.add(f.getName() + ": theme attribute " + attrs.item(i).getNodeValue());
            }
        }
        NodeList kids = n.getChildNodes();
        for (int i = 0; i < kids.getLength(); i++) collectThemeRefs(kids.item(i), f, problems);
    }

    @Test
    public void providerXmlIsSane() throws Exception {
        for (String n : new String[] {"small", "medium", "large"}) {
            Element e = parse(new File(res(), "xml/nocturne_widget_" + n + ".xml")).getDocumentElement();
            assertEquals("0", e.getAttribute("android:updatePeriodMillis"));
            assertTrue(e.getAttribute("android:resizeMode").contains("horizontal"));
            assertFalse(e.getAttribute("android:targetCellWidth").isEmpty());
            assertFalse(e.getAttribute("android:previewImage").isEmpty());
        }
    }

    @Test
    public void previewErrorOnlyInDebug() {
        assertEquals("", WidgetConfigActivity.previewError(new RuntimeException("x"), false));
        assertEquals("RuntimeException: boom", WidgetConfigActivity.previewError(new RuntimeException("boom"), true));
    }

    /** beta.9 crash: ArrayAdapter(ctx, layout, android.R.id.text1, ...) on a layout whose root TextView has no id throws an NPE. */
    @Test
    public void spinnerItemLayoutsAreTextViewRoots() throws Exception {
        for (String name : new String[] {"cfg_spinner_item.xml", "cfg_spinner_dropdown_item.xml"}) {
            File f = new File(res(), "layout/" + name);
            Document d = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(f);
            assertEquals(name, "TextView", d.getDocumentElement().getNodeName());
        }
    }

    @Test
    public void configActivityDoesNotPassATextViewIdToItsAdapters() throws Exception {
        File src = new File(res(), "../java/es/alexcloudweb/nocturne/widget/WidgetConfigActivity.java");
        String code = new String(java.nio.file.Files.readAllBytes(src.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        assertFalse(code.contains("cfg_spinner_item, android.R.id.text1"));
    }
}
