import type { RuleSet } from './types.js';

/** Gameplay uses v0.7 with a fixed one-rank penalty on all consecutively moving pieces. */
export const PLAY_RULES:RuleSet = {
  version:'0.7', profile:'balance-v1', repetitionLimit:4, roundLimit:200,
  balance:{movement:'all_pieces',consecutiveThreshold:2,rankOffset:0,minimumRank:0,
    restRecovery:1,homeRows:3,defenseBonus:1,defensePosition:'destination',defenseCap:null},
};

export function sameRules(a:RuleSet|null|undefined,b:RuleSet|null|undefined):boolean {
  if (!a || !b || a.version!==b.version || a.profile!==b.profile || a.roundLimit!==b.roundLimit || a.repetitionLimit!==b.repetitionLimit) return false;
  if (!a.balance || !b.balance) return !a.balance && !b.balance;
  const keys = Object.keys(a.balance) as (keyof NonNullable<RuleSet['balance']>)[];
  return keys.length===Object.keys(b.balance).length && keys.every(key=>a.balance![key]===b.balance![key]);
}
