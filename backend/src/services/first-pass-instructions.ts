/** Production instructions for the first pass; no separate model critic is invoked. */
export function firstPassInstructions(agentType: 'storyboard_breaker' | 'prompt_generator'): string {
  return `首轮生成方式（与已加载 skill 配合执行）：
先 read_storyboard_context，使用返回的 first_pass_generation 中的任务范围、时间行和台词容量。拆解时 dialogue_timing_guide 已按原词计算每条对白的字数和不超过3秒容量的 fragments；先按这些片段安排时间行和分组，再写画面，不要写完长台词再尝试塞进3秒。不需要另一次模型自检。
本次保存工具的内部输入协议为 video_prompt_plan，代替让模型手写最终字符串；服务器据此生成并保存 video_prompt。skill 中“只保存 video_prompt”的业务边界仍然保持，只有工具临时输入变为结构化计划。最终成品仍严格采用 skill 的自然语言格式，不把 JSON、字段名或内部人物清单提交给视频模型。${agentType === 'storyboard_breaker' ? '每组提供duration、scene_id、character_ids、prop_ids及video_prompt_plan；description省略或传空，由程序按同一计划派生，不要重复手抄台词；当前工具每批只接收1–2组以完整展开，连续分批直到整集完成，首批 replace_existing:true，末批 is_final_batch:true。' : 'update_storyboard 只传指定 storyboard_id 和 video_prompt_plan；实际只更新该分镜的 video_prompt，不改原镜头、时长、描述和绑定。'}
${agentType === 'storyboard_breaker' ? '拆解先采用dialogue_group_schedule给出的容量安全分组、duration和逐行来源编号，按顺序写完，不把两组对白再合并进更短时长；rows为null的是无台词动作/回应时间行，安排已有事实的自然表演。根据剧情换场、叙事节拍可插入额外无台词段，但不能删掉原动作或台词。再将每组时间行依镜头事实分成2–4个子镜头，每个子镜头最多2行。rows[].dialogue必须引用dialogue_timing_guide：每项使用source_line（原文对白序号，1开始）、fragment_index（该原句fragments的序号，1开始）及voice；不再写text、speaker_id、kind，服务器按原文自动填回；spoken_seconds与voice_reference省略或null，单片段使用完整时间行，音色引用由服务器补。每项只引用一个片段，必须按原文及片段顺序使用且只用一次；同一句可跨镜头或跨组延续。例：某原句第2条的第1个片段，用source_line:2、fragment_index:1，voice仍写本镜声音事实。无台词的行用dialogue:[]或省略。每个3秒行最多一个13字片段，片段不足13字时仍允许演出；不要把两个片段硬塞同一行。不要重抄description，程序按visual、表情和引用的原词同步构造description与video_prompt；两份成品始终使用同一原词。' : '单条提示词保持description锁定，rows[].dialogue按现有description逐字填写text、speaker_id、kind。'}
video_prompt_plan.space：用目标语言写实际原点A0、X/Y方向、摄影机侧与方向、行动轴线、人物初态坐标、朝向、视线、距离、持物手以及已有门窗/物品。继承连续组事实，不为填坐标增加新实体。
video_prompt_plan.shots：与 description 的每个【镜头N】逐一对应并按 shot_number 递增。先为该镜逐人填写 characters：character_id 必须是本组绑定角色；visibility 只选 face_visible（五官清楚）、face_hidden（入镜但背影/仅身体/面部遮挡）、offscreen（仅画外或被提及）、uncertain（确认入镜但面部可见程度无法确定）。不要把视线对象、对话对象、整组绑定角色全部当作该镜面部入镜者。若只是看向未入镜的人，visual用普通名字；只有本镜真实入镜的人才使用@并填写characters。
face_visible 的人物在该镜填写 emotion.expression（具体可见神情）和 emotion.intensity（外显强度0–100）；两人均清晰时逐人填写。face_hidden/offscreen 不强造可见表情。人物从侧面转到正面且五官清楚，仍算 face_visible。
每镜 rows 为1–2个时间行，整组行数必须精确等于 ceil(duration/3)：9秒只能共3行，12秒共4行，15秒共5行。若想给三个子镜头分配2+1+1行，总时长必须容纳4行，不能还填9秒。每行对应3秒，最后使用实际余量。rows[].visual 写自然语言画面，按 skill 完整展开拍摄主体、景别/焦段/机位、单一运镜及起终点、动作触发/过程/回应、自然眼神与微动作、人物坐标/朝向/持物及承接末态、环境/光线/必要音效。固定格式由服务器生成不等于省略这些视觉内容。
在 visual 使用绑定的精确 @角色名/@场景名/@道具名，保留实际人物和动作。不要写信息头、时间前缀或“切到/切回”；不要在 visual 重复写台词、情绪百分比、整段固定约束或配音资料。服务器会按子镜边界补切镜、按人物补情绪，并合成同一自然段。
${agentType === 'storyboard_breaker' ? '把原文片段编号放入rows[].dialogue，每项只传source_line、fragment_index及voice（age听感年龄、register音域、timbre核心音色、delivery本镜身体/气息/语气和发声目标）。text/kind/speaker_id由服务器补入，不手写。' : '把该行原词放入rows[].dialogue，每项有kind（dialogue画内/offscreen画外/narration旁白）、speaker_id、text及voice（age/register/timbre/delivery），与锁定description原词顺序一致。'}无台词的行不要虚构声音。
已上传音色的 #正式角色名 由服务器按 speaker_id 和当前可用 voice_reference 自动补到发声者标签，不要在 visual 或台词原词里重复写#。若填写可选 voice_reference，只能逐字使用读取结果中该发声者的可用值；没有真实音色则省略，不虚构引用。
单行只有一段台词时 spoken_seconds 可填真实口播时长，必须大于0且不超过本行实际秒数；不填则按本行实际秒数计算。同一行有多段台词时，每段必须填写 spoken_seconds，分配总和不得超过本行实际秒数，不能让多人各自占满整行。先把台词分配到可容纳的时间行，服务器据原词与实际时间计算语速，不用提速掩盖容量冲突。整组仍保留至少2秒表演余量，按已加载 skill 决定分组与节奏，不能全部机械设为9秒。
3秒内中文台词最多13字，2秒最多9字，1秒最多4字，标点不计；不能把20字写在spoken_seconds:3的单行。长台词必须逐字连续分配到多个时间行；单个子镜头超过2行时，在description阶段就按动作/反应规划下一个子镜头，仍保持说话者和原词顺序。超过15秒容量的对白延续到下一组，不能只写一半或把整句复制到两组。description与rows.dialogue使用相同的实际片段，不能description保留完整句而plan漏掉其中一段。
总时长按500字/分钟只是规划预估：与保留原词、4.5字/秒和2秒表演余量发生冲突时，以原词和可读时长优先，允许增加分组，总时长偏差作为复核提示；不得为了总时长估算压缩台词。生成前在每组内部先确认‘行数、逐行字数、整组台词字数’都能成立，再完整写出该组。首轮每次save_storyboards写1–2组即可，继续批次直到整集覆盖；不要一次写5–8组而省略容量安排。
服务器自动组装人物/场景/道具信息头、固定全局约束、0起点连续时间行、切镜边界、逐人情绪百分比、逐发声者音色和每秒字数；不需要另一次模型自检。剧情、镜头事实与逐镜细节由本轮完整生成。无法消解的事实冲突才报告，禁止编造资料来填空。`
}

