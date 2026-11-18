import { LitElement, html, css, CSSResult, PropertyValues, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { HomeAssistant, CanvasGuageCardConfig } from "./types.js";
import { localize } from "./localize/localize.js";
import {
  fieldNames,
  isInvalidColor,
  sanitizeCardColors,
  sanitizeGaugeColors,
  withoutEmpty,
} from "./gauge-helpers.js";

// Same domains as Home Assistant's built-in gauge card editor
const GAUGE_DOMAINS = ["counter", "input_number", "number", "sensor"];

// canvas-gauges options that default to true. The form shows these defaults for unset
// options; they are kept out of the saved config unless the user changes them
const GAUGE_DISPLAY_DEFAULTS: Record<string, boolean> = {
  valueBox: true,
  strokeTicks: true,
  barProgress: true,
  animation: true,
  needle: true,
  needleShadow: true,
  needleCircleInner: true,
  needleCircleOuter: true,
  borders: true,
  valueTextShadow: true,
};

// Selectors. canvas-gauges sizes marked "relative" scale with the gauge (200 = gauge size)
const text = { text: {} };
const bool = { boolean: {} };
const pixels = { number: { min: 0, max: 2000, step: 1, mode: "box", unit_of_measurement: "px" } };
const gaugePixels = { number: { min: 50, max: 2000, step: 1, mode: "box", unit_of_measurement: "px" } };
const borderPixels = { number: { min: 0, max: 50, step: 1, mode: "box", unit_of_measurement: "px" } };
const anyNumber = { number: { step: "any", mode: "box" } };
const relative = { number: { min: 0, max: 200, step: "any", mode: "box" } };
const percent = { number: { min: 0, max: 100, step: 1, mode: "box", unit_of_measurement: "%" } };
const digits = { number: { min: 0, max: 10, step: 1, mode: "box" } };
const degrees = { number: { min: 0, max: 360, step: 1, mode: "box", unit_of_measurement: "°" } };
const milliseconds = { number: { min: 0, max: 10000, step: 50, mode: "box", unit_of_measurement: "ms" } };
const select = (options: string[]) => ({ select: { mode: "dropdown", options } });
const sides = select(["both", "left", "right"]);
const fontStyles = select(["normal", "italic", "oblique"]);
const fontWeights = select(["normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700", "800", "900"]);

const field = (name: string, selector: object) => ({ name, selector });
const row = (...schema: object[]) => ({ name: "", type: "grid", schema });
const colorPair = (base: string) => row(field(base, text), field(`${base}End`, text));

// Text styling for one of the four text items canvas-gauges draws
const fontGroup = (item: string) => [
  row(field(`color${item}`, text), field(`font${item}Size`, relative)),
  row(field(`font${item}`, text), field(`font${item}Style`, fontStyles), field(`font${item}Weight`, fontWeights)),
];

// Each section edits the gauge object under its own key (see willUpdate), so ha-form can
// show color errors above the section that holds the field. ha-form shows errors only for
// top-level schema items
function gaugeSections(radial: boolean): Record<string, object[]> {
  const highlightList = {
    object: {
      multiple: true,
      fields: {
        from: { label: localize("editor.highlight_from"), selector: anyNumber, required: true },
        to: { label: localize("editor.highlight_to"), selector: anyNumber, required: true },
        color: { label: localize("editor.highlight_color"), selector: text, required: true },
      },
    },
  };
  return {
    gauge_main: [
      {
        name: "type",
        required: true,
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "radial-gauge", label: localize("editor.type_radial") },
              { value: "linear-gauge", label: localize("editor.type_linear") },
            ],
          },
        },
      },
      row({ ...field("width", gaugePixels), required: true }, { ...field("height", gaugePixels), required: true }),
      row(field("minValue", anyNumber), field("maxValue", anyNumber)),
      row(field("units", text), field("title", text)),
    ],
    gauge_scale: [
      field("majorTicks", { text: { multiple: true } }),
      row(field("exactTicks", bool), field("strokeTicks", bool)),
      row(field("minorTicks", digits), field("numbersMargin", relative)),
      row(field("majorTicksInt", digits), field("majorTicksDec", digits)),
      ...(radial
        ? [row(field("startAngle", degrees), field("ticksAngle", degrees))]
        : [
          row(field("tickSide", sides), field("numberSide", sides)),
          row(field("ticksWidth", relative), field("ticksWidthMinor", relative), field("ticksPadding", relative)),
        ]),
      row(field("colorMajorTicks", text), field("colorMinorTicks", text)),
      field("colorStrokeTicks", text),
    ],
    gauge_highlights: [
      field("highlights", highlightList),
      row(field("highlightsWidth", relative), ...(radial ? [field("highlightsLineCap", select(["butt", "round", "square"]))] : [])),
    ],
    gauge_needle: [
      row(field("needle", bool), field("needleShadow", bool)),
      row(field("needleType", select(["arrow", "line"])), ...(radial ? [] : [field("needleSide", sides)])),
      row(field("needleStart", relative), field("needleEnd", relative), field("needleWidth", relative)),
      colorPair("colorNeedle"),
      row(field("colorNeedleShadowUp", text), field("colorNeedleShadowDown", text)),
      ...(radial
        ? [
          row(field("needleCircleSize", relative), field("needleCircleOuter", bool), field("needleCircleInner", bool)),
          colorPair("colorNeedleCircleOuter"),
          colorPair("colorNeedleCircleInner"),
        ]
        : []),
    ],
    gauge_value: [
      row(field("valueBox", bool), field("valueTextShadow", bool)),
      row(field("valueInt", digits), field("valueDec", digits)),
      field("valueText", text),
      row(field("valueBoxWidth", percent), field("valueBoxStroke", relative), field("valueBoxBorderRadius", relative)),
      row(field("colorValueBoxBackground", text), field("colorValueBoxShadow", text)),
      colorPair("colorValueBoxRect"),
      field("colorValueTextShadow", text),
    ],
    gauge_text: [
      row(field("name_color", text), field("name_bold", bool)),
      ...fontGroup("Numbers"),
      ...fontGroup("Value"),
      ...fontGroup("Units"),
      ...fontGroup("Title"),
    ],
    gauge_plate: [
      colorPair("colorPlate"),
      row(field("borders", bool), ...(radial ? [] : [field("borderRadius", relative)])),
      row(field("borderOuterWidth", borderPixels), field("borderMiddleWidth", borderPixels)),
      row(field("borderInnerWidth", borderPixels), field("borderShadowWidth", borderPixels)),
      colorPair("colorBorderOuter"),
      colorPair("colorBorderMiddle"),
      colorPair("colorBorderInner"),
      field("colorBorderShadow", text),
    ],
    gauge_bar: [
      row(field("barProgress", bool), ...(radial ? [field("barStartPosition", select(["left", "right"]))] : [])),
      row(field("barWidth", percent), field("barStrokeWidth", relative), field("barShadow", relative)),
      ...(radial ? [] : [row(field("barLength", percent), field("barBeginCircle", relative))]),
      radial ? field("colorBar", text) : colorPair("colorBar"),
      radial ? field("colorBarProgress", text) : colorPair("colorBarProgress"),
      field("colorBarStroke", text),
    ],
    gauge_animation: [
      row(field("animation", bool), field("animateOnInit", bool), field("animatedValue", bool)),
      row(
        field("animationDuration", milliseconds),
        field("animationRule", select(["linear", "quad", "quint", "cycle", "bounce", "elastic", "dequad", "dequint", "decycle", "debounce", "delastic"])),
      ),
      ...(radial ? [row(field("animationTarget", select(["needle", "plate"])), field("useMinPath", bool))] : []),
    ],
  };
}

