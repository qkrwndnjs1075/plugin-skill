# Lessons

- Keep user-facing explanations in Korean when the user requests Korean; retain that preference across later progress updates and results.
- Answer native Nose defaults from Nose/Rayon itself; distinguish the nose-review wrapper's explicit overrides instead of substituting its defaults.
- Let native tools own worker selection and parsing unless the user asks for wrapper limits; pass explicit caller settings unchanged.
- Immutable analysis reuse must bind source/discovery/proof inputs while applying review decisions live; logging and acceptance policy must not own detector-cache invalidation.
- Resolve symlinks before parent components when checking containment. Test actual file reads and native filesystem resolution; lexical normalization can hide an outside target.

- Distinguish the upstream `corca-ai/nose` scanner from this repository's `plugins/nose-review` wrapper before discussing commits or pushes. When the user says not to push the Nose repository, keep upstream untouched while still publishing authorized wrapper changes to `qkrwndnjs1075/plugin-skill`.
