# Vision — Session Branching

Started 2026-09-27, ideation round. No priority assigned yet (suggested slot: after practice + side chats — it is the deepest record-model change in this document set).

Now that the app is fully pi-native, support **session branching**: the message history becomes a tree; the learner can navigate back in time and branch — explore "what if" continuations, revisit decision points, keep alternate lines.

## The UI (owner sketched 2026-09-27)

A popup overlay **in the chat area** — exactly the same overlay pattern as the plan window. It presents the session's **teacher messages, separated by teacher message**, and the user branches from those points.

## Assessment (coordinator, 2026-09-27)

- The overlay UI is the easy part. The record today is a **flat native message array**, and everything downstream assumes linearity: the view projection/grouping canon, the write-ahead persistence, the turn runner's one-turn-per-chat liveness, coverage fingerprints (keyed by message id), extraction idempotency (refs by toolCallId), subscription replay. Branching means a **tree-shaped record model** designed deliberately — not a UI feature bolted on.
- **The pi SDK carries no native session-tree branching** (its `Branch*` exports are compaction summarization only, verified 2026-09-27). This is our own record-model work. Per the owner: read the full pi docs on sessions/branching before designing — confirmed as implementation-time step 1 regardless.
- Value is real: rewind/replay fits the tutoring domain well (alternate explanations, "what if I'd answered differently"), and it composes cleanly with the parked persistent-agent idea later (branches as parallel histories to reconcile).

## Open questions (unruled)

- Tree representation: parent pointers per message vs. branch records referencing a base prefix.
- What happens to graph evidence from **abandoned branches** — does extraction run per-branch, active-path only, or all paths with branch-scoped attribution?
- Branch lifecycle: naming/labels, switching, deletion; is the original line just another branch?
- Are user messages also branch points (edit-and-resend), or teacher-message anchors only, per the sketch?
- Interaction with practice/side chats (presumably none — they attach to their own surfaces).
