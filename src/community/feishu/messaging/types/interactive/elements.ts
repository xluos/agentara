import type { Color, TextAlign, TextSize } from "./styles";

export interface BaseElement<T extends string = string> {
  tag: T;
  element_id?: string;
}

export interface BaseContainer<
  T extends string = string,
> extends BaseElement<T> {
  elements: Element[];
}

export interface PlainTextElement extends BaseElement<"plain_text"> {
  content: string;
  text_size?: TextSize;
  text_color?: Color;
  text_align?: TextAlign;
  lines?: number;
}

export interface StandardIconElement extends BaseElement<"standard_icon"> {
  token: string;
  color?: Color;
  size?: string;
}

export interface CustomIconElement extends BaseElement<"custom_icon"> {
  img_key: string;
  size?: string;
}

export type IconElement = StandardIconElement | CustomIconElement;

export interface DivElement extends BaseElement<"div"> {
  tag: "div";
  icon?: IconElement;
  text?: PlainTextElement;
  margin?: string;
  width?: string;
}

export interface MarkdownElement extends BaseElement<"markdown"> {
  tag: "markdown";
  icon?: IconElement;
  margin?: string;
  text_size?: TextSize;
  text_align?: TextAlign;
  content: string;
}

export interface CollapsiblePanel extends BaseContainer<"collapsible_panel"> {
  direction?: "vertical" | "horizontal";
  vertical_spacing?: string;
  horizontal_spacing?: string;
  vertical_align?: "top" | "center" | "bottom";
  horizontal_align?: "left" | "center" | "right";
  padding?: string;
  margin?: string;
  expanded?: boolean;
  background_color?: Color;
  border?: {
    color?: Color;
    corner_radius?: string;
  };
  header: {
    title: PlainTextElement | MarkdownElement;
    background_color?: Color;
    vertical_align?: "top" | "center" | "bottom";
    padding?: string;
    position?: "top" | "bottom";
    width?: string;
    icon?: IconElement;
    icon_position?: "left" | "right" | "follow_text";
    icon_expanded_angle?: number;
  };
}

/**
 * Generic callback value on an interactive element. Our `/init` flow uses
 * `{ action: string; init_id: string; ... }`, but we keep the shape open so
 * future interactive commands can attach whatever discriminator they need.
 * The server receives this verbatim on `card.action.trigger`.
 */
export type CallbackValue = Record<string, unknown>;

export interface CallbackBehavior {
  type: "callback";
  value: CallbackValue;
}

/**
 * Button. Two modes:
 * - `action_type: "form_submit"` — submits the enclosing form; the triggered
 *   action payload includes `form_value` (a map of every named input/checker
 *   inside the form).
 * - no `action_type` + `behaviors: [{ type: "callback", value }]` — a standalone
 *   callback that delivers `value` as `action.value` on the server event.
 */
export interface ButtonElement extends BaseElement<"button"> {
  name?: string;
  text: PlainTextElement;
  type?: "default" | "primary" | "danger" | "text";
  action_type?: "form_submit" | "form_reset";
  behaviors?: CallbackBehavior[];
  width?: string;
}

/**
 * Single-line text input. `name` is the field key echoed back in the form
 * submission's `form_value`.
 */
export interface InputElement extends BaseElement<"input"> {
  name: string;
  placeholder?: PlainTextElement;
  default_value?: string;
  width?: string;
  max_length?: number;
}

/**
 * Single toggle checkbox. `name` is the field key; `checked` is the initial
 * state; on form submission, the server echoes a boolean at `form_value[name]`.
 *
 * Note: Feishu requires `text` to be `plain_text`. Passing `markdown` yields
 * "type of element is not supported tag: markdown" (error 200621).
 */
export interface CheckerElement extends BaseElement<"checker"> {
  name: string;
  text: PlainTextElement;
  checked?: boolean;
}

export interface SelectOption {
  text: PlainTextElement;
  value: string;
}

/**
 * Single-select dropdown. On form submission the selected `value` is echoed at
 * `form_value[name]`.
 */
export interface SelectStaticElement extends BaseElement<"select_static"> {
  name: string;
  placeholder?: PlainTextElement;
  initial_option?: string;
  options: SelectOption[];
  width?: string;
}

/** One column inside a `column_set`. */
export interface Column extends BaseContainer<"column"> {
  width?: "auto" | "weighted" | "fill" | string;
  weight?: number;
  vertical_align?: "top" | "center" | "bottom";
  vertical_spacing?: string;
  padding?: string;
}

/**
 * Horizontal row of columns. Useful for placing a checker next to its input
 * and description on a single card row.
 */
export interface ColumnSetElement extends BaseElement<"column_set"> {
  flex_mode?: "none" | "stretch" | "flow" | "bisect" | "trisect";
  horizontal_spacing?: string;
  columns: Column[];
}

/**
 * Form container. Any inputs/checkers/buttons placed inside contribute to the
 * form's `form_value` on submit. `name` identifies the form on the server side.
 */
export interface FormElement extends BaseContainer<"form"> {
  name: string;
}

export type Element =
  | ButtonElement
  | CheckerElement
  | CollapsiblePanel
  | Column
  | ColumnSetElement
  | DivElement
  | FormElement
  | IconElement
  | InputElement
  | MarkdownElement
  | PlainTextElement
  | SelectStaticElement;
