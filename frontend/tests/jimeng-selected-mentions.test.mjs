import test from 'node:test'
import assert from 'node:assert/strict'
import { projectJimengSelectedMentions, jimengMentionProjection, mergeJimengProjectedEdit } from '../app/utils/jimeng-selected-mentions.js'

const known = ['花衬衫甲', '愣头青', '刀疤脸', '三八专列二号车厢', '黑色旅行包', '弹簧刀']
test('known unselected mentions lose only their marker and selected mentions stay intact', () => {
  const raw = '@花衬衫甲追视@愣头青亮刀动作后错开眨眼，@刀疤脸坐着。'
  assert.equal(projectJimengSelectedMentions(raw, known, []), '花衬衫甲追视愣头青亮刀动作后错开眨眼，刀疤脸坐着。')
  assert.equal(projectJimengSelectedMentions(raw, known, ['愣头青']), '花衬衫甲追视@愣头青亮刀动作后错开眨眼，刀疤脸坐着。')
  assert.equal(projectJimengSelectedMentions(raw, known, known), raw)
})
test('selection projection is reversible without changing the saved prompt', () => {
  const raw = '@刀疤脸看向@花衬衫甲，拿着@弹簧刀。'
  const projected = projectJimengSelectedMentions(raw, known, ['刀疤脸', '弹簧刀'])
  assert.equal(mergeJimengProjectedEdit(raw, projected, known, ['刀疤脸', '弹簧刀']), raw)
  assert.equal(projectJimengSelectedMentions(raw, known, ['刀疤脸', '花衬衫甲', '弹簧刀']), raw)
})
test('longest known name wins and unknown variants or ambiguous names are not silently stripped', () => {
  assert.equal(projectJimengSelectedMentions('@王兴与@王兴·童年。', ['王兴', '王兴·童年'], []), '王兴与王兴·童年。')
  assert.equal(projectJimengSelectedMentions('@王兴·童年。', ['王兴'], []), '@王兴·童年。')
  assert.equal(projectJimengSelectedMentions('Ann-Child 与 @Ann-Child。', ['Ann'], ['Ann']), 'Ann-Child 与 @Ann-Child。')
  assert.equal(projectJimengSelectedMentions('@王兴。', ['王兴', '王兴'], []), '@王兴。')
  assert.equal(projectJimengSelectedMentions('@未知人物。', known, []), '@未知人物。')
})
test('email, quoted dialogue and voice marks stay exact while full-width image marks are projected', () => {
  const raw = 'mail name@example.com；#花衬衫甲音色；他说：“@花衬衫甲，这是台词。” ＠花衬衫甲追视@愣头青。'
  assert.equal(projectJimengSelectedMentions(raw, known, []), 'mail name@example.com；#花衬衫甲音色；他说：“@花衬衫甲，这是台词。” 花衬衫甲追视愣头青。')
})
test('ordinary edited prose survives while untouched hidden reference intent is preserved', () => {
  const raw = '@花衬衫甲看向@愣头青，原地停住。'
  const display = projectJimengSelectedMentions(raw, known, [])
  const edit = display.replace('原地停住', '慢慢后退')
  const merged = mergeJimengProjectedEdit(raw, edit, known, [])
  assert.equal(merged, '@花衬衫甲看向@愣头青，慢慢后退。')
  assert.equal(projectJimengSelectedMentions(merged, known, ['愣头青']), '花衬衫甲看向@愣头青，慢慢后退。')
  assert.equal(mergeJimengProjectedEdit(raw, '完全替换新正文', known, []), '完全替换新正文')
})
test('projection positions preserve emoji code units and selected bare names gain one reference marker', () => {
  const raw = '🙂 @花衬衫甲、愣头青。'
  const result = jimengMentionProjection(raw, known, [])
  assert.equal(result.text, '🙂 花衬衫甲、愣头青。')
  assert.equal(result.hidden[0].rawOffset, 3)
  assert.equal(projectJimengSelectedMentions('花衬衫甲看着愣头青。', known, known), '@花衬衫甲看着@愣头青。')
})
test('selected bare names are projected idempotently and removing or restoring image selection is reversible', () => {
  const raw = '花衬衫甲追视愣头青，握住弹簧刀。'
  const selected = ['愣头青', '弹簧刀']
  const expected = '花衬衫甲追视@愣头青，握住@弹簧刀。'
  assert.equal(projectJimengSelectedMentions(raw, known, selected), expected)
  assert.equal(projectJimengSelectedMentions(expected, known, selected), expected)
  assert.equal(projectJimengSelectedMentions(raw, known, []), raw)
  assert.equal(mergeJimengProjectedEdit(raw, expected, known, selected), raw)
  assert.equal(projectJimengSelectedMentions(raw, known, selected), expected)
})
test('English asset names respect word boundaries and all dialogue or voice content stays literal', () => {
  const names = ['Wren Winters', 'Julian', 'Ann', '王兴']
  const raw = 'Wren Winters向Julian走去；Ann站着，JoAnn不变，Annex不变。fooAnn@Ann.example。#Ann音色\nWren Winters说：“Julian，Ann不能变成@Ann。” 王兴·童年站着。'
  assert.equal(projectJimengSelectedMentions(raw, names, names), '@Wren Winters向@Julian走去；@Ann站着，JoAnn不变，Annex不变。fooAnn@Ann.example。#Ann音色\n@Wren Winters说：“Julian，Ann不能变成@Ann。” 王兴·童年站着。')
})
test('edits invert untouched automatic markers and restore untouched hidden markers together', () => {
  const raw = '花衬衫甲看向@愣头青，原地停住。'
  const selected = ['花衬衫甲']
  const p = jimengMentionProjection(raw, known, selected)
  assert.equal(p.text, '@花衬衫甲看向愣头青，原地停住。')
  assert.equal(p.added.length, 1); assert.equal(p.hidden.length, 1)
  const edited = p.text.replace('原地停住', '慢慢后退')
  assert.equal(mergeJimengProjectedEdit(raw, edited, known, selected), '花衬衫甲看向@愣头青，慢慢后退。')
})
test('repeated and mixed full-width markers collapse for selected images and disappear for unselected names', () => {
  const names = ['王兴', '愣头青']
  for (const raw of ['@@王兴看向@@愣头青。', '＠@＠王兴看向@＠愣头青。']) {
    assert.equal(projectJimengSelectedMentions(raw, names, ['王兴']), '@王兴看向愣头青。')
    assert.equal(projectJimengSelectedMentions(raw, names, []), '王兴看向愣头青。')
    assert.equal(projectJimengSelectedMentions(raw, names, names), '@王兴看向@愣头青。')
    const display = projectJimengSelectedMentions(raw, names, ['王兴'])
    assert.equal(mergeJimengProjectedEdit(raw, display, names, ['王兴']), raw)
    assert.equal(projectJimengSelectedMentions(display, names, ['王兴']), display)
  }
  assert.equal(projectJimengSelectedMentions('@@未知人物说话。', names, names), '@@未知人物说话。')
  assert.equal(projectJimengSelectedMentions('@＠王兴·童年说话。', names, names), '@＠王兴·童年说话。')
})
test('editing an unrelated phrase preserves the raw repeated marker runs and selection remains reversible', () => {
  const names = ['王兴', '愣头青'], raw = '@＠王兴看向@@愣头青，随后坐下。'
  const display = projectJimengSelectedMentions(raw, names, ['王兴'])
  const merged = mergeJimengProjectedEdit(raw, display.replace('随后坐下', '缓慢后退'), names, ['王兴'])
  assert.equal(merged, '@＠王兴看向@@愣头青，缓慢后退。')
  assert.equal(projectJimengSelectedMentions(merged, names, ['愣头青']), '王兴看向@愣头青，缓慢后退。')
})
