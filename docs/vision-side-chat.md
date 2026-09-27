# Vision — Side Chats (block-scoped clarification threads)

Started 2026-09-27, ideation round. **Priority 2** of the post-explain roadmap (practice module first — this one is expected to be easy at the end of the day).

Quick clarification for quick questions — *between* the teaching. A separate, minimal agent exists beside the main learning agents; the teaching agents must stay unloaded (the owner's ruling: side chats have **zero effect on the teaching session**).

## The shape (owner sketched 2026-09-27)

- **Per teaching block.** Each block of the session transcript (the units divided by separators — turn groups) can carry its own mini thread.
- **UI discipline — invisible until relevant:**
  - No side chats → **nothing changes in the UI**, except:
  - a small chat button in the **bottom-right corner of each block, visible on hover** of that block;
  - opened threads render as a **collapsible mini-chat underneath their block**, accumulating inline.
- **Never part of the teaching record.** The teaching agent never sees these threads; they are annotations on the session, not conversation within it. Where they persist (same file under a teacher-invisible namespace, or a side store keyed by chat + block anchor) is open.

## The agent (v1, first try — owner ruled the starting point)

- **Block-only context.** The ONE block being asked about is its only input, plus a system prompt instructing it to answer **very non-verbosely, directly, simply**. Questions are about specific sections, and the UI makes that scoping clear.
- **Forking the session was considered and set aside.** A fork (session-so-far + different system prompt) gets role-confused — it reads the transcript as its own words. If block-only proves ungrounded, the agreed escalation ladder, in order: + the plan tree, + the relevant graph propositions, + selected earlier blocks.
- Bare, cheap, tool-less, one model slot down from the teacher. The honest risk on record: an ungrounded answer that confidently contradicts the lesson is poison under the accuracy doctrine — watch it, don't pre-solve it.

## Open questions (unruled)

- Block identity/anchor stability (blocks are derived groupings — anchor by the block's first message id).
- Persistence location and shape (teacher-invisible namespace in the chat record vs. a separate store).
- Model slot (cheap, presumably) and any context ceiling.
- Keyboard/affordance details (hover-only button, or also focus-reachable).
