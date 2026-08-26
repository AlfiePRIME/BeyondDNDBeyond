# Test fixtures

Real, permanent glTF sample assets used by this repo's own automated tests
and Playwright verification scripts for skeleton-based posing
(`docs/design/model-orientation-and-posing.md`) — not project art, not
served to end users, only loaded by tests/scripts.

Sourced from Khronos's official glTF-Sample-Assets repository
(https://github.com/KhronosGroup/glTF-Sample-Assets), licensed CC-BY-4.0
(Khronos). Both are purpose-built skinning/animation test rigs with no
trademark or logo encumbrance to track.

- `RiggedFigure.glb` — 19-bone humanoid rig, 57 animation tracks. Used as
  the "conforming skeleton" fixture: its bone naming
  (`torso_joint_*`/`arm_joint_*`/`leg_joint_*`/`neck_joint_*`) satisfies
  `src/scene-3d/pose.ts`'s tolerant bone-role matching, so it renders
  genuinely posed (sitting/idle), not T-posed.
- `RiggedSimple.glb` — 2-bone rig (`Bone`/`Bone001`). Used as the
  "non-conforming skeleton" fixture: it has a skin but not remotely enough
  matching bone roles, so `resolvePoseBones` correctly returns null and it
  renders via today's exact static, unposed fallback.

Attribution: © Khronos Group, CC-BY-4.0
(https://creativecommons.org/licenses/by/4.0/).
