/**
 * i18n 实例（模块级单例）
 * - 实例放独立模块而非插件内：useAgent/useMigrateState 等 setup 外代码
 *   需要 `import { i18n }` 直接用 i18n.global.t
 * - 界面固定中文；启动时覆盖旧浏览器的非中文偏好，不影响后台 AI 内容语言
 * - legacy:false 必须显式，否则 global.locale 不是 ref 无法运行时切换
 */
import { createI18n } from 'vue-i18n'
import zh from '../locales/zh.json'
import en from '../locales/en.json'
import ja from '../locales/ja.json'
import ko from '../locales/ko.json'

export const LOCALE_STORAGE_KEY = 'huobao:locale'

export type UiLocale = 'zh' | 'en' | 'ja' | 'ko'

export const UI_LOCALES: Array<{ value: UiLocale; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

export function readStoredLocale(): UiLocale {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh')
  } catch { /* localStorage 不可用时仍使用中文 */ }
  return 'zh'
}

export function persistLocale(_locale: UiLocale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'zh')
  } catch { /* 忽略持久化失败 */ }
}

export const i18n = createI18n({
  legacy: false,
  locale: readStoredLocale(),
  fallbackLocale: 'zh',
  messages: { zh, en, ja, ko },
  missingWarn: false,
  fallbackWarn: false,
})

/** Compatibility for old callers: keep the interface Chinese without touching AI defaults. */
export function setUiLocale(_locale: UiLocale) {
  i18n.global.locale.value = 'zh'
  persistLocale('zh')
}
