import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskProgress } from '../utils/task-logger.js'
import { baseNameOf, parseVoiceCard, serializeVoiceCard, withSharedTimbre, type VoiceCard } from './character-voice-card.js'

/**
 * After voice cards are written, line up age variants of one person
 * (user decision 2026-11-06: an aged version gets its own card linked to the
 * young character, with the same core timbre):
 * - "老年高大山" ↔ "高大山" are found by name; the younger (base-name) character
 *   is the reference, the age variant links to it.
 * - The variant's core timbre becomes the base character's; its age feel and
 *   register stay its own. Only automatic cards are aligned, a card the user
 *   edited ('manual') is never changed.
 * Returns what was changed, for logging.
 */
export async function alignVoiceCardVariants(dramaId: number) {
  const rows = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId))).filter(row => !row.deletedAt)
  const changes: string[] = []
  for (const row of rows) {
    const card = parseVoiceCard(row.voiceCard)
    if (!card) continue
    const baseName = baseNameOf(row.name)
    const base = baseName ? rows.find(other => other.name === baseName) : undefined
    const baseCard = base ? parseVoiceCard(base.voiceCard) : null
    if (base && baseCard) {
      // Age variant: link to the base person and share its core timbre.
      let next: VoiceCard = card.origin === 'manual' ? card : withSharedTimbre(card, baseCard)
      if (next.linked_character_id !== base.id) next = { ...next, linked_character_id: base.id }
      if (JSON.stringify(next) !== JSON.stringify(card)) {
        const serialized = serializeVoiceCard(next)
        if (serialized.value) {
          await db.update(schema.characters).set({ voiceCard: serialized.value, updatedAt: now() }).where(eq(schema.characters.id, row.id))
          changes.push(`${row.name} → ${base.name}${next.fixed.timbre !== card.fixed.timbre ? `（核心音色统一为「${next.fixed.timbre}」）` : ''}`)
        }
      }
      // The base person is the reference; it does not point back at its variant.
      if (baseCard.linked_character_id === row.id && baseCard.origin !== 'manual') {
        const serialized = serializeVoiceCard({ ...baseCard, linked_character_id: null })
        if (serialized.value) {
          await db.update(schema.characters).set({ voiceCard: serialized.value, updatedAt: now() }).where(eq(schema.characters.id, base.id))
          changes.push(`${base.name} 作为基准，不再指向 ${row.name}`)
        }
      }
    }
  }
  if (changes.length) logTaskProgress('VoiceCard', 'align-variants', { dramaId, changes })
  return changes
}
