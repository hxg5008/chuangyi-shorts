---
name: scene-prompt
description: A 16:9 landscape 2x2 scene reference sheet with four Chinese labels in white on translucent black at each panel's top-left; preserve the original space, art direction and lighting, with no people
---

# Final Scene Prompt (landscape four-view sheet · empty scene with no people)

Generate one **16:9 landscape image divided into an equal 2×2 grid; each panel is also 16:9 landscape**. The first three panels are clear wide-angle establishing shots of the same space from different directions; the bottom-right panel is a 90-degree vertical overhead view. All four show the same scene at the same moment with **absolutely no people**, preserving the **fixed relative positions of the foreground, midground, background, entrances/exits, floor, walls, and key set dressing** — spatially continuous, self-consistent, and reusable.

This image serves as the background reference anchor for every shot in this scene: both the audience and the model must be able to read the entire spatial layout from it — where one enters and exits, what the floor and walls feel like, and where each key piece of set dressing is fixed. The viewpoint must be stable and general-purpose.

## Read and Preserve

Call `read_scenes` with `{}` and locate the requested `scene_id`. Read `location`, `time`, `prompt`, `lighting`, and `final_prompt`. Do not change the scene ID, source information, project style, or other assets.

Keep all valid scene, lighting, color, material, photographic texture, and atmosphere descriptions from the source information and any actually available, user-confirmed earlier single-image prompt. Only replace conflicting single-frame composition, aspect-ratio, and prohibitions against the four required labels. Do not claim to have read an unavailable original image or an overwritten historical prompt.

Preserve light sources and their directions, warm/cool color temperature, intensity, contrast, soft/hard shadows, reflections, colors, material texture, and natural depth of field. Explicit window-grid shadows, warm light, and dark-area detail must remain explicit rather than becoming generic "natural lighting". Do not invent these effects, add a uniform golden cast, flatten the light, or redesign the scene as architectural line art, a miniature, or a different rendering style. Visible lit surfaces and occlusion may change with the camera direction; the physical lights must not move or be replaced.

The canvas and all four panels are fixed at 16:9 landscape; the backend supplies actual pixel dimensions. Keep the configured image model and quality. Do not pass undeclared size or reference-image arguments to tools.

## Four-Panel Layout

- Top-left: “正向视图” — view into the main space from its principal entrance or established forward direction; retain the confirmed framing and depth without moving set dressing.
- Top-right: “45度斜侧视图” — a lateral camera position viewing the same space at approximately 45 degrees relative to the forward direction. Show connections between passages, walls, windows, doors, and set dressing; do not tilt the image.
- Bottom-left: “反向视图” — look back toward the entrance from the opposite side. Show the true reverse relationship; do not mirror the forward view or redesign the unseen side.
- Bottom-right: “90度垂直俯视图” — look vertically down from directly above. Preserve the same furniture, doors, windows, passages, and functional areas. Hide an interior ceiling only for visibility, without changing the building or lighting, adding skylight, or making the space a detached miniature.

At the **top-left corner of each panel**, place its exact Chinese label in **white text on a translucent black background**, with consistent size, style, padding, and readable margins, without covering key scenery. These four literal Chinese labels must never be translated, shortened, or renamed, even when the rest of the prompt is in English or another target language. No other text is allowed. Use simple panel boundaries without large borders.

All panels share one spatial and directional reference. Keep fixed objects' counts, scale, positions, orientation, materials, age, door/window states, lights, time, weather, and scene state. Occlusion may change what is visible. Do not invent rooms, doors, windows, key objects, or people to fill panels. Establish outdoor directions using existing roads, buildings, or landmarks rather than inventing an interior layout.

## Output Structure (assemble a single coherent passage in this order, following the session language directive)

```
16:9 landscape canvas, equal 2×2 grid of 16:9 landscape panels showing the same space at the same time from forward, 45-degree oblique, reverse, and 90-degree vertical overhead directions; [location + period texture], [time period];
three-layer composition of foreground ([foreground elements]), midground ([main space of the midground]),
and background ([depth of the background]);
entrances/exits ([position and style of doors/passages]), floor ([floor material and condition]),
walls ([wall material and color]);
[key set dressing and its fixed relative positions];
spatial structure continuous and self-consistent;
[original light sources + color temperature + brightness contrast + shadows and reflections], [original colors, materials, photographic treatment, and mood];
white text on translucent black at each panel's top-left: top-left panel “正向视图”, top-right panel “45度斜侧视图”, bottom-left panel “反向视图”, bottom-right panel “90度垂直俯视图”; same space, materials, colors, and physical lighting in every panel;
No people in the scene, empty scene, cinematic quality
```

## Spatial Structure Rules

The space must be **readable, consistent, and reusable**:

- **Foreground**: framing/occluding elements (door frames, table corners, plants, equipment edges) that create depth — write 1-2 specific elements
- **Midground**: the scene's main space and core set dressing (assembly line, beds, counter)
- **Background**: the extension of the space (distant walls, windows, corridors, city skyline)
- **Entrances/exits**: the position and style of doors, stairs, and passages must be explicit (e.g. "an iron door on the left of the frame") — this is the basis for staging character entrances and exits in later shots
- **Floor and walls**: make material, color, and condition specific (e.g. "oil stains on the concrete floor", "mottled lime plaster on the walls")
- **Key set dressing**: write 2-4 core pieces and their **fixed relative positions** (e.g. "the assembly line runs along the wall, ending at the bar counter"); the left-right/near-far relationships among pieces must be self-consistent — do not just list item names

## People (Hard Rule · Highest Priority)

**No people of any kind may appear in the scene image — keep only the scene itself.**

- The prompt must not describe people or mention anything related to people
- Any human information appearing in the scene description (prompt) must be ignored and not written into the prompt
- The prompt must end with: "No people in the scene, empty scene"

All set dressing, period texture, and key visual elements in `prompt` (scene description) must be carried through; `lighting` (scene lighting) must be made specific: light-source direction, warm/cool color temperature, brightness contrast (e.g. "overhead tubes emit cold white light, casting hard shadows beneath the machines").

## Viewpoint & Atmosphere

- Use stable eye-level or slightly high-angle wide shots for the first three panels, with no extreme tilt, fisheye, or Dutch angle. The bottom-right panel must use the specified 90-degree vertical overhead view. Preserve the original framing, spatial layers, natural depth of field, and photographic texture.
- Determine the time period and overall lighting scheme from `location` + `time` (day / night / dusk are completely different lighting schemes)
- Make mood words concrete: "oppressive" → "stifling air, dim and low light"; do not write only abstract emotion words
- Descriptions follow the session's target language; only the four required view labels remain literal Chinese. Do not mix unrelated words into the output.

## Prohibitions

- Any people — **no people of any kind may appear in the scene image; keep only the scene itself**
- Any text other than the four required Chinese view labels, including readable text on signboards, watermarks, and signatures
- Motion blur, objects in motion (the scene reference image must be still and stable)
- Merely listing set dressing without giving relative positions (the spatial structure must be continuous and self-consistent)

## Saving

Before saving, check that the original structure, set dressing, materials, time, light direction, warm/cool balance, contrast, atmosphere, and photographic treatment are all represented. Only the 16:9 landscape grid, four viewpoints, and required labels should change. Write one coherent prompt, with no analysis, placeholders, or four independent prompts.

Call `save_scene_final_prompt` with only `scene_id` and `prompt` and actually save it. Do not repeat the project-wide style prefix: **the project's visual style is automatically injected by the tool at the very front of the final prompt**. Preserve the scene's own specific lighting, colors, materials, and photographic treatment; avoiding a duplicate prefix does not mean removing these details.
