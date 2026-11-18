/** Shared camera-reference semantics; a gaze or dialogue target is not automatically pictured. */
export function isReferencedTargetOnly(text: string, referenceIndex: number, nameLength: number, markerLength = 1): boolean {
  const prefix = text.slice(0, referenceIndex).split(/[，,。！？!?；;\n]/).at(-1)!.slice(-80)
  const suffix = text.slice(referenceIndex + nameLength + markerLength).split(/[。！？!?；;\n@]/)[0].trimStart()
  // A stated visual sense plus a bounded direction is one grammatical class,
  // rather than a separate whitelist for every 落到/落在/转回 combination.
  const directedGaze = prefix.match(/(?:目光|视线|眼神|抬眼|垂眼)[^@，,。；;！？!?\n]{0,12}?(?:向|到|在|回|过)(?:了)?([^@，,。；;！？!?\n]{0,24})$/u)
  const gaze = directedGaze
    || prefix.match(/(?:[看望盯瞥瞟扫瞄瞪](?:[向着住过]了?|了[看望盯瞥瞟扫瞄瞪]?)|注视|追视|凝视|面向|面对)([^@，,。；;！？!?\n]{0,24})$/u)
    || prefix.match(/\b(?:looks?|looked|looking|gazes?|gazed|gazing|stares?|glances?)\s+(?:at|towards?|to)\s+([^@，,。；;！？!?\n]{0,40})$/iu)
  const gazeFrom = prefix.match(/(?:目光|视线|眼神)(?:(?:缓缓|慢慢|逐渐|轻轻|直直|终于|开始|忽然|突然|先|再)\s*)*(从|离开|移开)\s*$/u)
  const addressed = /(?:询问|问向|告诉|回答|回应)[^@，,。；;！？!?\n]{0,16}$/u.test(prefix)
    || /\b(?:asks?|tells?|answers?|speaks?\s+to|talks?\s+to)\s+[^@，,。；;！？!?\n]{0,24}$/iu.test(prefix)
    || /(?:对着?|朝着?|向)[^@，,。；;！？!?\n]{0,16}$/u.test(prefix)
      && /^(?:轻声|低声|缓缓|小声|继续|开口|温声|柔声|平静地|轻轻地|\s)*(?:说|问|喊|讲|询问|解释|回答|回应|发问)/u.test(suffix)
  if (!gaze && !gazeFrom && !addressed) return false
  // A camera/framing qualifier is evidence of a pictured subject, not merely a
  // person's gaze target. Bare 和/与/向 never grant this exemption either.
  if (gaze && /镜头|画面|入镜|特写|近景|中景|camera|frame|close[- ]?up/iu.test(gaze[1])) return false
  if (directedGaze && /镜头|画面|摄影机|摄像机|入镜|特写|近景|中景|camera|frame/iu.test(directedGaze[0])) return false
  if (gaze && /(?:镜头|画面|摄影机|摄像机|camera|frame)\s*(?:(?:缓缓|慢慢|轻轻|持续|正在|快速|横向|纵向|直接|顺势|再次|正|仍|先|再|slowly|steadily)\s*)*$/iu.test(prefix.slice(0, gaze.index))) return false
  const own = suffix.replace(/^[（(]\s*/, '')
  // An explicitly attributed action after the target still depicts that person;
  // an unnamed continuation such as the observer's eyelids never gets reassigned.
  if (gaze && /(?:^|[，,])\s*(?:对方|后者)(?:的)?\s*(?:(?:正在|缓缓|慢慢|轻轻|突然|仍然|继续|正|仍)\s*)*(?:站在|坐在|抬手|抬起|抬眼|点头|转头|转身|起身|伸手|迈步|握住|拿起|放下|眨眼|轻眨|微笑|皱眉|(?:表情|神情).{0,4}(?:变化|改变)|(?:双手|眼睛|双眼|眼睑|嘴角|眉眼).{0,6}(?:抬|放|握|攥|眨|颤|上扬|收紧|变化))/u.test(own)) return false
  if (directedGaze) {
    // Keep the existing explicit body/framing barriers for directional targets.
    // A small unnamed blink or brow adjustment is the observer's continuation,
    // while stated acting or visible framing cannot hide behind gaze grammar.
    if (/(?:^|[，,])\s*(?:(?:对方|后者|其)\s*)?(?:(?:正在|缓缓|慢慢|轻轻|突然|仍然|继续|正|仍)\s*)*(?:站在|坐在|抬手|抬起|转头|转身|起身|伸手|迈步|握住|拿起|放下|(?:表情|神情).{0,4}(?:变化|改变)|双手.{0,6}(?:抬|放|握|攥))/u.test(own)) return false
    if (/镜头|画面|入镜|特写|近景|中景|(?:正脸|侧脸|面部|脸部|脸|五官|眉眼|眼睛|双眼|眼眸).{0,20}(?:清晰|可见|可辨)/u.test(own)) return false
  }
  if (gazeFrom && !gaze && !addressed) {
    // Only the observer's gaze moves. A target's face/eyes may identify its
    // static point of origin, but never authorize pictured acting or framing.
    const departure = /^(?:的|其)?(?:(?:正脸|侧脸|面部|脸部|脸|眼睛|双眼|眼眸)(?:上|处)?)?\s*(?:(?:缓缓|慢慢|逐渐|轻轻|终于)\s*)*(?:移开|离开|挪开|转开|收回)(?=$|[，,。！？!?；;\n])/u.test(own)
    const staticTarget = /^(?:的|其)?(?:(?:正脸|侧脸|面部|脸部|脸|眼睛|双眼|眼眸)(?:上|处)?)?\s*(?=$|[，,。！？!?；;\n])/u.test(own)
    if (!departure && (gazeFrom[1] === '从' || !staticTarget)) return false
    if (/镜头|画面|入镜|特写|近景|中景|(?:正脸|侧脸|面部|脸部|五官|眉眼|眼睛|双眼|眼眸).{0,20}(?:清晰|可见|可辨)/u.test(own)) return false
  }
  if (/^(?:的|其)?(?:(?:正在|缓缓|缓慢|慢慢|轻轻|突然|仍然|继续|猛地|正|仍)\s*)?(?:站在|坐在|蹲在|走向|走到|走进|抬手|抬起|抬头|抬眼|点头|转头|转身|起身|伸手|迈步|握住|拿起|攥紧|放下|眨眼|轻眨|微笑|皱眉|嘴角.{0,4}(?:上扬|收紧)|眉眼.{0,4}(?:变化|收紧)|(?:表情|神情).{0,4}(?:变化|改变)|(?:眼睛|双眼|眼睑)(?:(?:正在|正|缓缓|慢慢|轻轻)\s*)?(?:眨动|眨眼|轻眨|一颤|颤动))/u.test(own)) return false
  if (/^(?:(?:is|was|still|slowly)\s+)*(?:stands?|standing|sits?|sitting|raises?|raising|lifts?|lifting|turns?|turning|walks?|walking|nods?|nodding|blinks?|blinking|smiles?|smiling)\b/iu.test(own)) return false
  const positive = own.replace(/(?:不|未|无法|没有)(?:清晰|可见|入镜|可辨)|\b(?:not|never)\s+(?:visible|clear|in\s+frame)\b/giu, '')
  if (/^(?:的|其)?(?:正脸|侧脸|面部|脸部|五官|眉眼|眼神|嘴角).{0,20}(?:清晰|可见|可辨|入镜|特写)/u.test(positive)) return false
  if (/^(?:的)?(?:正面|侧面|侧脸|背面).{0,8}(?:中景|近景|特写|入镜)/u.test(positive)) return false
  if (/^(?:['’]s\s+)?(?:face|eyes?).{0,20}(?:visible|clear|in\s+frame|close[- ]?up)/iu.test(positive)) return false
  return true
}
