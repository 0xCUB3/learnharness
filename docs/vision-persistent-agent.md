# Vision — The Persistent Agent (PARKED)

Started 2026-09-27, ideation round. **Parked by the owner 2026-09-27** — "a much later thing." This document preserves the ideation so nothing is re-derived. Practice module and side chats go first; branching after those.

## The pitch

A **tutor of record** — an agent that teaches nothing. It is the general interface to the accumulated learner model: it knows where the session records live, can read them, holds access to the knowledge graph, and keeps a detailed, longitudinal record of the user's understanding.

## The substrate — sessions as markdown

- Sessions get converted to **markdown records, persisted as files** — the corpus other agents read with the read/ls/find/grep tools every pi agent already has. This is the pull-based (pi-native) version of context sharing, philosophically opposite to the removed Wave-7 pushed-injection.
- **JSON stays canonical; markdown is a derived export with a defined shape** — regenerable, no second source of truth.
- Two audiences, one artifact: the human archive and the agent food want the same *distilled session record* — goal, the plan map (already mermaid — markdown-native), nodes covered, checks with outcomes, misconceptions found, where the session left off (~40 lines, not a 400-line verbatim transcript; the verbatim JSON exists forever).
- Open: who writes the record — dumb code folding the record, or an agent summarizing at session end. Could ship standalone before the rest of this document (it serves export value immediately and this agent later).

## The agent itself (ideation, unruled)

- **Queries the graph, doesn't hold it.** The graph lives in stores with query tools; holding it as context text is stale-copy risk and token burn. Context stays small; truth stays in the stores.
- **user.md — a living synthesis the agent maintains** — with the discipline that **the graph is the truth and user.md is the index**: the graph is evidence-backed (every node traceable to extraction); free-form prose memory has no audit trail. Disagreements resolve toward the graph. Otherwise it's a second brain with no epistemics.
- **The graph-view composer becomes its interface** — the natural home: the page where you see everything you know, and ask about it. This also makes the graph a control surface: **sessions created from the graph** (select nodes → "teach me this" → a session whose plan could seed from the selection; the probe could focus or skip accordingly).

## Session kinds (relevant once practice exists too)

Three fundamentally different session types — teaching, practice, the persistent agent's chats — should not sit mixed in one flat list. Agreed direction: **one session store with a `kind` discriminator, three surfaces** — teaching in the sidebar (untouched), practice entering from the graph/sessions, the tutor-of-record chat at the graph composer. Icons alone say what a thing is; surfaces put it where its activity lives. (The store-side kind field becomes real as soon as the practice module lands — see vision-practice.md.)

## Home page

If practice and the persistent agent both enter through the graph, the graph stays home and grows denser with affordances — no tabs. Tabs are what you add when something has no natural home. Watch: the graph page must not accrete too many meanings; "everything I know, and everything I can do with what I know" is one coherent meaning, and it should stay that way.
