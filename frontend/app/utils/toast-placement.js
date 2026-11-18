/** Keep notifications immediately below the main navigation, above page actions. */
export function notificationTop(doc, height) {
  for (const selector of ['.studio-topbar','.header']) {
    for (const node of doc.querySelectorAll(selector)) {
      const rect=node.getBoundingClientRect()
      if (rect.height>0 && rect.top>=0 && rect.bottom<height-120) return Math.max(16,Math.round(rect.bottom+8))
    }
  }
  return Math.min(72,Math.max(16,height-120))
}
