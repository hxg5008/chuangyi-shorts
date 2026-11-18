/** Compatibility entry for old UI callers. AI defaults are administrator-only. */
import { setUiLocale, type UiLocale } from '~/composables/i18n'

export async function confirmUnifiedLanguage(lang: UiLocale) {
  setUiLocale(lang)
  return true
}
