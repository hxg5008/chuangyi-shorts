/** Scene reference boards have a shared output format, including legacy cached prompts. */
export const SCENE_IMAGE_SIZE = '1920x1080'
export const SCENE_IMAGE_LAYOUT = 'four-view-v1'

const SCENE_IMAGE_REQUIREMENTS = `【场景四视图输出要求 v1】
生成一张整体宽高比为16:9的横向长方形场景参考图，采用2×2等大四宫格；每一格也必须是横向16:9画面，不能把四格拼成正方形或竖图。四格之间仅用细分隔线，不增加大面积边框或留白。
左上格：正向视图；右上格：45度斜侧视图；左下格：反向视图；右下格：90度垂直俯视图。四格展示同一场景、同一时刻的不同机位，陈设的数量、位置、朝向、尺度、出入口和空间结构必须一致；前三格为广角场景，右下格为正上方垂直向下的完整空间布局。
必须在每格左上角实际绘制清晰可读的中文视图标签，统一使用小块黑色半透明底与白色文字，不遮挡主体。四个标签必须逐字分别为“正向视图”“45度斜侧视图”“反向视图”“90度垂直俯视图”；这些是成图上的文字，不只是对机位的描述。除这四个标签外，不添加其他文字、水印、签名或可读招牌。
仅替换前文与本段冲突的单画面构图、画幅比例和禁止上述指定标签的要求；保留前文的场景内容、美术风格、年代、材质、色彩、光源方向、色温、明暗对比、阴影、自然景深及氛围，不重新布光、不统一提亮、不改成微缩模型。四视图均无人物，空场景。`

/** Append without rewriting the user's scene, lighting, or art direction. */
export function buildSceneImagePrompt(prompt: string): string {
  const source = prompt.trim()
  if (source.endsWith(SCENE_IMAGE_REQUIREMENTS)) return source
  return source ? `${source}\n\n${SCENE_IMAGE_REQUIREMENTS}` : SCENE_IMAGE_REQUIREMENTS
}

/** Providers may return a different pixel count; judge composition by ratio, not resolution. */
export function sceneImageOutput(width: number, height: number) {
  return {
    width,
    height,
    expectedAspectRatio: '16:9' as const,
    aspectRatioMatches: width > 0 && height > 0 && Math.abs((width / height) / (16 / 9) - 1) <= 0.05,
  }
}
