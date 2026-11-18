/** Reuse the toast's own close action, so only this notification is dismissed. */
export function dismissToastInteraction(event) {
  if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return false
  const target=event.target
  if (!target?.closest || target.closest('button,a,input,textarea,select,[contenteditable="true"],[role="button"]')) return false
  const toast=target.closest('[data-sonner-toast]')
  if (!toast || toast.dataset?.dismissible === 'false') return false
  const close=toast.querySelector('[data-close-button]')
  if (!close || close.disabled || close.dataset?.disabled === 'true') return false
  if (event.type === 'keydown') event.preventDefault()
  close.click()
  return true
}
