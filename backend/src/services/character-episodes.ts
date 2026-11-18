/** Read-only episode usage of one saved character asset.
 * Uses existing extraction/manual links and storyboard bindings only. A saved
 * association does not assert that the character was actually visible on screen.
 * No text/name matching, extraction changes, model calls or new tables. */
import { db } from '../db/index.js'
import { assertResourceAccess, denied, requireActor, type Actor } from './platform-security/index.js'

export type CharacterEpisodeSource = 'episode_link' | 'storyboard_binding'
export interface CharacterEpisodeUsage {
  character_id: number
  drama_id: number
  total: number
  episodes: Array<{ id: number; episode_number: number; title: string; sources: CharacterEpisodeSource[] }>
}

export function characterEpisodeUsage(characterId: number, actor: Actor = requireActor()): CharacterEpisodeUsage {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) throw denied('角色编号无效', 400)
  // Also required when the service is used without the HTTP path middleware.
  // It rejects deleted characters/projects, foreign projects and disabled users.
  const dramaId = assertResourceAccess('character', characterId, undefined, actor)
  const rows = db.$client.prepare(`WITH linked AS (
    SELECT episode_id,1 AS episode_link,0 AS storyboard_binding
      FROM episode_characters WHERE character_id=?
    UNION ALL
    SELECT s.episode_id,0 AS episode_link,1 AS storyboard_binding
      FROM storyboard_characters sc JOIN storyboards s ON s.id=sc.storyboard_id
      WHERE sc.character_id=? AND s.deleted_at IS NULL
  )
  SELECT e.id,e.episode_number,e.title,
    max(linked.episode_link) AS episode_link,max(linked.storyboard_binding) AS storyboard_binding
    FROM linked JOIN episodes e ON e.id=linked.episode_id
    WHERE e.drama_id=? AND e.deleted_at IS NULL
    GROUP BY e.id,e.episode_number,e.title
    ORDER BY e.episode_number ASC,e.id ASC`).all(characterId, characterId, dramaId) as Array<{
      id: number; episode_number: number; title: string; episode_link: number; storyboard_binding: number
    }>
  const episodes = rows.map(row => ({ id: row.id, episode_number: row.episode_number, title: row.title,
    sources: [row.episode_link ? 'episode_link' : null, row.storyboard_binding ? 'storyboard_binding' : null]
      .filter((value): value is CharacterEpisodeSource => value !== null) }))
  return { character_id: characterId, drama_id: dramaId, total: episodes.length, episodes }
}
