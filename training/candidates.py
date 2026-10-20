"""Public-position candidate coverage; engine legality and rewards are unchanged."""
import numpy as np
from .features import path_geometry, square

SEARCH_PROTOCOL = "friendly-attack-guard-v3"
TRAINING_EXPLORATION = .10


def canonical_order(sample, scores):
    """Keep learned geometry scores, but execute/teach 'none' for ignored changes.

    Taking the maximum matches the former alias ranking, so an older network's
    preference for an ignored 'upgrade' does not erase its learned move score.
    """
    groups = {}
    selectable = sample.get('coverage', {}).get('selectable')
    for j, alias in enumerate(sample['aliases']):
        if selectable is not None and not selectable[j]:
            continue
        if alias not in groups:
            groups[alias] = [j, float(scores[j])]
        group = groups[alias]
        group[1] = max(group[1], float(scores[j]))
        if alias[-1] == 0 and sample['actions'][j].get('choice', 'none') == 'none':
            group[0] = j
    ranked = sorted(groups.values(), key=lambda pair: -pair[1])
    if not ranked:
        raise RuntimeError('敵の効きの条件を満たすAI候補がありません。局面を確認してください。')
    order = [j for j, _ in ranked]
    probabilities = np.zeros(len(scores), np.float64)
    values = np.array([score for _, score in ranked], np.float64)
    weights = np.exp(values-values.max())
    probabilities[order] = weights/weights.sum()
    return order, probabilities


def attack_mask(row, side):
    """Current attacks, stopping a ray at the first occupied square.

    Shapes, promotion and move bans come from Rust's advertised legal inputs.
    Knights leap; no future departure/capture of an intervening piece is assumed.
    Only public state is read, never the opponent's pending choice.
    """
    pieces = {p['id']: p for p in row['position']['pieces']}
    occupied = sum(1 << square(p['at'], 'A') for p in pieces.values())
    reach = 0
    seen = set()
    for action in row['actions'][side]:
        if action['type'] != 'move':
            continue
        identity = action['piece'], tuple(action['to'])
        if identity in seen:
            continue
        seen.add(identity)
        p = pieces[action['piece']]
        mask, ascending, *_ = path_geometry(square(p['at'], 'A'), square(action['to'], 'A'), p['kind']=='N' and not p['promoted'])
        hit = mask & occupied
        if hit:
            first = (hit & -hit).bit_length()-1 if ascending else hit.bit_length()-1
            mask &= (1 << (first+1))-1 if ascending else ~((1 << first)-1)
        reach |= mask
    return reach


def action_coverage(row, side):
    """AI restrictions on friendly destinations and immediately blocked starts.

    A friendly-occupied destination or first step is selectable only when that
    friendly piece is currently attacked. Engine legality stays unchanged.
    """
    pieces = {p['id']: p for p in row['position']['pieces']}
    occupants = {tuple(p['at']): p for p in pieces.values()}
    reach = attack_mask(row, 1-side)
    waiting, inert, actors, selectable, restrictions = [], [], [], [], []
    for action in row['actions'][side]:
        if action['type'] == 'drop':
            nifu = action['kind']=='P' and any(p['side']==action['side'] and p['kind']=='P' and not p['promoted'] and p['at'][0]==action['to'][0] for p in pieces.values())
            waiting.append(nifu or tuple(action['to']) in occupants)
            inert.append(False)  # Nifu/occupancy can change during a round.
            actors.append(('drop', action['kind']))
            selectable.append(True)  # Rust already forbids drops onto friendly pieces.
            restrictions.append(None)
        else:
            p = pieces[action['piece']]
            dx, dy = [b-a for a,b in zip(p['at'],action['to'])]
            first = action['to'] if p['kind']=='N' and not p['promoted'] else [p['at'][0]+(dx>0)-(dx<0),p['at'][1]+(dy>0)-(dy<0)]
            blocker = occupants.get(tuple(first))
            blocked = blocker is not None and blocker['side']==p['side']
            waiting.append(blocked)
            inert.append(blocked and not (reach & (1 << square(first, 'A'))))
            actors.append(('move', p['id']))
            destination = occupants.get(tuple(action['to']))
            friendly_destination = destination is not None and destination['side']==p['side']
            destination_unattacked = friendly_destination and not (reach & (1 << square(action['to'], 'A')))
            reason = 'friendly_destination_unattacked' if destination_unattacked else 'first_step_friendly_unattacked' if inert[-1] else None
            restrictions.append(reason)
            selectable.append(reason is None)
    return dict(waiting=waiting, inert=inert, actors=actors,selectable=selectable,restrictions=restrictions)


def shortlist(order, coverage, cap, rng=None):
    # All guaranteed waits have the same effect against every opponent input.
    # Keep one: resting remains a useful choice under the fatigue rules.
    unique, kept_wait = [], False
    for j in order:
        if coverage['inert'][j]:
            if kept_wait:
                continue
            kept_wait = True
        unique.append(j)
    ids = unique[:cap]
    active = [j for j in unique if not coverage['waiting'][j]]
    minimum = min(len(active), max(1, cap//2))
    for j in active:
        if sum(not coverage['waiting'][k] for k in ids) >= minimum:
            break
        if j not in ids:
            replace = next(k for k in range(len(ids)-1,-1,-1) if coverage['waiting'][ids[k]])
            ids[replace] = j
    # A saturated single-piece prior must still compare another piece's move.
    represented = {coverage['actors'][j] for j in ids if not coverage['waiting'][j]}
    alternative = next((j for j in active if coverage['actors'][j] not in represented), None)
    if alternative is not None and len(represented) < 2:
        ids[-1] = alternative
    represented = {coverage['actors'][j] for j in ids if not coverage['waiting'][j]}
    if rng is not None:
        # Explore movable pieces evenly; long blocked rays used to dominate the
        # uniformly sampled action list. Preserve at least one waiting choice.
        remaining = [j for j in active if j not in ids]
        if remaining:
            by_actor = {}
            for j in remaining:
                by_actor.setdefault(coverage['actors'][j], []).append(j)
            group = list(by_actor.values())[int(rng.integers(len(by_actor)))]
            candidate = int(rng.choice(group))
            for slot in range(len(ids)-1,-1,-1):
                if coverage['waiting'][ids[slot]]:
                    continue
                proposed = ids[:slot]+[candidate]+ids[slot+1:]
                actors = {coverage['actors'][j] for j in proposed if not coverage['waiting'][j]}
                if len(actors) >= min(2,len(represented)):
                    ids[slot] = candidate
                    break
    return ids
