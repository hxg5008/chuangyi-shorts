import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { skillSpokenTurns } from './skill-storyboard-validation.js'
import { splitQuotedText } from '../utils/quoted-text.js'
import type { ValidationIssue } from './storyboard-validation.js'

type Candidate = Record<string, any>
const object = (value: unknown): value is Candidate => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const fault = (field: string, message: string): ValidationIssue => ({ field, code: 'boundary_repair_scope', message, severity: 'error' })

/** The exact saved candidate is the optimistic concurrency boundary. */
export function boundaryVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
}

/** Classify an explicit report, never infer continuity facts from prose. */
export function isAdjacentBoundaryConflict(raw: unknown): boolean {
  if (!object(raw) || typeof raw.conflict !== 'string' || !raw.conflict.trim()) return false
  const field = typeof raw.field === 'string' ? raw.field : ''
  if (/duration|dialogue_budget|speech|voice|audio|台词|声音|时长|语速|口播/i.test(field)) return false
  if (/时长|语速|口播|台词容量|发声容量/u.test(raw.conflict)) return false
  if (['previous_ending', 'boundary_continuity'].includes(field)) return true
  return /上一组|前一组|previous[_ ](?:group|ending)/iu.test(raw.conflict)
    && /牵手|松手|持物|手持|状态|末态|矛盾|冲突|站位|位置|朝向|门窗|continuity|inconsisten|holding|state/iu.test(raw.conflict)
}

interface Shot { number: number; marker: string; body: string }
interface Row { line: number; prefix: string; body: string; ending: string; start: number; end: number }
interface Layout { prefix: string; shots: Shot[]; lines: string[]; rows: Row[]; counts: number[] }

function layout(value: unknown): Layout | null {
  if (!object(value) || typeof value.description !== 'string' || typeof value.video_prompt !== 'string'
    || typeof value.result !== 'string' || !value.result.trim() || !Number.isSafeInteger(value.shot_number)
    || !Number.isFinite(value.duration) || value.duration < 8 || value.duration > 15) return null
  const masked = splitQuotedText(value.description).map(part => part.quoted ? ' '.repeat(part.text.length) : part.text).join('')
  const marks = [...masked.matchAll(/【\s*(?:镜头|shot|ショット|컷)\s*(\d+)\s*】/giu)]
  if (marks.length < 2 || marks.length > 4 || marks.some((match, i) => Number(match[1]) !== i + 1)) return null
  const shots = marks.map((match, i) => ({ number: Number(match[1]), marker: value.description.slice(match.index!, match.index! + match[0].length),
    body: value.description.slice(match.index! + match[0].length, marks[i + 1]?.index ?? value.description.length) }))
  if (shots.some(shot => !shot.body.trim())) return null
  const lines: string[] = value.video_prompt.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line: string) => line.length > 0) || []
  const rows: Row[] = []
  for (const [line, text] of lines.entries()) {
    const match = text.match(/^(\s*(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|초)\s*[:：]\s*)([^\r\n]+)(\r\n|\n|\r)?$/iu)
    if (match) rows.push({ line, prefix: match[1], body: match[4], ending: match[5] || '', start: Number(match[2]), end: Number(match[3]) })
  }
  const counts: number[] = value.time_row_counts
  if (!Array.isArray(counts) || counts.length !== shots.length || counts.some(count => count !== 1 && count !== 2)
    || counts.reduce((a, b) => a + b, 0) !== rows.length || rows.length !== Math.ceil(value.duration / 3)
    || rows.some((row, i) => row.start !== i * 3 || row.end !== Math.min((i + 1) * 3, value.duration))) return null
  return { prefix: value.description.slice(0, marks[0].index!), shots, lines, rows, counts }
}

export function isCompleteBoundaryCandidate(value: unknown): value is Candidate { return layout(value) !== null }

export function prepareBoundaryRepair(previous: unknown, current: unknown, numbers: { previousNumber: number; currentNumber: number }) {
  const before = layout(previous)
  if (!before || !object(previous) || previous.shot_number !== numbers.previousNumber || numbers.currentNumber !== numbers.previousNumber + 1) return null
  const next = layout(current)
  if (next && object(current) && current.shot_number !== numbers.currentNumber) return null
  return {
    previousNumber: numbers.previousNumber, currentNumber: numbers.currentNumber,
    previousVersion: boundaryVersion(previous), currentVersion: boundaryVersion(current),
    previous: structuredClone(previous), current: next ? structuredClone(current) : null,
    editable: {
      previous: { descriptionShots: [before.shots.length], videoRows: Array.from({ length: before.counts.at(-1)! }, (_, i) => before.rows.length - before.counts.at(-1)! + i + 1), result: true },
      current: next ? { descriptionShots: [1], videoRows: Array.from({ length: next.counts[0] }, (_, i) => i + 1), result: false } : 'generate-complete-group',
    },
  }
}

