import type { NarrativeGroup, ScriptUnitSpeechBudget } from './skill-storyboard-contract.js'
import type { ValidationIssue } from './storyboard-validation.js'

const compact = (text: string) => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
/** Sentences of one original utterance, cut only after existing sentence punctuation. */
const sentences = (text: string) => text.split(/(?<=[。！？；!?;…])/u).filter(sentence => compact(sentence))

/**
 * While another group is still failing, the whole-episode review cannot run,
 * so a finished group's missing original words stay hidden (real 第1集 g8).
 * Report only words that are certainly missing: a sentence of a line that this
 * group alone owns, spoken by no storyboard in the episode at all. Everything
 * else (order, speakers, words moved to a neighbour) is left to the existing
 * whole-episode review, so no finished group is rejected on a stricter rule.
 *
 * `groupSpeech` and every `episodeSpeech` entry are compacted spoken words
 * (see assignmentSpeech); `episodeSpeech` covers every stored storyboard.
 */
export function missingOwnSpeech(input: {
  plan: readonly NarrativeGroup[]; budgets: readonly ScriptUnitSpeechBudget[]; groupNumber: number; episodeSpeech: readonly string[]
}): ValidationIssue[] {
  const planned = input.plan.find(row => row.number === input.groupNumber)
  if (!planned) return []
  const owners = new Map<number, number>()
  for (const row of input.plan) for (const id of new Set(row.source_ids)) owners.set(id, (owners.get(id) || 0) + 1)
  const issues: ValidationIssue[] = []
  for (const id of new Set(planned.source_ids)) {
    if (owners.get(id) !== 1) continue
    for (const utterance of input.budgets.find(budget => budget.source_id === id)?.utterances || []) {
      const missing = sentences(utterance.text).filter(sentence => !input.episodeSpeech.some(speech => speech.includes(compact(sentence))))
      if (!missing.length) continue
      const speaker = utterance.speaker || '原文'
      issues.push({ code: 'dialogue_coverage', field: `source_ids.${id}`, severity: 'error', shotNumber: input.groupNumber,
        message: `剧本原文单元${id}：原文发声未在应有位置完整覆盖：${speaker}的原词${missing.map(sentence => `「${sentence}」`).join('')}没有逐字出现在任何一组的正文中（可能漏说，或说成了别的字）；请在本组对应位置逐字写出这句原词，不改其他组；请补齐第${input.groupNumber}组，其他已完成组可继续保留。` })
    }
  }
  return issues
}
