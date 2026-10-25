/**
 * Blora Design 2.0 package entry point.
 *
 * This modern ESM entry is side-effect free and safe to import during SSR.
 * The version is injected from package.json by Vite.
 *
 * @packageDocumentation
 */
export declare const VERSION: string;
/** SSR-safe check for a browser environment. */
export declare function isBrowser(): boolean;
export { BloraElement } from "./core/blora-element.js";
export { t, setLocale, getLocale, applyDocumentLocale, registerLocale, localeMonths, localeDow, localeCollator, type BloraLocalePack, type BloraMessages, } from "./core/i18n.js";
export { en as localeEn } from "./locales/en.js";
export { zhCN as localeZhCN } from "./locales/zh-CN.js";
export { createBloraIcon, isBloraIconName, registerBloraIcons, type BloraIconName, } from "./core/icons.js";
export { hydrateIcons, observeIcons } from "./core/icon-hydration.js";
export { OverlayController, type OverlayOptions } from "./controllers/overlay-controller.js";
export { enhanceButtons, setButtonLoading, type ButtonLoadingOptions, } from "./components/button/index.js";
export { enhanceBadges } from "./components/badge/index.js";
export { BloraDialog, defineBloraDialog, BLORA_DIALOG_TAG, type BloraDialogOpenDetail, type BloraDialogCloseDetail, } from "./components/dialog/index.js";
export { BloraSelect, defineBloraSelect, BLORA_SELECT_TAG, type BloraOptionData, } from "./components/select/index.js";
export { BLORA_TABS_TAG, BloraTabs, defineBloraTabs } from "./components/tabs/index.js";
export { BLORA_DROPDOWN_TAG, BloraDropdown, defineBloraDropdown, } from "./components/dropdown/index.js";
export { BLORA_SLIDER_TAG, BloraSlider, defineBloraSlider } from "./components/slider/index.js";
export { BLORA_RANGE_TAG, BloraRange, defineBloraRange } from "./components/range/index.js";
export { BLORA_RATE_TAG, BloraRate, defineBloraRate } from "./components/rate/index.js";
export { BLORA_CAROUSEL_TAG, BloraCarousel, defineBloraCarousel, } from "./components/carousel/index.js";
export { BLORA_TREE_TAG, BloraTree, defineBloraTree } from "./components/tree/index.js";
export { BLORA_AUTOCOMPLETE_TAG, BloraAutocomplete, defineBloraAutocomplete, } from "./components/autocomplete/index.js";
export { BLORA_MENTIONS_TAG, BloraMentions, defineBloraMentions, type MentionOption, } from "./components/mentions/index.js";
export { BLORA_OTP_TAG, BloraOtp, defineBloraOtp } from "./components/otp/index.js";
export { BLORA_CASCADER_TAG, BloraCascader, defineBloraCascader, type CascaderNode, } from "./components/cascader/index.js";
export { BLORA_DATEPICKER_TAG, BloraDatepicker, defineBloraDatepicker, } from "./components/datepicker/index.js";
export { BLORA_TIMEPICKER_TAG, BloraTimepicker, defineBloraTimepicker, } from "./components/timepicker/index.js";
export { BLORA_SPLITTER_TAG, BloraSplitter, defineBloraSplitter, } from "./components/splitter/index.js";
export { BLORA_TOUR_TAG, BloraTour, defineBloraTour } from "./components/tour/index.js";
export { BLORA_DOCK_TAG, BloraDock, defineBloraDock } from "./components/dock/index.js";
export { BLORA_MEGAMENU_TAG, BloraMegamenu, defineBloraMegamenu, } from "./components/megamenu/index.js";
export { BLORA_SPEED_DIAL_TAG, BloraSpeedDial, defineBloraSpeedDial, } from "./components/speed-dial/index.js";
export { BLORA_SEARCH_TAG, BloraSearch, defineBloraSearch } from "./components/search/index.js";
export { BLORA_COLOR_PICKER_TAG, BloraColorPicker, defineBloraColorPicker, } from "./components/color-picker/index.js";
export { BLORA_COPY_TAG, BloraCopy, defineBloraCopy } from "./components/copy/index.js";
export { BLORA_TRANSFER_TAG, BloraTransfer, defineBloraTransfer, } from "./components/transfer/index.js";
export { BLORA_FIELD_TAG, BloraField, defineBloraField } from "./components/field/index.js";
export { BLORA_CALENDAR_TAG, BloraCalendar, defineBloraCalendar, } from "./components/calendar/index.js";
export { BLORA_DECK_TAG, BloraDeck, defineBloraDeck } from "./components/deck/index.js";
export { BLORA_TAGS_INPUT_TAG, BloraTagsInput, defineBloraTagsInput, } from "./components/tags-input/index.js";
export { BLORA_UPLOAD_TAG, BloraUpload, defineBloraUpload } from "./components/upload/index.js";
export { BLORA_COMMAND_TAG, BloraCommand, defineBloraCommand, } from "./components/command-palette/index.js";
export { BLORA_COLLAPSE_TAG, BloraCollapse, defineBloraCollapse, } from "./components/collapse/index.js";
export { BLORA_DRAWER_TAG, BloraDrawer, defineBloraDrawer } from "./components/drawer/index.js";
export { BLORA_TOOLTIP_TAG, BloraTooltip, defineBloraTooltip } from "./components/tooltip/index.js";
export { BLORA_POPOVER_TAG, BloraPopover, defineBloraPopover } from "./components/popover/index.js";
export { BLORA_SEGMENTED_TAG, BloraSegmented, defineBloraSegmented, } from "./components/segmented/index.js";
export { BLORA_PAGINATION_TAG, BloraPagination, defineBloraPagination, } from "./components/pagination/index.js";
export { BLORA_CHECKBOX_TAG, BloraCheckbox, defineBloraCheckbox, } from "./components/checkbox/index.js";
export { createMessageElement, message, type MessageApi, type MessageHandle, type MessageOptions, type MessageType, } from "./components/message/index.js";
export { createTableController, type TableController, type TableControllerOptions, type TableColConfig, type TableRowData, } from "./components/table/index.js";
export { BLORA_POPCONFIRM_TAG, BloraPopconfirm, defineBloraPopconfirm, } from "./components/popconfirm/index.js";
export { BLORA_PROGRESS_TAG, BloraProgress, defineBloraProgress, } from "./components/progress/index.js";
export { BLORA_NUMBER_INPUT_TAG, BloraNumberInput, defineBloraNumberInput, } from "./components/number-input/index.js";
export { BLORA_SWAP_TAG, BloraSwap, defineBloraSwap } from "./components/swap/index.js";
export { BLORA_ACCORDION_TAG, BloraAccordion, defineBloraAccordion, } from "./components/accordion/index.js";
export { BLORA_IMAGE_TAG, BloraImage, defineBloraImage, openImagePreview, type ImagePreviewHandle, type ImagePreviewItem, } from "./components/image/index.js";
export { BLORA_TREE_SELECT_TAG, BloraTreeSelect, defineBloraTreeSelect, type TreeSelectOption, } from "./components/tree-select/index.js";
export { BLORA_ALERT_TAG, BloraAlert, defineBloraAlert } from "./components/alert/index.js";
export { BLORA_BANNER_TAG, BloraBanner, defineBloraBanner } from "./components/banner/index.js";
export { BLORA_BREADCRUMB_TAG, BloraBreadcrumb, defineBloraBreadcrumb, } from "./components/breadcrumb/index.js";
export { BLORA_CHART_CONTAINER_TAG, BloraChartContainer, defineBloraChartContainer, } from "./components/chart-container/index.js";
export { BLORA_CHAT_TAG, BloraChat, defineBloraChat } from "./components/chat/index.js";
export { BLORA_COMMENT_TAG, BloraComment, defineBloraComment } from "./components/comment/index.js";
export { BLORA_EMPTY_TAG, BloraEmpty, defineBloraEmpty } from "./components/empty/index.js";
export { BLORA_MOCKUP_TAG, BloraMockup, defineBloraMockup } from "./components/mockup/index.js";
export { BLORA_NAVBAR_TAG, BloraNavbar, defineBloraNavbar } from "./components/navbar/index.js";
export { BLORA_SIDEBAR_NAV_TAG, BloraSidebarNav, defineBloraSidebarNav, type BloraSidebarNavChangeDetail, } from "./components/sidebar-nav/index.js";
export { BLORA_RESULT_TAG, BloraResult, defineBloraResult } from "./components/result/index.js";
export { BLORA_TIMELINE_TAG, BloraTimeline, defineBloraTimeline, } from "./components/timeline/index.js";
export { createFormController, getFormValues, type FormController, type FormValidateResult, } from "./components/form/index.js";
export { BLORA_BACKTOP_TAG, BloraBacktop, defineBloraBacktop, initBackTop, type BackTopOptions, } from "./components/backtop/index.js";
export { createNotificationElement, notify, createNotificationController, type NotificationOptions, type NotificationHandle, type NotificationPlacement, } from "./components/notification/index.js";
export { BLORA_STEPS_TAG, BloraSteps, defineBloraSteps } from "./components/steps/index.js";
export { BLORA_STATISTIC_TAG, BloraStatistic, defineBloraStatistic, } from "./components/statistic/index.js";
export { BLORA_RADIO_TAG, BloraRadio, defineBloraRadio } from "./components/radio/index.js";
export { BLORA_SWITCH_TAG, BloraSwitch, defineBloraSwitch } from "./components/switch/index.js";
//# sourceMappingURL=index.d.ts.map