function textFidelity(oldText: string, newText: string, names: string[]) {
  const typedIds = [...new Set([...oldText.matchAll(/\[\[character:(\d+)\]\]/gu), ...newText.matchAll(/\[\[character:(\d+)\]\]/gu)].map(match => match[1]))]
  const parseNames = [...names, ...typedIds.map(id => `boundary_character_${id}`)]
  const speech = (text: string) => skillSpokenTurns(text.replace(/\[\[character:(\d+)\]\]/gu, (_match, id) => `boundary_character_${id}`), parseNames)
    .map(({ speakerName, kind, text }) => ({ speakerName, kind, text }))
  const quotes = (text: string) => splitQuotedText(text).filter(part => part.quoted).map(part => part.text)
  const voices = (text: string) => [...text.matchAll(/\[\[voice:[^\]\r\n]+\]\]/gu)].map(match => match[0])
  return isDeepStrictEqual(speech(oldText), speech(newText)) && isDeepStrictEqual(quotes(oldText), quotes(newText))
    && isDeepStrictEqual(voices(oldText), voices(newText))
}

function validateSide(oldValue: unknown, newValue: unknown, side: 'previous' | 'current', names: string[]): ValidationIssue[] {
  const old = layout(oldValue), next = layout(newValue), errors: ValidationIssue[] = []
  if (!object(oldValue) || !object(newValue) || !old || !next) return [fault(side, '相邻修复缺少可可靠定位的完整镜头和时间行，未授权扩大修改范围。')]
  const editable = new Set(side === 'previous' ? ['description', 'video_prompt', 'result'] : ['description', 'video_prompt'])
  for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
    if (!editable.has(key) && !isDeepStrictEqual(oldValue[key], newValue[key])) errors.push(fault(side + '.' + key, `相邻修复不能改变锁定字段 ${key}。`))
  }
  const shotIndex = side === 'previous' ? old.shots.length - 1 : 0
  if (old.prefix !== next.prefix || old.shots.length !== next.shots.length || old.shots.some((shot, index) =>
    shot.marker !== next.shots[index]?.marker || index !== shotIndex && shot.body !== next.shots[index]?.body)) {
    errors.push(fault(side + '.description', `仅允许修改${side === 'previous' ? '前组末镜' : '后组首镜'}正文，其他镜头及顺序必须保留。`))
  }
  const first = side === 'previous' ? old.rows.length - old.counts.at(-1)! : 0
  const end = side === 'previous' ? old.rows.length : old.counts[0]
  const selected = new Set(old.rows.slice(first, end).map(row => row.line))
  if (old.lines.length !== next.lines.length || old.rows.length !== next.rows.length
    || old.lines.some((line, index) => !selected.has(index) && line !== next.lines[index])
    || old.rows.some((row, index) => row.line !== next.rows[index]?.line || row.prefix !== next.rows[index]?.prefix || row.ending !== next.rows[index]?.ending)) {
    errors.push(fault(side + '.video_prompt', '只能修改对应边界子镜的时间行正文；信息头、其他行、时间前缀和换行保持不变。'))
  }
  for (const field of editable) {
    if (!textFidelity(oldValue[field], newValue[field], names)) errors.push(fault(side + '.' + field, '边界修复不能改变已存在的原词、发声者、声音类型或声音锚点。'))
  }
  return errors
}

/** This validates edit boundaries only. Full content/plan checks still run before the pair commits. */
export function validateBoundaryRepairScope(previous: unknown, repairedPrevious: unknown, current: unknown, repairedCurrent: unknown, names: string[] = []): ValidationIssue[] {
  const errors = validateSide(previous, repairedPrevious, 'previous', names)
  if (layout(current)) errors.push(...validateSide(current, repairedCurrent, 'current', names))
  else if (!layout(repairedCurrent)) errors.push(fault('current', '后组必须返回完整且时间结构明确的分镜，仍需通过常规内容检查。'))
  return errors
}