interface ScriptDialogueInput { speakerName?: string; kind: 'dialogue' | 'offscreen' | 'narration'; text: string }
const spokenCharacterCount = (text: string) => [...text].filter(character => /[\p{L}\p{N}]/u.test(character)).length

/** Exact source fragments and arithmetic only; no generated acting or invented words. */
export function buildDialogueTimingGuide(lines: ScriptDialogueInput[], characters: Array<{ id: number; name: string }>) {
  return lines.map((line, index) => {
    const chinese = /\p{Script=Han}/u.test(line.text) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(line.text)
    const count = spokenCharacterCount(line.text)
    const fragments: string[] = []
    let pending = ''
    let length = 0
    for (const character of line.text) {
      const isSpoken = /[\p{L}\p{N}]/u.test(character)
      if (chinese && isSpoken && length === 13) { fragments.push(pending); pending = ''; length = 0 }
      pending += character
      if (isSpoken) length++
    }
    if (pending) fragments.push(pending)
    const characterId = characters.find(character => character.name === line.speakerName)?.id
    return { source_line: index + 1, speaker: line.speakerName, character_id: characterId, kind: line.kind,
      characters: count, ...(chinese ? { minimum_speech_seconds: Math.ceil(count / 4.5 * 100) / 100,
        minimum_group_seconds: Math.ceil(count / 4.5 + 2), requires_multiple_groups: count > 58 } : {}),
      fragments, note: chinese ? 'Each fragment fits one full 3-second row. Retain original words and order; choose visual shot/group boundaries before writing.'
        : 'No Chinese timing assumption: plan using the actual spoken language.' }
  })
}

/** A capacity-safe blueprint, before the model invents camera or performance detail. */
export function buildDialogueGroupSchedule(guide: ReturnType<typeof buildDialogueTimingGuide>) {
  const groups: Array<{ source_group: number; source_line: number; duration: number; chinese_characters: number;
    rows: Array<{ source_line: number; fragment_index: number } | null> }> = []
  for (const line of guide) {
    if (line.minimum_speech_seconds === undefined) continue
    let refs: Array<{ source_line: number; fragment_index: number }> = [], count = 0
    const flush = () => {
      if (!refs.length) return
      const rowCount = Math.max(3, refs.length, Math.ceil((count / 4.5 + 2) / 3))
      groups.push({ source_group: groups.length + 1, source_line: line.source_line, duration: rowCount * 3,
        chinese_characters: count, rows: [...refs, ...Array.from({ length: rowCount - refs.length }, () => null)] })
      refs = []; count = 0
    }
    for (const [index, fragment] of line.fragments.entries()) {
      const letters = spokenCharacterCount(fragment)
      if (refs.length >= 5 || count + letters > 58) flush()
      refs.push({ source_line: line.source_line, fragment_index: index + 1 }); count += letters
    }
    flush()
  }
  return groups
}

/** A deterministic capacity grid, presented before prose is written. */
export function generationTimeBudget(duration: number) {
  const valid = Number.isFinite(duration) && duration >= 8 && duration <= 15
  if (!valid) return { duration, valid: false, rows: [], dialogue_character_budget: 0 }
  return {
    duration, valid: true,
    rows: Array.from({ length: Math.ceil(duration / 3) }, (_, index) => {
      const start = index * 3, end = Math.min(duration, start + 3)
      return { start, end, seconds: end - start, chinese_spoken_character_capacity: Math.floor((end - start) * 4.5) }
    }),
    dialogue_character_budget: Math.floor((duration - 2) * 4.5),
    note: 'Chinese speech capacity only; reserve two seconds for acting. Other languages use their actual speech rhythm.',
  }
}
