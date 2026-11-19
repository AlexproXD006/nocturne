package es.alexcloudweb.nocturne.widget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RadioGroup;
import android.widget.RemoteViews;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.TextView;
import androidx.annotation.Nullable;
import es.alexcloudweb.nocturne.R;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Appearance of one widget: colour mode (adaptive, Material You, Nocturne themes, custom), background
 * transparency and corner radius, with a live preview rendered by the same code as the widget. Launched by the
 * launcher when a widget is added (APPWIDGET_CONFIGURE) and again for "reconfigure" on Android 12+.
 */
public final class WidgetConfigActivity extends Activity {
    private static final String TAG = "NocturneWidget";
    private static final String[] SWATCHES = {"#1d2b4a", "#0d1424", "#000000", "#ffffff", "#8fb4ff", "#ff7a5c", "#4ade80", "#bd93f9"};

    private int appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private WidgetRenderer.Kind kind = WidgetRenderer.Kind.MEDIUM;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final AtomicInteger renderSeq = new AtomicInteger();

    private WidgetConfig cfg;
    private String[] themeIds;
    private boolean binding;

    private RadioGroup modes;
    private View themeBox;
    private View customBox;
    private Spinner themeSpinner;
    private EditText hex;
    private SeekBar transparency;
    private TextView transparencyLabel;
    private Spinner radius;
    private FrameLayout preview;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setResult(RESULT_CANCELED);
        appWidgetId = getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }
        AppWidgetProviderInfo info = AppWidgetManager.getInstance(this).getAppWidgetInfo(appWidgetId);
        String cls = info == null ? "" : info.provider.getClassName();
        if (cls.endsWith("SmallWidgetProvider")) kind = WidgetRenderer.Kind.SMALL;
        else if (cls.endsWith("LargeWidgetProvider")) kind = WidgetRenderer.Kind.LARGE;
        else kind = WidgetRenderer.Kind.MEDIUM;

        setContentView(R.layout.activity_widget_config);
        cfg = WidgetConfig.load(KeyValueStore.prefs(this), appWidgetId);
        bindViews();
        applyToViews();
        scheduleRender();
    }

    @Override
    protected void onDestroy() {
        exec.shutdownNow();
        super.onDestroy();
    }

    // ---------------------------------------------------------------------------------------------

    private void bindViews() {
        modes = findViewById(R.id.cfg_modes);
        themeBox = findViewById(R.id.cfg_theme_box);
        customBox = findViewById(R.id.cfg_custom_box);
        themeSpinner = findViewById(R.id.cfg_theme);
        hex = findViewById(R.id.cfg_hex);
        transparency = findViewById(R.id.cfg_transparency);
        transparencyLabel = findViewById(R.id.cfg_transparency_label);
        radius = findViewById(R.id.cfg_radius);
        preview = findViewById(R.id.cfg_preview);

        // Material You only exists from Android 12.
        if (Build.VERSION.SDK_INT < 31) findViewById(R.id.cfg_mode_material).setVisibility(View.GONE);

        // Preview box height per widget kind.
        float d = getResources().getDisplayMetrics().density;
        int hDp = kind == WidgetRenderer.Kind.SMALL ? 64 : kind == WidgetRenderer.Kind.MEDIUM ? 120 : 290;
        int wDp = kind == WidgetRenderer.Kind.SMALL ? 160 : 340;
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.round(wDp * d), Math.round(hDp * d));
        lp.gravity = android.view.Gravity.CENTER_HORIZONTAL;
        preview.setLayoutParams(lp);

        List<String> themeLabels = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        ids.add(WidgetThemes.APP);
        ids.add(WidgetThemes.COVER_ACCENT);
        for (String id : WidgetThemes.presetIds()) ids.add(id);
        themeIds = ids.toArray(new String[0]);
        for (String id : themeIds) themeLabels.add(getString(themeLabelRes(id)));
        styleSpinner(themeSpinner, themeLabels);

        List<String> radiusLabels = new ArrayList<>();
        int[] radiusRes = {R.string.widget_radius_0, R.string.widget_radius_1, R.string.widget_radius_2, R.string.widget_radius_3, R.string.widget_radius_4};
        for (int r : radiusRes) radiusLabels.add(getString(r));
        styleSpinner(radius, radiusLabels);

        LinearLayout swatches = findViewById(R.id.cfg_swatches);
        for (final String sw : SWATCHES) {
            View v = new View(this);
            int size = Math.round(40 * d);
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(size, size);
            p.setMarginEnd(Math.round(10 * d));
            v.setLayoutParams(p);
            GradientDrawable g = new GradientDrawable();
            g.setShape(GradientDrawable.OVAL);
            g.setColor(Color.parseColor(sw));
            g.setStroke(Math.round(2 * d), 0x66FFFFFF);
            v.setBackground(g);
            v.setContentDescription(getString(R.string.widget_config_swatch, sw));
            v.setOnClickListener(x -> {
                hex.setText(sw);
                hex.setSelection(hex.getText().length());
            });
            swatches.addView(v);
        }

        modes.setOnCheckedChangeListener((g, checkedId) -> {
            if (binding) return;
            String m = checkedId == R.id.cfg_mode_material ? WidgetConfig.MODE_MATERIAL
                : checkedId == R.id.cfg_mode_theme ? WidgetConfig.MODE_THEME
                : checkedId == R.id.cfg_mode_custom ? WidgetConfig.MODE_CUSTOM : WidgetConfig.MODE_ADAPTIVE;
            cfg = new WidgetConfig(m, cfg.themeId, cfg.customColor, cfg.transparency, cfg.radiusIndex);
            showSections();
            scheduleRender();
        });
        themeSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (binding || themeIds[position].equals(cfg.themeId)) return;
                cfg = new WidgetConfig(cfg.mode, themeIds[position], cfg.customColor, cfg.transparency, cfg.radiusIndex);
                scheduleRender();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        radius.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (binding || position == cfg.radiusIndex) return;
                cfg = new WidgetConfig(cfg.mode, cfg.themeId, cfg.customColor, cfg.transparency, position);
                scheduleRender();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        transparency.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int value, boolean fromUser) {
                transparencyLabel.setText(getString(R.string.widget_config_transparency, value));
                if (binding || !fromUser) return;
                cfg = new WidgetConfig(cfg.mode, cfg.themeId, cfg.customColor, value, cfg.radiusIndex);
                scheduleRender();
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {}

            @Override
            public void onStopTrackingTouch(SeekBar bar) {}
        });
        hex.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {}

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {}

            @Override
            public void afterTextChanged(Editable e) {
                if (binding) return;
                Integer c = WidgetColors.parseHex(e.toString());
                if (c == null) {
                    hex.setError(e.length() >= 4 ? getString(R.string.widget_config_hex_invalid) : null);
                    return;
                }
                hex.setError(null);
                cfg = new WidgetConfig(cfg.mode, cfg.themeId, c, cfg.transparency, cfg.radiusIndex);
                scheduleRender();
            }
        });
        findViewById(R.id.cfg_cancel).setOnClickListener(v -> finish());
        findViewById(R.id.cfg_save).setOnClickListener(v -> save());
    }

    /** Adapter with explicit light-on-dark rows (the theme-provided ones can end up dark-on-dark on One UI). */
    private void styleSpinner(Spinner sp, List<String> labels) {
        ArrayAdapter<String> a = new ArrayAdapter<>(this, R.layout.cfg_spinner_item, android.R.id.text1, labels);
        a.setDropDownViewResource(R.layout.cfg_spinner_dropdown_item);
        sp.setAdapter(a);
        sp.setPopupBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0xFF161C2B));
    }

    /** Text shown in the preview when the widget layout cannot be inflated. */
    static String previewError(Throwable t, boolean debug) {
        if (!debug) return "";
        String m = t.getMessage();
        return t.getClass().getSimpleName() + (m == null || m.isEmpty() ? "" : ": " + m);
    }

    private void showPreviewFallback(Throwable t) {
        boolean debug = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        Log.w(TAG, "preview failed: " + previewError(t, true));
        preview.removeAllViews();
        FrameLayout.LayoutParams match = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        android.widget.ImageView img = new android.widget.ImageView(this);
        img.setScaleType(android.widget.ImageView.ScaleType.FIT_CENTER);
        img.setImageResource(kind == WidgetRenderer.Kind.SMALL ? R.drawable.widget_preview_small
            : kind == WidgetRenderer.Kind.LARGE ? R.drawable.widget_preview_large : R.drawable.widget_preview_medium);
        preview.addView(img, match);
        if (debug) {
            TextView tv = new TextView(this);
            tv.setText(previewError(t, true));
            tv.setTextColor(0xFFFF7A5C);
            tv.setTextSize(11);
            tv.setBackgroundColor(0xCC000000);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.gravity = android.view.Gravity.BOTTOM;
            preview.addView(tv, lp);
        }
    }

    private void applyToViews() {
        binding = true;
        modes.check(cfg.mode.equals(WidgetConfig.MODE_MATERIAL) && Build.VERSION.SDK_INT >= 31 ? R.id.cfg_mode_material
            : cfg.mode.equals(WidgetConfig.MODE_THEME) ? R.id.cfg_mode_theme
            : cfg.mode.equals(WidgetConfig.MODE_CUSTOM) ? R.id.cfg_mode_custom : R.id.cfg_mode_adaptive);
        for (int i = 0; i < themeIds.length; i++) if (themeIds[i].equals(cfg.themeId)) themeSpinner.setSelection(i);
        hex.setText(WidgetColors.toHex(cfg.customColor));
        transparency.setProgress(cfg.transparency);
        transparencyLabel.setText(getString(R.string.widget_config_transparency, cfg.transparency));
        radius.setSelection(cfg.radiusIndex);
        showSections();
        binding = false;
    }

    private void showSections() {
        themeBox.setVisibility(WidgetConfig.MODE_THEME.equals(cfg.mode) ? View.VISIBLE : View.GONE);
        customBox.setVisibility(WidgetConfig.MODE_CUSTOM.equals(cfg.mode) ? View.VISIBLE : View.GONE);
    }

    private static int themeLabelRes(String id) {
        switch (id) {
            case WidgetThemes.APP:
                return R.string.widget_theme_app;
            case WidgetThemes.COVER_ACCENT:
                return R.string.widget_theme_cover_accent;
            case "dark":
                return R.string.widget_theme_dark;
            case "oled":
                return R.string.widget_theme_oled;
            case "dim":
                return R.string.widget_theme_dim;
            case "midnight":
                return R.string.widget_theme_midnight;
            case "dracula":
                return R.string.widget_theme_dracula;
            case "nord":
                return R.string.widget_theme_nord;
            case "tokyonight":
                return R.string.widget_theme_tokyonight;
            case "catppuccin":
                return R.string.widget_theme_catppuccin;
            case "rosepine":
                return R.string.widget_theme_rosepine;
            case "gruvbox":
                return R.string.widget_theme_gruvbox;
            default:
                return R.string.widget_theme_glass;
        }
    }

    // ---------------------------------------------------------------------------------------------

    /** Renders the preview off the main thread (cover, Palette) and shows the latest request only. */
    private void scheduleRender() {
        final int seq = renderSeq.incrementAndGet();
        final WidgetConfig snapshot = cfg;
        final WidgetRenderer.Kind k = kind;
        try {
            exec.execute(() -> {
                try {
                    WidgetState st = WidgetUpdater.get(getApplicationContext()).state();
                    if (!st.hasQueue) st = demo();
                    Bitmap cover = st.trackId.isEmpty() ? null : CoverLoader.cached(getApplicationContext(), st.trackId);
                    int[] palette = cover != null ? CoverLoader.palette(st.trackId, cover) : null;
                    AppThemeStore.State app = AppThemeStore.load(KeyValueStore.prefs(getApplicationContext()));
                    WidgetColors.Scheme sc = WidgetColors.resolve(snapshot, app, palette, WidgetUpdater.systemColors(getApplicationContext()));
                    WidgetRenderer.Layout[] all = WidgetRenderer.layoutsOf(k);
                    final RemoteViews rv = WidgetRenderer.renderLayout(getApplicationContext(), all[all.length - 1], st, snapshot, sc, cover);
                    runOnUiThread(() -> {
                        if (seq != renderSeq.get() || isFinishing()) return;
                        try {
                            View v = rv.apply(this, preview);
                            preview.removeAllViews();
                            preview.addView(v, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                        } catch (Throwable t) {
                            showPreviewFallback(t);
                        }
                    });
                } catch (Throwable t) {
                    final Throwable err = t;
                    runOnUiThread(() -> {
                        if (!isFinishing()) showPreviewFallback(err);
                    });
                }
            });
        } catch (RuntimeException ignored) {
            /* activity closing */
        }
    }

    private WidgetState demo() {
        return new WidgetState.Builder()
            .queue(true)
            .track("", getString(R.string.widget_demo_title), getString(R.string.widget_demo_artist), "")
            .playing(true)
            .liked(true)
            .position(84_000, 215_000)
            .lyric(getString(R.string.widget_demo_lyric))
            .next(getString(R.string.widget_demo_next1), "")
            .next(getString(R.string.widget_demo_next2), "")
            .next(getString(R.string.widget_demo_next3), "")
            .build();
    }

    private void save() {
        WidgetConfig.save(KeyValueStore.prefs(this), appWidgetId, cfg);
        WidgetUpdater.get(this).refresh(kind, new int[] {appWidgetId}, null);
        WidgetUpdater.get(this).widgetsChanged();
        Intent result = new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        setResult(RESULT_OK, result);
        finish();
    }
}
