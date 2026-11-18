export const DOCUMENT_MAX_BYTES = 6 * 1024 * 1024
export function documentFileError(file) {
  if (!file || typeof file.name !== 'string' || !/\.(txt|md)$/i.test(file.name)) return '请选择 TXT 或 Markdown（.md）文件。'
  if (!Number.isFinite(file.size) || file.size <= 0) return '文件为空，请选择有内容的小说或剧本。'
  if (file.size > DOCUMENT_MAX_BYTES) return '文件超过 6 MB，请分卷导入。'
  return ''
}
export function isFileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files') }
export function droppedDocument(event) {
  const transfer = event.dataTransfer, files = Array.from(transfer?.files || [])
  if (files.length !== 1) throw Error('请一次拖入一个小说或剧本文件。')
  if (Array.from(transfer?.items || []).some(item => item.webkitGetAsEntry?.()?.isDirectory)) throw Error('请拖入文件，不支持直接拖入文件夹。')
  const error = documentFileError(files[0]); if (error) throw Error(error)
  return files[0]
}
