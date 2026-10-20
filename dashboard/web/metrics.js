const ratio = (n, d) => Number.isFinite(n) && d > 0 ? n / d : null;
const finite = value => Number.isFinite(value) ? value : null;

export function generationStats(record) {
  const play = record?.self_play || {}, balance = play.balance || {}, optimization = record?.optimization || {};
  const games = play.games || 0, outcomes = play.outcomes || [];
  const known = outcomes.length === games && games > 0;
  const draws = balance.draws ?? (known ? outcomes.filter(o => o.winner === 'draw').length : null);
  const repetitions = known ? outcomes.filter(o => o.reason === 'repetition').length
    : balance.outcome_reasons?.repetition ?? (Number.isFinite(balance.repetition_rate) ? Math.round(balance.repetition_rate * games) : null);
  return {
    games, rounds: play.rounds || 0, meanRounds: ratio(play.rounds, games),
    draws, drawRate: ratio(draws, games), repetitions, repetitionRate: ratio(repetitions, games),
    roundLimitDraws: known ? outcomes.filter(o => o.reason === 'round_limit').length : balance.outcome_reasons?.round_limit ?? null,
    eliteUpgrades: Number.isFinite(balance.elite_upgrades_per_game) ? Math.round(balance.elite_upgrades_per_game * games) : null,
    eliteSurvival: finite(balance.elite_survival?.mean_observed_rounds),
    eliteCaptured: finite(balance.elite_survival?.captured), eliteCensored: finite(balance.elite_survival?.censored),
    eliteCollisionWins: finite(balance.elite_collision_wins), eliteStationaryCaptures: finite(balance.elite_stationary_captures),
    eliteIdleRate: finite(balance.elite_idle_when_mobile_rate), eliteConsecutiveRate: finite(balance.elite_consecutive_move_rate),
    eliteHolderWinRate: finite(balance.elite_ownership?.only_one_win_rate),
    eliteHolderGames: finite(balance.elite_ownership?.only_one_games),
    uniqueOpenings: finite(balance.unique_openings), uniqueActions: finite(balance.unique_actions),
    actionEntropy: finite(balance.action_entropy), policyLoss: finite(optimization.policy_loss), valueLoss: finite(optimization.value_loss),
    samples: play.new_samples ?? null, replaySize: record?.replay_size ?? null,
    updates: optimization.updates ?? null, presentations: optimization.presentations ?? null,
    historyGames: play.history_games ?? null, historyCheckpoint: play.history_checkpoint || null,
    seconds: record?.seconds ?? null, selfPlaySeconds: play.seconds ?? null,
    speed: ratio(play.rounds, play.seconds), solverGap: ratio(play.search?.gap_sum, play.search?.roots),
  };
}

export function summarizeRecords(records) {
  const rows = records.map(generationStats), games = rows.reduce((n, row) => n + row.games, 0);
  const sum = key => rows.reduce((n, row) => n + (row[key] || 0), 0);
  const knownSum = key => rows.every(row => Number.isFinite(row[key])) ? sum(key) : null;
  const loss = key => {
    const known = rows.filter(row => Number.isFinite(row[key]));
    const weight = known.reduce((n, row) => n + (row.updates || 1), 0);
    return ratio(known.reduce((n, row) => n + row[key] * (row.updates || 1), 0), weight);
  };
  return { firstGeneration: records[0]?.generation ?? null, lastGeneration: records.at(-1)?.generation ?? null,
    generations: records.length, games, rounds: sum('rounds'), meanRounds: ratio(sum('rounds'), games),
    draws: knownSum('draws'), repetitions: knownSum('repetitions'), eliteUpgrades: knownSum('eliteUpgrades'),
    drawRate: ratio(knownSum('draws'), games), repetitionRate: ratio(knownSum('repetitions'), games),
    policyLoss: loss('policyLoss'), valueLoss: loss('valueLoss'), samples: sum('samples'),
  };
}

export function learningSnapshot(history, window = 10) {
  const latest = history.at(-1);
  if (!latest) return null;
  const signature = row => JSON.stringify(['games_per_generation', 'environments', 'candidates', 'cheap_candidates',
    'batch_size', 'updates', 'learning_rate', 'bootstrap_weight', 'history_fraction', 'replay_capacity']
    .map(key => row.config?.[key] ?? null));
  let first = history.length - 1;
  while (first > 0 && signature(history[first - 1]) === signature(latest)) first--;
  const rows = history.slice(Math.max(first, history.length - window));
  const recent = summarizeRecords(rows), earlier = history.slice(Math.max(first, history.length - 2 * window), history.length - rows.length);
  const previous = earlier.length ? summarizeRecords(earlier) : null;
  const evaluationRecord = history.filter(row => row.evaluation?.some(e => e.opponent === 'recent_checkpoint')).at(-1);
  const reference = evaluationRecord?.evaluation.find(e => e.opponent === 'recent_checkpoint');
  const selfRecord=history.filter(row=>row.evaluation?.some(e=>e.opponent==='adapted_self')).at(-1);
  return { recent, previous, conditionChanged: first > 0 && rows.length < window,
    latest, reference, referenceGeneration: evaluationRecord?.generation,
    selfEvaluation:selfRecord?.evaluation.find(e=>e.opponent==='adapted_self'), selfEvaluationGeneration:selfRecord?.generation,
    status: recent.repetitionRate >= .8 && recent.drawRate >= .9 ? '反復への偏りが強い'
      : recent.drawRate >= .65 ? '引き分けが多く、継続観察が必要' : '学習状況を継続観察',
  };
}

export const artifactGeneration = name => {
  const match = /(?:^|\/)g(\d+)(?:[-./]|$)/.exec(name);
  return match ? Number(match[1]) : null;
};