const SECTION_KEYS = Object.keys(gaugeSections(true));
// Card-level options shown in the gauge_text section
const TEXT_CARD_KEYS = ["name_color", "name_bold"];

function buildSchema(radial: boolean): readonly object[] {
  const sections = gaugeSections(radial);
  return [
    { name: "entity", required: true, selector: { entity: { domain: GAUGE_DOMAINS } } },
    field("name", text),
    field("background_color", text),
    ...SECTION_KEYS.map((key) => ({
      name: key,
      type: "expandable",
      title: localize(`editor.section_${key}`),
      expanded: key === "gauge_main",
      schema: sections[key],
    })),
    {
      name: "",
      type: "expandable",
      flatten: true,
      title: localize("editor.section_layout"),
      schema: [
        row(field("card_width", pixels), field("card_height", pixels)),
        row(field("shadow_height", text), field("shadow_bottom", pixels)),
        field("font_size", text),
        field("dropshadow", bool),
      ],
    },
  ];
}

@customElement("canvas-gauge-card-editor")
export class CanvasGaugeCardEditor extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: CanvasGuageCardConfig;

  private _schemas = new Map<boolean, readonly object[]>();
  // Form data, rebuilt when the config changes. Every gauge section gets the same object,
  // so the one section ha-form replaced on a change can be found by identity
  private _data: Record<string, any> = {};
  // Invalid color text is not written to the config, but the field has to keep showing it
  // with its error, so rejected drafts are remembered here until the user fixes the value
  private _gaugeColorDraft: Record<string, any> = {};
  private _highlightColorDraft: Record<number, string> = {};
  private _cardColorDraft: Record<string, any> = {};

  public setConfig(config: CanvasGuageCardConfig): void {
    this._config = config;
  }

  protected willUpdate(changedProps: PropertyValues): void {
    if (!changedProps.has("_config") || !this._config) return;
    // A YAML edit can land an invalid color directly in the config; collect any
    // such values here. They are merged with drafts the editor itself rejected
    // earlier (those keys are absent from the sanitized config), so an errored
    // value stays visible until the user types something valid
    const gaugeDrafts = this._collectInvalidGaugeColors(this._config.gauge ?? {});
    const mergedGaugeDraft: Record<string, any> = { ...this._gaugeColorDraft };
    for (const [key, color] of Object.entries(gaugeDrafts.colors)) {
      mergedGaugeDraft[key] = color;
    }
    const mergedHighlightDraft: Record<number, string> = { ...this._highlightColorDraft };
    for (const [index, color] of Object.entries(gaugeDrafts.highlights)) {
      mergedHighlightDraft[Number(index)] = color;
    }
    this._gaugeColorDraft = mergedGaugeDraft;
    this._highlightColorDraft = mergedHighlightDraft;
    this._cardColorDraft = {
      ...this._cardColorDraft,
      ...this._collectInvalidCardColors(this._config),
    };
    const gauge = {
      ...GAUGE_DISPLAY_DEFAULTS,
      ...(this._config.gauge ?? {}),
      ...this._gaugeColorDraft,
    };
    // Re-apply rejected highlight colors on top of the sanitized config array.
    // Drop drafts whose highlight no longer exists (the array was shortened)
    if (Object.keys(this._highlightColorDraft).length > 0 && Array.isArray(gauge.highlights)) {
      const count = gauge.highlights.length;
      const pruned: Record<number, string> = {};
      for (const [i, color] of Object.entries(this._highlightColorDraft)) {
        if (Number(i) < count) pruned[Number(i)] = color;
      }
      this._highlightColorDraft = pruned;
      gauge.highlights = gauge.highlights.map((highlight: any, i: number) =>
        i in this._highlightColorDraft
          ? { ...highlight, color: this._highlightColorDraft[i] }
          : highlight
      );
    } else if (!Array.isArray(gauge.highlights)) {
      this._highlightColorDraft = {};
    }
    const data: Record<string, any> = { ...this._config, ...this._cardColorDraft };
    for (const key of SECTION_KEYS) {
      data[key] = gauge;
    }
    data.gauge_text = {
      ...gauge,
      name_color: this._cardColorDraft.name_color ?? this._config.name_color,
      name_bold: this._config.name_bold ?? false,
    };
    this._data = data;
  }

  private _schema(radial: boolean): readonly object[] {
    if (!this._schemas.has(radial)) {
      this._schemas.set(radial, buildSchema(radial));
    }
    return this._schemas.get(radial)!;
  }

  private _computeLabel = (schema: any): string =>
    localize(`editor.${schema.name}`) ?? schema.name;

  private _computeHelper = (schema: any): string | undefined =>
    localize(`editor.${schema.name}_helper`);

  private _colorError(name: string, allowVar: boolean): string {
    const label = localize(`editor.${name}`) ?? name;
    return localize(allowVar ? "editor.css_color_error" : "editor.gauge_color_error", "{field}", label);
  }

  private _errors(radial: boolean): Record<string, string | string[]> | undefined {
    if (!this._config) return undefined;
    const errors: Record<string, string | string[]> = {};
    if (isInvalidColor(this._data.background_color, true)) {
      errors.background_color = this._colorError("background_color", true);
    }
    const sections = gaugeSections(radial);
    for (const key of SECTION_KEYS) {
      const data = this._data[key] ?? {};
      const messages = fieldNames(sections[key])
        .filter((name) => name.startsWith("color") || name === "name_color")
        .filter((name) => isInvalidColor(data[name], name === "name_color"))
        .map((name) => this._colorError(name, name === "name_color"));
      if (key === "gauge_highlights" && Array.isArray(data.highlights)) {
        data.highlights.forEach((highlight: any, i: number) => {
          if (isInvalidColor(highlight?.color, false)) {
            const field = localize("editor.highlight_color_numbered", "{n}", String(i + 1));
            messages.push(localize("editor.gauge_color_error", "{field}", field));
          }
        });
      }
      if (messages.length > 0) {
        errors[key] = messages;
      }
    }
    return Object.keys(errors).length > 0 ? errors : undefined;
  }

  private _valueChanged(ev: CustomEvent): void {
    ev.stopPropagation();
    if (!this._config) return;

    const value = { ...ev.detail.value };
    let gauge = { ...this._data.gauge_main };
    for (const key of SECTION_KEYS) {
      if (value[key] !== this._data[key]) {
        gauge = { ...value[key] };
      }
      delete value[key];
    }
    for (const key of TEXT_CARD_KEYS) {
      if (key in gauge) {
        value[key] = gauge[key];
        delete gauge[key];
      }
    }
    value.name_bold = value.name_bold || undefined;

    // Keep invalid color text on screen with its error, but never write it to
    // the config: var(--token) and unparseable colors cannot be drawn on canvas
    const gaugeDrafts = this._collectInvalidGaugeColors(gauge);
    this._gaugeColorDraft = gaugeDrafts.colors;
    this._highlightColorDraft = gaugeDrafts.highlights;
    this._cardColorDraft = this._collectInvalidCardColors(value);

    // Drop display-only defaults the user did not set or change
    const sanitizedGauge = sanitizeGaugeColors(gauge);
    for (const [key, def] of Object.entries(GAUGE_DISPLAY_DEFAULTS)) {
      if (this._config.gauge?.[key] === undefined && sanitizedGauge[key] === def) {
        delete sanitizedGauge[key];
      }
    }
    // An empty tick list means "generate from min and max" (see the card), so remove it
    if (Array.isArray(sanitizedGauge.majorTicks) && sanitizedGauge.majorTicks.length === 0) {
      delete sanitizedGauge.majorTicks;
    }
    const config = sanitizeCardColors(
      withoutEmpty({ ...value, gauge: withoutEmpty(sanitizedGauge) }),
    );

    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  // Picks out the gauge color fields whose current value a canvas cannot use,
  // plus highlight colors keyed by index, so they can stay visible as an
  // errored draft instead of being dropped silently from the form
  private _collectInvalidGaugeColors(data: Record<string, any>): {
    colors: Record<string, any>;
    highlights: Record<number, string>;
  } {
    const colors: Record<string, any> = {};
    for (const [key, color] of Object.entries(data)) {
      if (key.startsWith("color") && isInvalidColor(color, false)) {
        colors[key] = color;
      }
    }
    const highlights: Record<number, string> = {};
    if (Array.isArray(data.highlights)) {
      data.highlights.forEach((highlight: any, i: number) => {
        if (highlight && isInvalidColor(highlight.color, false)) {
          highlights[i] = highlight.color;
        }
      });
    }
    return { colors, highlights };
  }

  // Card-level colors. background_color and name_color allow var(--token);
  // only values CSS itself cannot parse are rejected
  private _collectInvalidCardColors(data: Record<string, any>): Record<string, any> {
    const draft: Record<string, any> = {};
    for (const key of ["background_color", "name_color"]) {
      if (isInvalidColor(data[key], true)) {
        draft[key] = data[key];
      }
    }
    return draft;
  }

  protected render(): TemplateResult | void {
    if (!this.hass || !this._config) {
      return html``;
    }

    const radial = this._config.gauge?.type !== "linear-gauge";
    return html`
      <ha-form
        .hass=${this.hass}
        .data=${this._data}
        .schema=${this._schema(radial)}
        .error=${this._errors(radial)}
        .computeLabel=${this._computeLabel}
        .computeHelper=${this._computeHelper}
        @value-changed=${this._valueChanged}
      ></ha-form>
      <p class="yaml-note">
        ${localize("editor.yaml_note")}
        <a
          href="https://canvas-gauges.com/documentation/user-guide/configuration"
          target="_blank"
          rel="noopener noreferrer"
        >${localize("editor.yaml_note_link")}</a>
      </p>
    `;
  }

  static get styles(): CSSResult {
    return css`
      .yaml-note {
        margin: 16px 0 0 0;
        font-size: 14px;
        color: var(--secondary-text-color);
      }
      /* Underlined and primary text color so the link is not identified by color alone
         and keeps 4.5:1 contrast */
      .yaml-note a {
        color: var(--primary-text-color);
        text-decoration: underline;
      }
    `;
  }
}
