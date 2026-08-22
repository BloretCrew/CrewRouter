/**
 * i18n.js patch: allow explicit empty-string translations (key present with ''
 * means "render nothing") — needed for Chinese measure-word fragments (个/页/共)
 * that have no English counterpart. Missing key still falls back to the key.
 *
 * Applied by scripts/i18n-round2/patch-empty-i18n.py
 */
