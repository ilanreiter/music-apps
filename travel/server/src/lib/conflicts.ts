export interface ConflictCheckItem {
  id: string;
  title: string;
  type: string;
  startAt: Date | null;
  endAt: Date | null;
}

export interface Conflict {
  itemAId: string;
  itemBId: string;
  itemATitle: string;
  itemBTitle: string;
  reason: string;
}

// TRANSPORT and STAY items represent the traveler occupying one exclusive
// place at a time, so overlapping windows between them are real conflicts.
// POI/ACTIVITY items are allowed to overlap loosely (plans change), so we
// only flag those when they overlap a TRANSPORT/STAY window (you can't be
// touring a museum while mid-flight).
const EXCLUSIVE_TYPES = new Set(["TRANSPORT", "STAY"]);

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

export function detectConflicts(items: ConflictCheckItem[]): Conflict[] {
  const timed = items.filter((i) => i.startAt && i.endAt) as (ConflictCheckItem & {
    startAt: Date;
    endAt: Date;
  })[];

  const conflicts: Conflict[] = [];

  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (!overlaps(a.startAt, a.endAt, b.startAt, b.endAt)) continue;

      const bothExclusive = EXCLUSIVE_TYPES.has(a.type) && EXCLUSIVE_TYPES.has(b.type);
      const oneExclusive = EXCLUSIVE_TYPES.has(a.type) || EXCLUSIVE_TYPES.has(b.type);

      if (bothExclusive) {
        conflicts.push({
          itemAId: a.id,
          itemBId: b.id,
          itemATitle: a.title,
          itemBTitle: b.title,
          reason: `"${a.title}" and "${b.title}" overlap in time — you can't be in two places at once.`,
        });
      } else if (oneExclusive) {
        conflicts.push({
          itemAId: a.id,
          itemBId: b.id,
          itemATitle: a.title,
          itemBTitle: b.title,
          reason: `"${a.title}" overlaps with "${b.title}".`,
        });
      }
    }
  }

  return conflicts;
}
