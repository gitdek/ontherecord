# The board

"Who said they'd do what": every action item from every set of reviewed notes, plus tasks added by hand or by an agent. The web board, the JSON API and the MCP tools all go through the same code (`server/tasks.ts`), so they always agree on what is open.

Items owned by the archive's own people (`CREW`) sit in the lane **On us**. Everyone else's sit in **Waiting on them**. Changes are shared live between both people and their agents.

## What a state means

| State | Meaning | What it carries |
| :-- | :-- | :-- |
| Open | Still to do | An optional note |
| Open, on hold | Deferred or blocked | What it waits on, in words, and the items that must finish first |
| Done | The work was confirmed finished | Evidence and sources that say how anyone knows |
| Canceled | No longer relevant: superseded, dropped or a duplicate | A reason, and a link to the item that stands instead |

"Looked, found nothing" is not a state. It records that someone searched for confirmation and found none, and where they looked. The status stays as it was, so an unconfirmed item is never passed off as done or as canceled.

A canceled item is never counted as open. Bringing it back is **Reopen**, and only that is described as reopening: changing a reason, a note or a hold says what it did.

## On hold

Deferred or blocked work stays open and goes on hold. No date has to be invented. A hold says what the item waits on in words ("Waiting for the carrier's sandbox keys"), names up to 10 items that must finish first, or both. When every one of those items is done or canceled, the card shows **Ready to start** and the item counts as open again. An item canceled as replaced by another counts only once that other item is done or canceled, since the work moved there. The items decide on their own: a hold with words and items is ready once the items have finished, and the words stay on the card as what else it was waiting on. A hold given only in words stays until someone takes the item off hold. A hold that would go in a circle (A waits on B, B waits on A) is refused, and so is an undo that would bring one back.

On the web, **Open on us** counts what can be worked on now, and parked items sit under **On hold**. Over MCP, `list_action_items` reports `open` together with `of_which_on_hold`.

## Evidence, sources and links

- **Evidence** is one or two sentences on how anyone knows the item is done or no longer matters.
- **Sources** are pointers, never content: a moment in a meeting (`{meeting_id, at}`), a notebook entry (`{note_id}`), or a short reference to something outside the archive (`{ref: "supplier email, 3 Nov"}`). Private emails and messages are not pasted into the board, and text that looks like a credential is refused.
- **Replaced by** points a canceled item at the item that stands in its place, which can't be canceled itself, so two duplicates are never each replaced by the other. The replacement shows what it replaces.
- **Rewording** changes an item's text and keeps the original. The id stays the same, and when the notes themselves are reworded later the item is matched to its new line instead of being lost.
- **Two items worded alike** in one meeting are two items: the second gets an id of its own, and checking one off leaves the other as it was.

## History and undo

Every change is added to the item's trail with who made it, when, and on what grounds: added, marked done, canceled, reopened, reason changed, evidence updated, put on hold, taken off hold, looked and found nothing, reworded, note. **History** on a card opens the trail.

**Undo last change** takes back the most recent change to an item. Undoing again puts it back. A deleted hand-added task can be brought back the same way: from the toast that follows the delete, or with `update_action_item {id, undo: true}`. A task that was brought back has nothing to undo until it changes again, so a second undo is refused instead of taking back a change made before the delete. Delete it again to take it off the board. Items that come from meeting notes cannot be deleted, only marked done or canceled.

## Edits from two people and their agents

Each item carries a revision number that goes up with every change. A client sends back the revision it last read (`rev` in the web API, `if_rev` over MCP). If someone else changed the item in between, the update is refused and the current item comes back with the refusal: HTTP 409 on the web, a tool error over MCP. Nothing is overwritten silently. The check is per item. A change to a task that someone deletes while the change is being saved is refused with a message that says so: the change went under **Recently deleted** with the task, and bringing the task back brings the change too.

An agent is also stopped at 60 changes a minute, so one stuck in a loop cannot flood the shared board, and each name may hold at most 200 of the board's 500 added tasks.

## Finding it again

What the board says about an item is in both indexes next to the meeting text: cancel reasons, evidence, notes, holds and checks that found nothing. `in:updates` searches only those lines and `in:actions` searches items and updates together. `status:` and `owner:` find items by where they stand now, such as `status:on_hold owner:ada`. A hit on an item carries its id and its current status. See [`docs/search.md`](search.md).

## On the web

The board lives at `/actions`. `?show=open|hold|done|canceled|all` picks the view, `&who=` a person and `&focus=<id>` one card.

A card offers **Add note**, **Put on hold**, **No longer relevant**, **History** and, for hand-added tasks, **Delete**. A canceled card offers **Reopen** and **Edit reason**. Done and canceled cards carry a stamp with who did it and on which day.

A done or canceled card also offers **Add evidence**: the evidence in words, sources picked from the meetings (with a time) and the notebook or written as a short reference, and for a canceled card the item that replaced it. An open card offers **Looked, found nothing**. Every one of these sends the card's revision, so a newer change is never overwritten.

Tasks deleted lately wait under **Recently deleted**, below the lanes, each with **Bring back**.

## The API

Every write needs the header `x-requested-with: meetings` and a same-origin request.

| Request | What it does |
| :-- | :-- |
| `GET /api/actions` | Every item with its state, hold, evidence, links, history and `rev`, and the tasks deleted lately (`deleted`, newest first) |
| `POST /api/actions/<id>` | Change one item: `status`, `reason`, `note`, `hold`, `blockedBy`, `evidence`, `sources`, `notFound`, `replacedBy`, `text`, `owner`, `undo`, with `rev` for the check |
| `POST /api/tasks` | Add a task by hand |
| `POST /api/tasks/<id>/delete` | Delete a hand-added task |

A change answers `{ ok, action, done, did }`, where `did` lists what the change did in short words (`canceled`, `hold`, `note`). A stale `rev` answers 409 with `{ error, action }`.

## Limits

- The board file keeps the last 50 deleted tasks. Older ones are gone for good.
- The revision check is per item: changes to two different items never conflict, also when one waits on the other.
