import { generationStats, learningSnapshot, artifactGeneration, externalRecords, externalSummary, externalSeries } from './metrics.js';

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value, decimals = 0) => Number.isFinite(value) ? value.toLocaleString('ja-JP', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) : '—';
const percent = value => Number.isFinite(value) ? `${number(value * 100, 1)}%` : '—';
const empty = text => `<div class="empty">${escapeHTML(text)}</div>`;
const tag = (text, kind = '') => `<span class="tag ${kind}">${escapeHTML(text)}</span>`;
const when = stamp => stamp ? new Date(stamp * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const decisions = { better: ['優位', ''], worse: ['劣位', 'red'], inconclusive: ['判定保留', 'amber'] };
const phases = { ready:'再開の準備完了', initializing: '初期化中', self_play: '自己対戦中', optimizing: 'ネットワーク更新中', evaluating: '棋力を評価中', generation_complete: '世代の保存完了', complete: '学習完了', stopped: '中断・保存済み', failed: '処理を確認してください' };
const titles = { overview: '進捗', charts: 'グラフ', evaluation: '強さ・比較', balance: 'ルール比較', analysis: '対局ビューア', colab: 'Colab・Drive連携', research: '詳細' };
const eventNames = { capture: '捕獲', contact: '同段階の接触', move: '移動', move_reached: '目的地に到着', move_captured: '移動駒が被捕獲', move_partial: '途中位置で停止', move_zero: '移動不成立', blocked: '味方障害による待機', drop_failure: '打ち込み不成立', drop: '打ち込み成立', drop_duel: '同時打ち', drop_wait: '打ち込み待機', drop_failed: '打ち込み不成立', change: '成り・昇格', promote: '成り', promotion: '成り', equal_drop_failure: '同格の同時打ち不成立', upgrade: '昇格', forced_promotion: '強制成り', wait: '味方障害による待機', mutual_capture: '相討ち', round_end: 'ラウンド終了' };
const reasonNames = { static: '非選択の停止駒への通常捕獲', chain: '連戦（除去後の反撃）', stopped: '移動後に停止した駒への通常捕獲', unmoved: '移動していない駒への通常捕獲', king_captured: '王の捕獲', king_capture_retained: '王捕獲後に取り返されても勝利', king_captor_lost: '王捕獲者が後続に取られた', both_kings: '双方の王捕獲・捕獲時の格で比較', mutual: '同格の相討ち', stationary: '停止駒への通常捕獲', rank: '格比較', counter: '連戦', drop: '打ち駒との競合', repetition: '同一局面の反復', round_limit: 'ラウンド上限', king_capture: '王捕獲', king_captor_recaptured: '王捕獲者の後続被捕獲' };
const pieces = { K: '王', P: '歩', L: '香', N: '桂', S: '銀', G: '金', R: '飛', B: '角' };
const promoted = { P: 'と', L: '杏', N: '圭', S: '全', R: '龍', B: '馬' };
const opponentName = name => ({ champion: '基準モデル（旧評価）', adapted_self:'現在モデル同士', recent_checkpoint:'最近の学習済みモデル', external_usi:'既存AI', hunter: 'hunter', defense: 'defense', upgrade: 'upgrade', random: 'random' }[name] || name);
let state = null, selectedRun = new URLSearchParams(location.search).get('run') || '', selectedGeneration = Number(new URLSearchParams(location.search).get('generation')) || null;
let replay = null, renderedRun = null, currentView = 'overview', polling = null, requests = 0, toastTimer;
let runtime = null, settingsLoaded = false, settingsFocus = null, submitting = false, followNewRun = false;

export async function request(path, input) {
  const response = await fetch(path, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function toast(text, error = false) {
  $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 8000);
}
function showView(view) {
  if (!titles[view]) return;
  currentView = view;
  for (const button of document.querySelectorAll('.nav-item')) { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); }
  for (const section of document.querySelectorAll('.view')) { section.hidden = section.id !== `view-${view}`; section.classList.toggle('active', !section.hidden); }
}
function selectedRecord() {
  const history = state?.selected?.history || [];
  return history.find(r => r.generation === selectedGeneration) || history.at(-1);
}
function clearReplay() {
  replay = null;
  $('board').innerHTML = empty('この世代の棋譜を選ぶと盤面を表示します。');
  $('replayEvents').innerHTML = empty('棋譜を選択してください。');
  $('replayVerified').textContent = '未選択'; $('replayHands').textContent = '';
  $('replaySelect').value = ''; $('probeSelect').value = '';
  $('probeDetails').innerHTML = empty('分析記録を選択してください。');
}
function selectGeneration(generation) {
  if (!state?.selected?.history.some(row => row.generation === generation)) return;
  selectedGeneration = generation; clearReplay();
  history.replaceState(null, '', `?run=${encodeURIComponent(selectedRun)}&generation=${generation}`);
  render(); showView('overview');
  $('generationDetailCard').focus({ preventScroll: true });
  $('generationDetailCard').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
function options(select, rows, initial = null) {
  const signature = JSON.stringify(rows);
  if (select.dataset.signature === signature) return;
  const previous = select.value;
  select.innerHTML = rows.map(row => `<option value="${escapeHTML(row.value)}">${escapeHTML(row.label)}</option>`).join('');
  select.dataset.signature = signature;
  if (rows.some(row => row.value === (initial ?? previous))) select.value = initial ?? previous;
}

export function plot(container, series, score = false) {
  const selected = selectedRecord()?.generation;
  const signature=JSON.stringify({series,score,selected});
  if(container.dataset.plot===signature)return;
  container.dataset.plot=signature;
  const values = series.flatMap(s => s.points).filter(p => Number.isFinite(p.y));
  if (!values.length) { container.innerHTML = empty('確定した世代の記録が集まると表示します。'); return; }
  const w = 500, h = 190, left = 38, right = 15, top = 12, bottom = 26;
  const maxX = Math.max(1, ...values.map(p => p.x)), minX = Math.min(1, ...values.map(p => p.x));
  const maxY = score ? 1 : Math.max(.01, ...values.map(p => p.y)) * 1.15;
  const x = v => left + (v - minX) / Math.max(1, maxX - minX) * (w - left - right);
  const y = v => top + (1 - v / maxY) * (h - top - bottom);
  const ticks = [0, .25, .5, .75, 1];
  let content = ticks.map(t => `<line x1="${left}" y1="${y(t * maxY)}" x2="${w - right}" y2="${y(t * maxY)}" stroke="#e6e6e6" ${score && t === .5 ? 'stroke-dasharray="4 4"' : ''}/><text x="${left - 9}" y="${y(t * maxY) + 3}" class="chart-label" text-anchor="end">${score ? `${t * 100}%` : number(t * maxY, 1)}</text>`).join('');
  const tickX = [...new Set([minX, Math.round((minX + maxX) / 2), maxX])];
  content += tickX.map(g => `<text x="${x(g)}" y="${h - 6}" class="chart-label" text-anchor="middle">G${g}</text>`).join('');
  if (selected >= minX && selected <= maxX) content += `<line x1="${x(selected)}" x2="${x(selected)}" y1="${top}" y2="${h-bottom}" stroke="#999" stroke-dasharray="3 3"/>`;
  for (const s of series) {
    const points = s.points.filter(p => Number.isFinite(p.y));
    const spacing=points.length>1?Math.min(...points.slice(1).map((p,i)=>x(p.x)-x(points[i].x))):20;
    const hitRadius=Math.max(.4,Math.min(8,spacing*.45));
    content += `<polyline class="chart-line" pointer-events="none" stroke="${s.color}" ${s.dashed ? 'stroke-dasharray="6 4"' : ''} points="${points.map(p => `${x(p.x)},${y(p.y)}`).join(' ')}"/>`;
    content += points.map(p => `<g data-gen="${p.x}" role="button" tabindex="0" aria-label="世代${p.x}を選択"><rect x="${x(p.x)-hitRadius}" y="${y(p.y)-8}" width="${hitRadius*2}" height="16" fill="transparent"/><circle pointer-events="none" cx="${x(p.x)}" cy="${y(p.y)}" r="${p.x===selected?5:Math.min(3,spacing*.35)}" fill="${s.color}" stroke="#fff" stroke-width="${Math.min(1.5,spacing*.15)}"/><title>${escapeHTML(s.name)} G${p.x}${p.note?` ${escapeHTML(p.note)}`:''}: ${score ? percent(p.y) : number(p.y, 3)}</title></g>`).join('');
  }
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHTML(series.map(s=>s.name).join('・'))}の推移">${content}</svg><div class="chart-legend">${series.map(s => {const point=s.points.find(p=>p.x===selected);return `<span><i style="background:${s.color}"></i>${escapeHTML(s.name)}${selected?` G${selected}: ${score?percent(point?.y):number(point?.y,3)}`:''}</span>`;}).join('')}</div>`;
}
function gateMarkup(gate, smoke) {
  if (!gate) return empty('対戦評価が完了すると表示します。');
  const [label, kind] = decisions[gate.decision] || decisions.inconclusive;
  const [lo, hi] = gate.interval;
  return `<div class="gate-score"><strong>${percent(gate.score)}</strong><div>${tag(smoke ? '動作テスト' : label, smoke ? 'amber' : kind)}<p>対・${escapeHTML(opponentName(gate.opponent))} / ${number(gate.pairs)}ペア</p></div></div><div class="score-range"><span style="left:${lo * 100}%;width:${(hi - lo) * 100}%"></span><i style="left:calc(${gate.score * 100}% - 4px)"></i></div><div class="range-labels"><span>0%</span><span>50%</span><span>100%</span></div><p class="gate-text">${number(gate.confidence * 100, 1)}% 区間：${percent(lo)}–${percent(hi)}<br>${smoke ? '短縮ルールでの動作確認です。正式な棋力の根拠には使いません。' : gate.decision === 'inconclusive' ? 'まだ優劣を判断できません。評価ペア数を増やして確認します。' : 'この相手・条件における対戦結果です。固定方策への成績も併せて確認します。'}</p>`;
}
function renderOverview() {
  const run = state.selected, history = run?.history || [], manifest = run?.manifest, status = run?.status || {}, record = selectedRecord();
  const smoke = manifest && manifest.rules.roundLimit !== 200;
  const unlimited = manifest?.config.generations === 0;
  $('welcome').hidden = history.length > 0;
  $('statusUpdated').textContent = status.updated ? `最終記録 ${when(status.updated)} JST` : '記録待ち';
  const phase = phases[status.phase] || '待機中';
  const progress = unlimited ? 0 : status.phase === 'complete' ? 100 : (status.generation || 0) / Math.max(1, status.target_generations || 1) * 100;
  const runningText = status.phase === 'self_play' || status.phase === 'evaluating' ? `${number(status.completed_games || 0)} / ${number(status.target_games)}局 ${status.opponent ? `· ${opponentName(status.opponent)}` : ''}` : status.phase === 'optimizing' ? `${status.update || 0} / ${status.target_updates} 更新` : manifest ? `${manifest.config.workers} workers · ${manifest.config.environments} 対局 · ${status.device || manifest.hardware.device}` : '上の「学習開始」から開始';
  $('liveStatus').innerHTML = `<div class="status-symbol">${status.phase === 'complete' ? '✓' : '◈'}</div><div class="status-description"><h3>${escapeHTML(run ? phase : '学習を始める準備ができています')}${smoke ? tag('動作テスト', 'amber') : ''}</h3><p>${escapeHTML(runningText)}</p></div><div class="status-progress"><div class="progress-label"><span>${manifest ? `G${status.generation ?? manifest.generation}${unlimited ? '' : ` / ${manifest.config.generations} 世代`}` : '初回セットアップ待ち'}</span><span>${unlimited ? '停止まで継続' : `${number(progress)}%`}</span></div><div class="progress-track" ${unlimited ? 'hidden' : ''}><span style="width:${Math.min(100, progress)}%"></span></div></div>`;
  const totalGames = history.reduce((n, r) => n + r.self_play.games, 0), totalSamples = history.reduce((n, r) => n + r.self_play.new_samples, 0);
  const cps = record ? record.self_play.rounds / record.self_play.seconds : null;
  const gateRecord = history.filter(r => r.generation <= (record?.generation || 0) && r.evaluation.some(e => ['recent_checkpoint','champion'].includes(e.opponent))).at(-1);
  const gate = gateRecord?.evaluation.find(e => ['recent_checkpoint','champion'].includes(e.opponent));
  const cards = [
    ['完了した世代', number(manifest?.generation), '世代', manifest ? `${unlimited ? '停止まで継続' : `${manifest.config.generations}世代まで計画`} / 基準 G${manifest.champion_generation}` : '世代ごとに再開可能な状態を保存'],
    ['自己対戦の対局数', run ? number(totalGames) : '—', '局', run ? `${number(totalSamples)} 新規サンプルを収集` : '途中の対局は完了後に記録'],
    ['自己対戦スループット', number(cps, 1), 'round / 秒', record ? `G${record.generation} / 推論・探索・転送を含む` : '実行環境と一緒に実測値を保存'],
    ['対・学習済みモデルの得点率', percent(gate?.score), '', gate ? `G${gateRecord.generation}${gate.reference_generation ? ` 対G${gate.reference_generation}`:''} / 区間 ${percent(gate.interval[0])}–${percent(gate.interval[1])}` : 'G0を除く学習済みモデルができると比較']
  ];
  $('kpis').innerHTML = cards.map(([label, value, unit, note]) => `<article class="kpi"><div class="kpi-label">${label}<span>↗</span></div><div class="kpi-value">${value}<small>${unit}</small></div><p class="kpi-foot">${escapeHTML(note)}</p></article>`).join('');
  plot($('strengthChart'), [{name:'学習済みモデルへの得点率',color:'#111111',points:history.map(r=>{const e=r.evaluation.find(e=>e.opponent==='recent_checkpoint');return {x:r.generation,y:e?.score,note:e?.reference_generation?`対G${e.reference_generation}`:''};})}],true);
  plot($('lossChart'), [{ name: '方策損失', color: '#111111', points: history.map(r => ({ x: r.generation, y: r.optimization.policy_loss })) }, { name: '価値損失', color: '#8e8e8e', points: history.map(r => ({ x: r.generation, y: r.optimization.value_loss })) }]);
  plot($('roundsChart'), [{name:'自己対戦の平均ラウンド',color:'#111111',points:history.map(r=>({x:r.generation,y:generationStats(r).meanRounds}))}]);
  plot($('drawChart'), [{name:'引分率',color:'#111111',points:history.map(r=>({x:r.generation,y:generationStats(r).drawRate}))}, {name:'千日手率',color:'#8e8e8e',points:history.map(r=>({x:r.generation,y:generationStats(r).repetitionRate}))}],true);
  if (record) {
    const search = record.self_play.search, total = record.self_play.seconds;
    const timings = [['方策・特徴量', search.policy_seconds], ['Rust局面探索・転送', search.preview_seconds], ['局面のバッチ推論', search.value_seconds], ['混合戦略の計算', search.solver_seconds]];
    timings.push(['実着手・記録など', Math.max(0, total - timings.reduce((s, r) => s + r[1], 0))]);
    $('efficiency').innerHTML = timings.map(([label, seconds]) => `<div class="timing-row"><span>${label}</span><div class="timing-track"><i style="width:${seconds / Math.max(total, .001) * 100}%"></i></div><b>${number(seconds, 2)} 秒</b></div>`).join('') + `<div class="mini-stat-grid"><span>重複局面の推論削減<b>${percent(1 - search.unique_leaves / Math.max(1, search.cells))}</b></span><span>サンプル再利用<b>${number(record.optimization.presentations / Math.max(1, record.self_play.new_samples), 1)} 回</b></span><span>過去モデルとの対局<b>${record.self_play.history_games} / ${record.self_play.games}</b></span></div>`;
  } else $('efficiency').innerHTML = empty('実行後に、時間の内訳と再利用率を表示します。');
  $('gateSummary').innerHTML = gateMarkup(gate, smoke) + (gate && gateRecord.generation !== record.generation ? `<p class="hint">直近の評価 G${gateRecord.generation} を表示。この世代は学習を優先し、対戦評価を省略しています。</p>` : '');
  $('generationTable').innerHTML = history.length ? history.slice().reverse().map(r => {
    const g = r.evaluation.find(e => ['recent_checkpoint','champion'].includes(e.opponent));
    const stats=generationStats(r);
    return `<tr data-gen="${r.generation}" class="${r.generation === record?.generation ? 'selected' : ''}"><td><button class="generation-link" data-gen="${r.generation}" aria-current="${r.generation===record?.generation?'true':'false'}">G${r.generation.toString().padStart(3, '0')}</button></td><td>${number(stats.games)} 局</td><td>${number(stats.meanRounds,2)}</td><td>${percent(stats.drawRate)}</td><td>${number(stats.policyLoss,3)}</td><td>${number(stats.valueLoss,4)}</td><td class="score-cell">${percent(g?.score)}${g?.reference_generation?`<small> 対G${g.reference_generation}</small>`:''}</td><td>${tag(smoke ? '動作テスト' : r.promoted ? '昇格' : r.evaluation.length ? '継続評価' : '学習更新', smoke || !r.promoted && r.evaluation.length ? 'amber' : '')}</td></tr>`;
  }).join('') : '<tr><td colspan="8">確定した世代はまだありません。</td></tr>';
  renderExternal(history, record); renderLearningSummary(); renderGenerationDetail();
}

function renderExternal(history, record) {
  const visible = history.filter(row => row.generation <= (record?.generation ?? Infinity));
  const records = externalRecords(visible);
  const latest = ['evaluation', 'training'].map(phase => records.filter(row => row.phase === phase).at(-1)).filter(Boolean);
  $('externalSummary').innerHTML = latest.length ? `<div class="generation-metrics">${latest.map(row => `<div class="gen-metric"><div class="gen-metric-label">G${row.generation} ${row.phase === 'evaluation' ? '定期評価' : '学習中の対戦'} · ${number(row.engine?.nodes)}ノード</div><div class="gen-metric-value">勝率 ${percent(row.win_rate ?? row.wins / row.games)}</div><p class="hint">${row.wins}勝 ${row.draws}分 ${row.losses}敗 / ${row.games}局<br>得点率 ${percent(row.score)} · 既存AIの手 ${percent(row.adapter?.usi_coverage)}</p></div>`).join('')}</div>` : empty('既存AIとの対局が完了すると、勝率・得点率・対局数を表示します。設定から通常の自己対戦と定期評価に混ぜられます。');
  plot($('externalChart'), externalSeries(history), true);
  const groups = externalSummary(visible);
  $('externalOpponentTable').innerHTML = groups.length ? `<div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>区分・相手</th><th>探索量</th><th>勝 / 分 / 負</th><th>勝率</th><th>得点率</th><th>対局数</th><th>既存AIの手</th></tr></thead><tbody>${groups.map(row => `<tr><td>${row.phase === 'evaluation' ? '定期評価' : '学習中'}<small title="${escapeHTML(row.opponentId)}"> · ${escapeHTML(row.engine?.name || '既存AI')}</small></td><td>${number(row.engine?.nodes)}ノード</td><td>${row.wins} / ${row.draws} / ${row.losses}</td><td>${percent(row.winRate)}</td><td>${percent(row.score)}</td><td>${row.games}局</td><td>${percent(row.coverage)}</td></tr>`).join('')}</tbody></table></div></div><p class="hint">学習中の対戦は成長中のモデルの観測成績です。定期評価はその世代の重みを固定して対戦します。既存AIが扱えない局面で補助AIを使った割合も残します。</p>` : empty('同じ相手・探索量ごとの記録はまだありません。');
}

function renderLearningSummary() {
  const run=state.selected, snapshot=learningSnapshot(run?.history || []);
  $('historyPersistence').textContent = run ? `確定した世代のデータは停止後も保存されます。保存記録：${run.history.length}世代${run.history.length?`（G${run.history[0].generation}〜G${run.history.at(-1).generation}）`:''}。${run.lineage?.length>1?'継続前の記録もつなげて表示しています。':''}停止時に破棄されるのは進行中の未確定世代です。` : '学習を開始すると世代ごとの損失と対局結果を保存します。';
  if(run?.warm_start){const note=document.createElement('span');note.className='hint migration-note';note.textContent=`${run.warm_start.different_rules?'旧ルールの':'元モデルの'}G${run.warm_start.generation}の重みを引き継いで開始。世代は別に記録しています。`;
    if(run.warm_start.run){const link=document.createElement('button');link.className='text-button';link.textContent='移行前の記録を見る';link.dataset.historyRun=run.warm_start.run;link.dataset.historyGeneration=String(run.warm_start.generation);note.append(link);}$('historyPersistence').append(note);}
  if (!snapshot) { $('learningSummary').innerHTML=empty('確定した世代の記録が集まると分析を表示します。');return; }
  const {recent,previous,reference,referenceGeneration}=snapshot;
  const notes=[`G${recent.firstGeneration}〜G${recent.lastGeneration}・${number(recent.games)}局：平均${number(recent.meanRounds,2)}ラウンド、引分率${percent(recent.drawRate)}、千日手率${percent(recent.repetitionRate)}。`,
    `方策損失 ${number(recent.policyLoss,3)}、価値損失 ${number(recent.valueLoss,4)}${previous?`。前の${previous.generations}世代は ${number(previous.policyLoss,3)}／${number(previous.valueLoss,4)}`:''}。損失だけで棋力向上は判断できません。`];
  if (recent.drawRate>=.8) notes.push('引き分け（価値0）が多いため、価値損失が小さくても反復への適応が進んだ可能性があります。');
  if (reference) notes.push(`直近評価 G${referenceGeneration}・対G${reference.reference_generation??'不明'}：${reference.wins}勝${reference.draws}分${reference.losses}敗、得点率${percent(reference.score)}、個別95%区間${percent(reference.interval[0])}〜${percent(reference.interval[1])}。${reference.interval[0]>.5?'この相手への個別評価では優位。':reference.interval[1]<.5?'この相手への個別評価では劣勢。':'この相手への優位は未確認。'}`);
  const self=snapshot.selfEvaluation;
  if(self)notes.push(`直近のG${snapshot.selfEvaluationGeneration}評価では、現在モデル同士の${self.draws}／${self.games}局が引き分け。自己対戦の得点率50%は強さの証拠にはなりません。`);
  if(Number.isFinite(recent.eliteUpgrades)) notes.push(`この区間の格7昇格は${number(recent.eliteUpgrades)}回。${recent.eliteUpgrades===0?'格7が登場していないため、この区間では格7の強弱を評価できません。':'獲得価値・生存・衝突・温存は各世代の詳細で確認できます。'}`);
  if(snapshot.conditionChanged)notes.push('学習条件が変わったため、変更後の世代を別区間として集計しています。');
  $('learningSummary').innerHTML=`<p class="learning-status">${escapeHTML(snapshot.status)}</p><ul class="learning-notes">${notes.map(note=>`<li>${escapeHTML(note)}</li>`).join('')}</ul>`;
}

function renderGenerationDetail() {
  const record=selectedRecord(), run=state.selected;
  $('generationDetailCard').hidden=!record;
  if(!record)return;
  const s=generationStats(record), config=record.config || run.manifest.config, generation=record.generation;
  $('generationDetailTitle').textContent=`G${generation} の詳細${selectedGeneration===null?'（最新）':''}`;
  $('latestGeneration').disabled=selectedGeneration===null;
  $('downloadGeneration').href=`/api/generation?run=${encodeURIComponent(selectedRun)}&generation=${generation}`;
  const metrics=[['自己対戦',`${number(s.games)}局`],['平均対局ラウンド',number(s.meanRounds,2)],['方策損失',number(s.policyLoss,4)],['価値損失',number(s.valueLoss,4)],
    ['引き分け',`${number(s.draws)}局／${percent(s.drawRate)}`],['千日手',`${number(s.repetitions)}局／${percent(s.repetitionRate)}`],['ラウンド上限による終了',number(s.roundLimitDraws)],
    ['新規サンプル',number(s.samples)],['リプレイ内の局面',number(s.replaySize)],['最適化の更新回数',number(s.updates)],['学習に使用した延べサンプル',number(s.presentations)],
    ['過去モデルとの対局',`${number(s.historyGames)}局${s.historyCheckpoint?`（${s.historyCheckpoint}）`:''}`],['1世代の所要時間',`${number(s.seconds,2)}秒`],['自己対戦の速度',`${number(s.speed,1)}ラウンド／秒`],
    ['格7への昇格',number(s.eliteUpgrades)],['格7の観測生存ラウンド',number(s.eliteSurvival,2)],['格7の捕獲／終局時生存',`${number(s.eliteCaptured)}／${number(s.eliteCensored)}`],
    ['格7の衝突勝利',number(s.eliteCollisionWins)],['格7の停止中の捕獲',number(s.eliteStationaryCaptures)],['動ける格7を動かさない割合',percent(s.eliteIdleRate)],['格7移動中の連続移動割合',percent(s.eliteConsecutiveRate)],
    ['片側だけ格7を獲得した側の勝率',`${percent(s.eliteHolderWinRate)}${s.eliteHolderGames!==null?`（${s.eliteHolderGames}局）`:''}`],['序盤の種類',number(s.uniqueOpenings)],['着手の種類',number(s.uniqueActions)],['着手エントロピー',number(s.actionEntropy,3)]];
  const outcomes={};for(const outcome of record.self_play.outcomes||[])outcomes[outcome.reason]=(outcomes[outcome.reason]||0)+1;
  const evaluations=record.evaluation.map(e=>`<tr><td>${escapeHTML(opponentName(e.opponent))}${e.reference_generation?`（G${e.reference_generation}）`:''}</td><td>${e.wins}／${e.draws}／${e.losses}</td><td>${percent(e.score)}</td><td>${percent(e.interval[0])}〜${percent(e.interval[1])}（${percent(e.confidence)}）</td></tr>`).join('');
  const files=(run.artifacts||[]).filter(file=>artifactGeneration(file)===generation&&(file.startsWith('games/')||file.includes('-replay-')));
  const signature=`${run.id}:${generation}:${record.timestamp}:${files.length}`;
  if($('generationDetail').dataset.signature===signature){$('detailLatestGeneration').textContent=String(run.manifest.generation);return;}
  $('generationDetail').dataset.signature=signature;
  $('generationDetail').innerHTML=[
    `<p class="hint">${when(record.timestamp)} JST · ${record.inherited?'継続前の保存記録':'この実行の保存記録'} · 最新確定G<span id="detailLatestGeneration">${run.manifest.generation}</span></p>`,
    `<div class="generation-metrics">${metrics.map(([label,value])=>`<div class="gen-metric"><div class="gen-metric-label">${escapeHTML(label)}</div><div class="gen-metric-value">${escapeHTML(value)}</div></div>`).join('')}</div>`,
    `<p class="hint">終了理由：${Object.entries(outcomes).map(([reason,n])=>`${escapeHTML(reasonNames[reason]||reason)} ${n}局`).join('、')||'記録なし'}。生存は終局時の打ち切りを含む観測値、保有側勝率は因果効果ではありません。— は記録なし／該当なしです。</p>`,
    '<h3 class="detail-subtitle">この世代の対戦評価</h3>',
    evaluations?`<div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>対戦相手</th><th>勝／分／負</th><th>得点率</th><th>区間（保存値）</th></tr></thead><tbody>${evaluations}</tbody></table></div></div>`:empty('この世代では定期評価を実施していません。'),
    record.self_play.external_ai ? `<h3 class="detail-subtitle">学習中の既存AIとの対戦</h3><p>${record.self_play.external_ai.wins}勝 ${record.self_play.external_ai.draws}分 ${record.self_play.external_ai.losses}敗 / ${record.self_play.external_ai.games}局 · 勝率${percent(record.self_play.external_ai.win_rate)} · 得点率${percent(record.self_play.external_ai.score)} · ${number(record.self_play.external_ai.engine?.nodes)}ノード</p><p class="hint">既存AIが選んだ手 ${percent(record.self_play.external_ai.adapter?.usi_coverage)}。教師データ ${number(record.self_play.external_ai.teacher?.decisions)}手。</p>` : '',
    `<h3 class="detail-subtitle">この世代の学習条件</h3><p class="detail-config">${number(config.games_per_generation)}局／世代・同時${number(config.environments)}対局・バッチ${number(config.batch_size)}・更新${number(config.updates)}回・候補${number(config.cheap_candidates)}〜${number(config.candidates)}・評価${number(config.eval_pairs)}ペア／${number(config.eval_every)}世代ごと${config.external_ai_enabled ? `・既存AI ${number(config.external_ai_nodes)}ノード／混在${percent(config.external_ai_fraction)}` : ''}</p>`,
    `<h3 class="detail-subtitle">この世代の保存棋譜</h3><label class="field">対局<select class="select" id="generationReplay"><option value="">棋譜を選択（${files.length}件）</option>${files.map(file=>`<option value="${escapeHTML(file)}">${escapeHTML(file.replace(/^.*ancestor-[^/]+\//,'').replace('.json',''))}</option>`).join('')}</select></label>`,
    `<button class="btn btn-ghost" id="viewGenerationReplay" ${files.length?'':'disabled'}>選んだ棋譜を対局ビューアで開く</button>`
  ].join('');
  $('viewGenerationReplay').addEventListener('click',()=>{const file=$('generationReplay').value;if(!file)return;showView('analysis');$('replaySelect').value=file;$('replayRound').value='1';void loadReplay();});
}
function renderEvaluation() {
  const run = state.selected, record = selectedRecord(), manifest = run?.manifest;
  $('evalGeneration').textContent = record ? `G${record.generation} / ${manifest.rules.profile} / 上限${manifest.rules.roundLimit}ラウンド` : '評価結果がまだありません';
  $('evaluationTable').innerHTML = record?.evaluation.length ? record.evaluation.map(e => {
    const [label, kind] = decisions[e.decision] || decisions.inconclusive;
    return `<tr><td>${escapeHTML(opponentName(e.opponent))}${e.engine ? `<small> · ${number(e.engine.nodes)}ノード</small>` : ''}</td><td>${e.wins} / ${e.draws} / ${e.losses}</td><td>${percent(e.win_rate ?? e.wins / e.games)}</td><td class="score-cell">${percent(e.score)}</td><td>${percent(e.interval[0])}–${percent(e.interval[1])}<span class="confidence">${number(e.confidence * 100, 1)}%</span></td><td>${e.games} 局</td><td>${tag(manifest.rules.roundLimit !== 200 ? '動作テスト' : label, kind)}</td></tr>`;
  }).join('') : '<tr><td colspan="7">この世代の対戦評価はありません。評価した世代を概要の表から選択できます。</td></tr>';
  $('championInfo').innerHTML = manifest?.evaluation_protocol==='learned-only-v1' ? `<p>現在モデル同士と、最近の学習済みチェックポイントを同じ探索量で評価します。固定AI・開始時モデルへの定期対戦は行いません。比較相手は25世代区切りで選ぶため、相手世代も確認してください。最新はG${manifest.generation}です。</p>` : manifest ? `<div class="meta-grid"><span>基準モデル（旧評価）</span><b>G${manifest.champion_generation}</b><span>最終モデル</span><b>G${manifest.generation}</b><span>探索予算</span><b>最大 ${manifest.config.candidates} × ${manifest.config.candidates} 候補 / ${manifest.config.regret_iterations} 反復</b><span>判定条件</span><b>対・基準モデルの補正済み区間の下限 &gt; 50%</b></div>` : empty('モデルを読み込むと条件を表示します。');
  if (manifest?.evaluation_protocol === 'mixed-external-v1') $('championInfo').innerHTML = `<p>現在モデル同士、最近の学習済みモデル、既存AIを${number(manifest.config.eval_every)}世代ごとに評価します。既存AIは${number(manifest.config.external_ai_nodes)}ノード・${number(manifest.config.external_ai_eval_pairs)}ペアで固定し、相手と予算の識別子を記録します。重み・探索方式が異なるため、同じ計算時間の比較ではありません。</p>`;
  const evaluations = run?.local_evaluations?.filter(Boolean) || [];
  $('localEvaluations').innerHTML = evaluations.length ? evaluations.map(e => `<div class="evaluation-entry"><span>対・${escapeHTML(opponentName(e.opponent))}</span><b>${percent(e.score)}</b><span>${e.games}局 / ${percent(e.interval[0])}–${percent(e.interval[1])}</span>${tag((decisions[e.decision] || decisions.inconclusive)[0], (decisions[e.decision] || decisions.inconclusive)[1])}</div>`).join('') : empty('上のフォームから、読み込んだモデルを追加評価できます。');
  renderDistillation();
}

function renderDistillation() {
  const select = $('distillSource');
  const changedRun = select.dataset.displayRun !== selectedRun;
  options(select, [{ value: '', label: 'モデルを選択' }, ...state.runs.map(run => ({ value: run.id, label: `${run.name} · G${run.generation}` }))], changedRun ? selectedRun : select.value);
  select.dataset.displayRun = selectedRun;
  const source = state.runs.find(run => run.id === select.value);
  const datasets = (state.teacher_datasets || []).filter(data => data.rules_hash === source?.rules_hash);
  options($('distillDataset'), [{ value: '', label: datasets.length ? '教師データを選択' : '同じルールの完了済み教師データはまだありません' }, ...datasets.map(data => ({ value: data.id, label: `${data.name} · ${data.games}局 / ${data.decisions}手${data.nodes ? ` / ${number(data.nodes)}ノード` : ''}` }))]);
  const dataset = datasets.find(row => row.id === $('distillDataset').value);
  $('distillCheckpoint').max = source?.generation ?? 0;
  $('distillCheckpoint').placeholder = source ? `最新の確定済み世代 G${source.generation}` : '最新の確定済み世代';
  if (source && Number($('distillCheckpoint').value) > source.generation) $('distillCheckpoint').value = '';
  $('distillButton').disabled = !!state.job || submitting || !source || !dataset;
  $('distillPreview').textContent = state.job ? '学習・評価を停止してから蒸留を実行できます。' : dataset ? `${dataset.games}局・${dataset.decisions}手の教師データを使い、元モデルを保持して別モデルを作ります。完成後は通常の評価や自己対戦に使えます。` : '自己対戦・定期評価・追加評価で教師データを保存できます。既存AIが実際に選んだ手と、完了した対局の勝敗を使います。';
}
function renderAnalysis() {
  const run = state.selected;
  const generation=selectedRecord()?.generation;
  const files = (run?.artifacts || []).filter(file=>artifactGeneration(file)===generation || artifactGeneration(file)===null);
  const replays=files.filter(p => p.startsWith('games/') || p.includes('-replay-'));
  if($('replaySelect').value&&!replays.includes($('replaySelect').value))clearReplay();
  options($('replaySelect'), [{ value: '', label: generation?`G${generation}の棋譜を選択`:'棋譜を選択' }, ...replays.map(file => ({ value: file, label: file.replace(/^.*ancestor-[^/]+\//,'').replace('.json', '') }))]);
  options($('probeSelect'), [{ value: '', label: '分析記録を選択' }, ...files.filter(p => p.startsWith('probes/')).map(file => ({ value: file, label: file.replace('.json', '') }))]);
  const events = selectedRecord()?.self_play.events || {};
  $('eventStats').innerHTML = Object.entries(events).length ? Object.entries(events).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => `<div class="events-bar"><span>${escapeHTML(eventNames[name] || name)}</span><b>${number(count)}</b></div>`).join('') : empty('世代ごとの捕獲・衝突の集計を表示します。');
}
function renderBenchmark() {
  const b = state.benchmark;
  if (!b) { $('benchmarkResult').innerHTML = empty('「行動生成を計測」で、既存方式と高速版を比較できます。'); return; }
  const median = values => { const s = values.slice().sort((a, b) => a - b); return (s[2] + s[3]) / 2; };
  const ref = median(b.measurements.filter(r => !r.fast).map(r => r.seconds)), fast = median(b.measurements.filter(r => r.fast).map(r => r.seconds));
  $('benchmarkResult').innerHTML = `<div class="benchmark-grid"><strong>${number(ref / fast, 2)}<small>×</small></strong><p>行動生成の速度比（中央値）<br>既存 ${number(ref, 4)}秒 → 高速 ${number(fast, 4)}秒</p><p>${b.corpusPositions}局面 / ${b.iterations}反復 / 各6回<br>${escapeHTML(b.cpu || 'CPU')} / ${when(b.timestamp)} JST</p>${tag(b.equivalent ? '全候補・列挙順の一致を確認' : '一致未確認', b.equivalent ? '' : 'red')}</div><p class="hint">盤面の局面評価や棋力の倍率ではありません。正式な棋力は対戦で別途確認します。${b.source_fingerprint !== state.source_fingerprint ? 'この記録は別のソース版で計測されています。' : ''}</p>`;
}
function renderBalance() {
  const sources = [...state.runs].filter(run => run.round_limit === 200).sort((a,b) => b.generation-a.generation);
  options($('balanceSource'), sources.length ? sources.map(run => ({ value:run.id, label:`${run.name} · G${run.generation}` })) : [{value:'',label:'比較元のモデルがありません'}]);
  const items = state.experiments || [];
  options($('balanceExperiment'), items.length ? items.map(item => ({value:item.id,label:`${item.id} · 元G${item.manifest.parent.generation}`})) : [{value:'',label:'比較実験を作成してください'}]);
  const item = items.find(row => row.id === $('balanceExperiment').value);
  const choices=[...new Set(item?.children.map(c=>c.rule)||[])];
  const selected=$('balanceRule').value || (choices.includes('D+B2-C1')?'D+B2-C1':choices[0]);
  options($('balanceRule'),choices.length ? [...choices.map(value=>({value,label:value==='D+B2-C1'?'2回目から格低下＋自陣+1':value})),{value:'all',label:'全条件（比較用）'}] : [{value:'',label:'比較実験を選択'}],selected);
  $('balanceInit').disabled = !!state.job || !sources.length;
  for (const id of ['balanceShort','balanceTrain','balanceLong']) $(id).disabled = !!state.job || !item || item.manifest.initialized === false;
  $('balanceExport').hidden = !item || !!state.job;
  $('balanceExport').href = item ? `/api/experiment/export?experiment=${encodeURIComponent(item.id)}` : '#';
  $('balanceProgress').innerHTML = item ? `<p class="hint">${escapeHTML(item.status.phase || 'ready')} · ${escapeHTML(item.status.stage || '比較準備完了')} / 元モデル G${item.manifest.parent.generation} / SHA ${escapeHTML(item.manifest.parent.sha256.slice(0,12))}</p><div class="table-wrap"><table><thead><tr><th>ルール</th><th>学習種</th><th>確定世代</th><th>状態</th></tr></thead><tbody>${item.children.map(child => `<tr><td>${escapeHTML(child.rule)}</td><td>${child.seed}</td><td>G${child.generation}</td><td>${escapeHTML(phases[child.status.phase] || child.status.phase || '準備完了')}</td></tr>`).join('')}</tbody></table></div>` : empty('モデルを選んで比較実験を作成してください。');
  const rows = item?.report?.results || [];
  $('balanceResults').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>ルール</th><th>比較 / 世代</th><th>局数</th><th>平均ラウンド</th><th>格7昇格 / 局</th><th>生存観測 / 打切り</th><th>衝突勝利</th><th>停止時捕獲</th><th>保有側勝率 / 局数</th><th>引分 / 千日手</th><th>温存 / 連続移動</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHTML(r.rule)}</td><td>${r.stage === 'short' ? '短期' : '長期'} / G${r.generation}</td><td>${r.games}</td><td>${number(r.mean_rounds,1)}</td><td>${number(r.elite_upgrades_per_game,2)}</td><td>${number(r.elite_survival.mean_observed_rounds,1)} / ${r.elite_survival.censored}</td><td>${r.elite_collision_wins}</td><td>${r.elite_stationary_captures}</td><td>${percent(r.elite_ownership.only_one_win_rate)} / ${r.elite_ownership.only_one_games || 0}</td><td>${percent(r.draw_rate)} / ${percent(r.repetition_rate)}</td><td>${percent(r.elite_idle_when_mobile_rate)} / ${percent(r.elite_consecutive_move_rate)}</td></tr>`).join('')}</tbody></table></div><p class="hint">保有側勝率は片側だけが格7を獲得した局の観測値です。生存観測には終局時生存を含みます。標本数・打切り・区間を含む詳細と棋譜を併せて判断してください。</p>` : empty('短期比較または長期比較の完了後に表示します。');
}
function render() {
  const run = state.selected, busy = !!state.job;
  $('rulesVersion').textContent = state.rules_version ? `v${state.rules_version}` : '—';
  if (run && renderedRun !== run.id) {
    if(renderedRun!==null)selectedGeneration=null;
    renderedRun = run.id; selectedRun = run.id; replay = null;
    $('board').innerHTML = empty('棋譜を選ぶと、盤面と段階ごとの結果を表示します。');
    $('replayEvents').innerHTML = empty('捕獲理由、衝突、打ち込みを確認できます。');
    $('probeDetails').innerHTML = empty('分析記録を選択してください。');
    $('replayVerified').textContent = '未選択'; $('replayHands').textContent = '';
    $('replaySelect').value = ''; $('probeSelect').value = '';
    $('compareRun').value = ''; $('comparison').innerHTML = empty('別の実行を選ぶと、条件と結果を並べて表示します。');
  }
  options($('runSelect'), state.runs.length ? state.runs.map(r => ({ value: r.id, label: `${r.name} · G${r.generation}${r.round_limit !== 200 ? ' · 動作テスト' : ''}` })) : [{ value: '', label: '実行記録なし' }], selectedRun);
  options($('compareRun'), [{ value: '', label: '比較先を選択' }, ...state.runs.filter(r => r.id !== selectedRun).map(r => ({ value: r.id, label: r.name }))]);
  $('sourceTag').textContent = run?.source || 'Local';
  $('runFingerprint').textContent = run ? `${run.manifest.rules.profile} · ${run.manifest.source_fingerprint.slice(0, 8)}` : '';
  $('runFingerprint').title = run?.manifest.source_fingerprint || '';
  const notices = [...state.warnings,...(run?.history_warnings || [])];
  if (run && !run.compatible) notices.push(run.resumable ? '保存時のソースで再開できます。新しい評価方法で続けるには「この状態を引き継ぐ」を使用してください。' : '再開に必要な保存データを確認してください。');
  if (run?.status.phase === 'failed') notices.push(`前回の処理が失敗しました: ${run.status.error || '実行ログを確認してください。'}`);
  if (run && ['self_play', 'evaluating', 'optimizing'].includes(run.status.phase) && Date.now() / 1000 - run.status.updated > 180) notices.push('進捗の最終記録から3分以上経過しています。ColabとDriveの同期状況を確認してください。');
  if (state.last_job?.code && !state.job) notices.push('処理が失敗しました。「進捗」の生ログを確認してください。');
  $('globalNotice').textContent = notices.join(' '); $('globalNotice').hidden = !notices.length;
  const nextConfig = run?.resume_config, currentConfig = run?.manifest.config;
  const pendingSettings = nextConfig && Object.keys(nextConfig).some(key => JSON.stringify(nextConfig[key]) !== JSON.stringify(currentConfig[key]));
  $('resumeSettingsNotice').hidden = !pendingSettings;
  const settingNames = { generations:'終了世代', games_per_generation:'対局数', environments:'同時対局数', workers:'CPUワーカー数', candidates:'最大候補数', cheap_candidates:'通常候補数', batch_size:'バッチサイズ', value_batch_size:'推論バッチサイズ', updates:'更新回数', eval_pairs:'評価ペア数', eval_every:'評価間隔', device:'実行先', amp:'混合精度', external_ai_enabled:'既存AI', external_ai_nodes:'既存AIノード数', external_ai_fraction:'既存AI混在割合', external_ai_eval_pairs:'既存AI評価ペア数', external_ai_save_teacher:'教師データ保存' };
  const settingValue = (key, value) => key === 'generations' && value === 0 ? '無制限' : key === 'external_ai_fraction' ? percent(value) : typeof value === 'boolean' ? value ? '有効' : '無効' : value ?? '未設定';
  const changes = pendingSettings ? Object.entries(settingNames).filter(([key]) => nextConfig[key] !== currentConfig[key]).map(([key, label]) => `${label} ${settingValue(key,currentConfig[key])}→${settingValue(key,nextConfig[key])}`).join('、') : '';
  $('resumeSettingsNotice').textContent = pendingSettings ? `次回の再開は ${number(nextConfig.games_per_generation)}局／世代・同時${number(nextConfig.environments)}対局。変更：${changes}。` : '';
  if (!settingsLoaded) { fillSettings(state.settings.training); settingsLoaded = true; }
  updateRuntime();
  $('stopJob').disabled = !busy; $('benchmarkButton').disabled = busy; $('smokeStart').disabled = busy;
  $('statusText').textContent = busy ? ({ training: '学習中', evaluation: '評価中', distillation:'蒸留中', probe: '分析中', benchmark: '計測中' }[state.job.kind] || '処理中') : '待機中';
  $('statusDot').classList.toggle('running', busy);
  $('statusGen').textContent = run ? `G${run.manifest.generation}` : '';
  $('evaluateButton').disabled = busy || !run?.compatible;
  $('probeButton').disabled = busy || !run?.compatible || !replay;
  if (document.activeElement !== $('sourceDir')) $('sourceDir').value = state.settings.source_dir;
  $('jobLabel').textContent = state.job ? ({ training: 'ローカル学習中', evaluation: 'ローカル評価中', distillation:'教師データから蒸留中', probe: '局面を再分析中', benchmark: '計測中' }[state.job.kind] || state.job.kind) : state.last_job ? (state.last_job.code === 0 ? '処理完了' : 'エラー') : '待機中';
  $('jobLogs').textContent = state.logs.join('\n') || 'ローカル処理のログがここに表示されます。';
  $('exportRun').hidden = !run;
  $('exportRun').href = `/api/export?run=${encodeURIComponent(selectedRun)}`;
  $('sourceSnapshot').hidden = !run?.source_snapshot;
  $('sourceSnapshot').href = `/api/source-snapshot?run=${encodeURIComponent(selectedRun)}`;
  renderOverview(); renderEvaluation(); renderAnalysis(); renderBenchmark(); renderBalance(); updateRuntime();
}
export async function refresh() {
  const id = ++requests;
  try {
    const next = await request(`/api/state${selectedRun && !followNewRun ? `?run=${encodeURIComponent(selectedRun)}` : ''}`);
    if (id !== requests) return;
    if (followNewRun && (next.job?.run || !next.job && next.last_job)) followNewRun = false;
    state = next; render();
  } catch (error) {
    $('statusText').textContent = '未接続';
    $('globalNotice').textContent = error.message; $('globalNotice').hidden = false;
  }
}
async function action(endpoint, data, message) {
  if (submitting) return;
  submitting = true; updateRuntime();
  try {
    await request(endpoint, data);
    if (['/api/start', '/api/resume', '/api/distill'].includes(endpoint)) { selectedRun = ''; selectedGeneration = null; followNewRun = true; }
    toast(message); await refresh();
  } catch (error) { toast(error.message, true); }
  finally { submitting = false; updateRuntime(); }
}
function fillSettings(config) {
  if (!config) return;
  for (const input of document.querySelectorAll('[data-setting]')) input.value = input.dataset.setting === 'external_ai_fraction' ? (config.external_ai_fraction ?? .25) * 100 : config[input.dataset.setting];
  $('deviceInput').value = config.device; $('ampInput').checked = config.amp;
  $('externalAIEnabled').checked = !!config.external_ai_enabled;
  $('teacherSaveInput').checked = config.external_ai_save_teacher !== false;
}
function updateRuntime() {
  const device = state?.job?.device || (['evaluation', 'benchmark'].includes(state?.job?.kind) ? 'cpu' : state?.settings.training.device || 'cuda');
  const gpu = device === 'cuda' || device === 'auto' && runtime?.cuda_available;
  const usable = runtime?.ready && (!gpu || runtime.cuda_available);
  $('runtimeState').textContent = runtime ? gpu ? 'Local GPU' : 'Local CPU' : '確認中';
  $('runtimeState').title = gpu ? runtime?.gpu || 'CUDA未検出' : 'CPU';
  $('localStart').disabled = !!state?.job || submitting || !usable;
  if (state) {
    $('resumeButton').disabled = !!state.job || submitting || !usable || !state.selected?.resumable;
    $('continueButton').disabled = !!state.job || submitting || !usable || !state.selected?.resumable || state.selected.manifest.schema!=='simultaneous-shogi/net-v2-62x24';
    const run=state.selected,stop=$('resumeUntil');
    if (run && !state.job && document.activeElement!==stop && (stop.dataset.run!==run.id || Number(stop.value)>0 && Number(stop.value)<=run.manifest.generation)) {
      const next=[run.status.next_stop_generation,...(run.manifest.recommended_milestones||[])].find(g=>g>run.manifest.generation);
      stop.value=String(next||0);stop.dataset.run=run.id;
    }
  }
  $('deviceHelp').textContent = runtime?.cuda_available ? `${runtime.gpu} · ${runtime.memory_gb} GB` : runtime ? 'GPU未検出。setup-gpu.batで導入、またはCPUを選択。' : 'GPUを確認しています…';
  if (state) {
    $('externalAIHelp').textContent = state.external_ai?.available ? '既存AIは準備済みです。通常の評価間隔で対戦し、教師データも保存できます。既定は2,000ノードです。' : '先に「既存AIを準備」を実行してください。公開エンジンと評価関数を取得します。';
    $('setupExternalAI').hidden = !!state.external_ai?.available;
    $('setupExternalAI').disabled = !!state.job || submitting;
    const budget = String(state.settings.training.external_ai_nodes ?? 2000);
    if ($('evalNodes').dataset.saved !== budget) { $('evalNodes').value = budget; $('evalNodes').dataset.saved = budget; }
    $('evalNodes').disabled = $('evalOpponent').value !== 'external_usi';
    $('distillButton').disabled = !!state.job || submitting || !$('distillSource').value || !$('distillDataset').value;
  }
}
async function loadRuntime(force = false) {
  try {
    runtime = await request('/api/runtime' + (force ? '?refresh=1' : ''));
    const rows = [['GPU', runtime.gpu || '未検出'], ['VRAM', runtime.memory_gb ? `${runtime.memory_gb} GB` : '—'], ['PyTorch', runtime.torch || '未導入'], ['CUDA', runtime.cuda || '—'], ['Python', runtime.python], ['状態', runtime.error || (runtime.cuda_available ? 'GPU動作確認済み' : 'CPUで利用可能')]];
    $('hardwareInfo').innerHTML = rows.map(([key, value]) => `<span>${escapeHTML(key)}</span><b>${escapeHTML(value)}</b>`).join('');
    updateRuntime();
  } catch (error) { $('deviceHelp').textContent = error.message; }
}
function setSettings(open) {
  if (open) { settingsFocus = document.activeElement; fillSettings(state?.settings.training); }
  for (const id of ['settingsPanel', 'settingsOverlay']) { $(id).hidden = !open; $(id).classList.toggle('active', open); }
  $('settingsBtn').setAttribute('aria-expanded', String(open));
  if (open) $('deviceInput').focus(); else settingsFocus?.focus();
}
function actionLabel(action, pos) {
  const p = pos?.pieces.find(p => p.id === action.piece);
  return `${action.side} ${action.type === 'drop' ? `${pieces[action.kind]}打` : `${p ? pieces[p.kind] : action.piece}(${p?.at.join(',') || '?'})`}→${action.to.join(',')}${action.choice === 'promote' ? ' 成' : action.choice === 'upgrade' ? ' +1' : ''}`;
}
async function loadReplay() {
  const file = $('replaySelect').value;
  const requestedRun = selectedRun;
  if (!file || !requestedRun) {
    replay = null; $('replayVerified').textContent = '未選択'; $('probeButton').disabled = true;
    $('board').innerHTML = empty('棋譜を選択してください。'); $('replayEvents').innerHTML = ''; $('replayHands').textContent = '';
    return;
  }
  $('replayVerified').textContent = '検証中'; $('probeButton').disabled = true;
  const round = Math.max(1, Number($('replayRound').value) || 1);
  try {
    const incoming = await request(`/api/replay?run=${encodeURIComponent(requestedRun)}&file=${encodeURIComponent(file)}&round=${round}`);
    if (selectedRun !== requestedRun || $('replaySelect').value !== file || Number($('replayRound').value) !== round) return;
    replay = incoming;
    $('replayRound').max = String(replay.rounds); $('replayRound').value = String(round);
    $('replayVerified').textContent = `✓ 検証済み · ${replay.rounds}ラウンド`;
    options($('stageSelect'), [{ value: '-1', label: '最終局面' }, ...replay.resolution.frames.map((frame, i) => ({ value: String(i), label: frame.stage === 0 ? '開始局面' : `段階 ${frame.stage}` }))], '-1');
    renderBoard();
    const outcome = replay.record.outcome;
    const r = replay.resolution;
    const actionText = r.actions.map(a => actionLabel(a, r.frames[0] || { pieces: [] })).join(' / ');
    $('replayEvents').innerHTML = `<div class="event-item"><div><b>同時に指定した着手</b>${escapeHTML(actionText)}</div></div>` + (outcome ? `<div class="event-item"><div><b>${outcome.winner === 'draw' ? '引き分け' : `${escapeHTML(outcome.winner)}側の勝ち`}</b>${escapeHTML(reasonNames[outcome.reason] || outcome.reason)}</div></div>` : '') + (r.events.length ? r.events.slice(0, 80).map(event => `<div class="event-item"><span class="event-stage">段階 ${event.stage ?? '—'}</span><div><b>${escapeHTML(eventNames[event.type] || event.type)}</b>${escapeHTML(event.type === 'capture' ? `${event.victimSide} ${pieces[event.kind] || event.kind} / ${reasonNames[event.reason] || event.reason}` : event.type === 'contact' ? `接触の判定 / ${reasonNames[event.reason] || event.reason || event.mode || ''}` : '')}<details><summary>詳細</summary><code>${escapeHTML(JSON.stringify(event))}</code></details></div></div>`).join('') : '<p class="hint">記録対象の捕獲・衝突イベントはありません。</p>');
    $('probeButton').disabled = !!state.job || !state.selected?.compatible;
  } catch (error) {
    if (selectedRun !== requestedRun || $('replaySelect').value !== file) return;
    replay = null; $('probeButton').disabled = true; $('replayVerified').textContent = '検証エラー';
    $('board').innerHTML = empty('棋譜を検証できませんでした。ルールの版と実行ログを確認してください。');
    toast(error.message, true);
  }
}
function renderBoard() {
  if (!replay) return;
  const frame = Number($('stageSelect').value), r = replay.resolution;
  const position = frame >= 0 ? r.frames[frame] : r;
  const map = new Map(position.pieces.map(p => [p.at.join(','), p]));
  let cells = '';
  for (let y = 1; y <= 9; y++) for (let x = 9; x >= 1; x--) {
    const p = map.get(`${x},${y}`), balance = replay.rules.balance;
    const nominal = p ? ({ K: 0, P: 1, L: 2, N: 3, S: 4, G: 5, R: 6, B: 6 }[p.kind] + Number(p.upgraded && !p.promoted) + (balance?.rankOffset || 0)) : 0;
    const activity = p && frame < 0 ? r.activity?.[p.id] : null;
    const loss = balance?.movement === 'progressive' ? activity?.fatigue || 0 : balance?.movement === 'upgrade_only' && nominal === 7 && (activity?.streak || 0) >= balance.consecutiveThreshold ? 1 : 0;
    const rank = Math.max(0,nominal-loss);
    cells += `<div class="board-cell" aria-label="${x},${y}${p ? ` ${p.side} ${p.promoted ? promoted[p.kind] : pieces[p.kind]} 格${rank}` : ' 空き'}">${p ? `<span class="piece ${p.side === 'B' ? 'enemy' : ''} ${p.promoted ? 'promoted' : ''} ${p.upgraded ? 'upgraded' : ''}" title="${escapeHTML(p.id)}">${p.promoted ? promoted[p.kind] || pieces[p.kind] : pieces[p.kind]}<small>${rank}</small></span>` : ''}</div>`;
  }
  $('board').innerHTML = `<div class="shogi-board" role="img" aria-label="ラウンド${$('replayRound').value} ${frame >= 0 ? `段階${r.frames[frame].stage}` : '最終局面'}の盤面">${cells}</div>` + (replay.rules.balance ? `<p class="hint">${frame >= 0 ? '段階盤面は通常格を表示。疲労・防御補正を適用した衝突時の格はイベント詳細に記録しています。' : '格は連続移動の補正後。自陣防御補正は移動中同士の衝突時だけ適用します。'}</p>` : '');
  $('replayHands').textContent = '持ち駒（ラウンド解決後）：' + ['A', 'B'].map(side => `${side} ${Object.entries(r.hands[side]).map(([k, n]) => `${pieces[k]}${n}`).join(' ') || 'なし'}`).join(' / ');
}
async function loadProbe() {
  const file = $('probeSelect').value;
  const requestedRun = selectedRun;
  if (!file) { $('probeDetails').innerHTML = empty('分析記録を選択してください。'); return; }
  try {
    const probe = await request(`/api/artifact?run=${encodeURIComponent(requestedRun)}&file=${encodeURIComponent(file)}`);
    if (selectedRun !== requestedRun || $('probeSelect').value !== file) return;
    const labels = probe.candidates.map(options => options.map(a => actionLabel(a, probe.state.position)));
    $('probeDetails').className = '';
    $('probeDetails').innerHTML = `<div class="probe-meta">${tag(`G${probe.generation} / ラウンド${probe.round}`)}<span>候補内の最適応答差：${number(probe.restricted_gap, 4)}</span><span>${probe.matrix.length} × ${probe.matrix[0].length} 候補</span></div><p class="hint">評価値はA側の視点（−1〜+1）。見出しの割合は、候補内で求めた混合戦略です。</p><div class="matrix-wrap"><table class="payoff-matrix"><thead><tr><th>A ↓ / B →</th>${labels[1].map((label, i) => `<th>${escapeHTML(label)}<br>${percent(probe.strategies[1][i])}</th>`).join('')}</tr></thead><tbody>${probe.matrix.map((row, i) => `<tr><th>${escapeHTML(labels[0][i])}<br>${percent(probe.strategies[0][i])}</th>${row.map(v => `<td style="background:${v > 0 ? `rgba(17,17,17,${Math.abs(v) * .3})` : `rgba(142,142,142,${Math.abs(v) * .3})`}">${number(v, 2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="hint">候補外の反撃や深い変化はこの評価に含みません。元の棋譜と合わせて確認してください。</p>`;
  } catch (error) { toast(error.message, true); }
}
async function compare() {
  const id = $('compareRun').value;
  const requestedRun = selectedRun;
  if (!id || !state.selected) { $('comparison').innerHTML = empty('別の実行を選ぶと、条件と結果を並べて表示します。'); return; }
  try {
    const response = await request(`/api/state?run=${encodeURIComponent(id)}`), a = state.selected, b = response.selected;
    if (selectedRun !== requestedRun || $('compareRun').value !== id) return;
    const fields = [['実行', r => r.manifest.name], ['ルール', r => `${r.manifest.rules.profile} / 上限${r.manifest.rules.roundLimit}`], ['ルール識別子', r => r.manifest.rules_hash.slice(0, 12)], ['ソース識別子', r => r.manifest.source_fingerprint.slice(0, 12)], ['最新世代', r => `G${r.manifest.generation}`], ['探索候補数', r => `${r.manifest.config.candidates}×${r.manifest.config.candidates}`], ['自己対戦の種', r => r.manifest.config.seed], ['ハードウェア', r => r.manifest.hardware.gpu || r.manifest.hardware.platform], ...['hunter', 'defense', 'upgrade'].map(name => [`対・${name}`, r => { const e = r.history.at(-1)?.evaluation.find(e => e.opponent === name); return e ? `${percent(e.score)} [${percent(e.interval[0])}–${percent(e.interval[1])}]` : '未評価'; }])];
    $('comparison').innerHTML = `<div class="notice">${a.manifest.rules_hash !== b.manifest.rules_hash ? 'ルール条件が異なります。別の比較群として扱い、成績を混ぜません。' : 'ルール識別子は一致しています。ソース、探索予算、世代数、評価ペア数も確認してください。'}</div><div class="table-wrap"><table class="compare-table"><thead><tr><th>条件</th><th>表示中</th><th>比較先</th></tr></thead><tbody>${fields.map(([label, value]) => `<tr><td>${escapeHTML(label)}</td><td>${escapeHTML(value(a))}</td><td>${escapeHTML(value(b))}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (error) { toast(error.message, true); }
}
async function research() {
  try {
    const sources = await request('/api/research');
    $('researchCards').innerHTML = sources.map(source => `<article class="card research-card"><div class="small">${escapeHTML(source.category)}</div><h3>${escapeHTML(source.title)}</h3>${tag(source.status, source.status === '検討・保留' ? 'amber' : '')}<p class="body-copy">${escapeHTML(source.summary)}</p><p class="hint">この実装：${escapeHTML(source.decision)}</p><a href="${escapeHTML(source.url)}" target="_blank" rel="noreferrer">一次資料を読む ↗</a></article>`).join('');
  } catch (error) { $('researchCards').innerHTML = empty(error.message); }
}
export function stopPolling() { clearInterval(polling); clearTimeout(toastTimer); }
export async function mount({ pollMilliseconds = 3000 } = {}) {
  document.addEventListener('click', async event => {
    const oldRun=event.target.closest('[data-history-run]');
    if(oldRun){selectedRun=oldRun.dataset.historyRun;selectedGeneration=null;await refresh();selectGeneration(Number(oldRun.dataset.historyGeneration));return;}
    const view = event.target.closest('[data-view]');
    if (view) { showView(view.dataset.view); return; }
    const generation = event.target.closest('[data-gen]');
    if (generation && state) selectGeneration(Number(generation.dataset.gen));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('settingsPanel').hidden) setSettings(false);
    if (event.key === 'Tab' && !$('settingsPanel').hidden) {
      const controls = [...$('settingsPanel').querySelectorAll('button, input, select, summary')].filter(e => !e.disabled && (!e.closest('details') || e.tagName === 'SUMMARY' || e.closest('details').open));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.target.matches('[data-gen]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  $('refresh').addEventListener('click', refresh);
  $('latestGeneration').addEventListener('click',()=>{selectedGeneration=null;clearReplay();history.replaceState(null,'',`?run=${encodeURIComponent(selectedRun)}`);render();});
  $('runSelect').addEventListener('change', async () => { selectedRun = $('runSelect').value; selectedGeneration = null; replay = null; history.replaceState(null, '', `?run=${encodeURIComponent(selectedRun)}`); await refresh(); });
  $('localStart').addEventListener('click', async () => { selectedRun = ''; selectedGeneration = null; await action('/api/start', { mode: 'local' }, '学習を開始しました。'); });
  $('smokeStart').addEventListener('click', () => { setSettings(false); selectedRun = ''; action('/api/start', { mode: 'smoke' }, 'CPUで動作確認を開始しました。'); });
  $('stopJob').addEventListener('click', () => action('/api/stop', {}, '停止を依頼しました。学習は最後に確定した世代から再開できます。'));
  $('resumeButton').addEventListener('click', () => action('/api/resume', { run: selectedRun,until_generation:Number($('resumeUntil').value) }, '保存した学習設定で、確定済み世代から再開します。'));
  $('continueButton').addEventListener('click',async()=>{const run=selectedRun;selectedRun='';selectedGeneration=null;await action('/api/continue',{run},'重み・最適化器・乱数・リプレイを引き継ぎます。準備後に「再開」で次の世代へ進めます。');});
  for (const id of ['settingsBtn', 'welcomeSettings']) $(id).addEventListener('click', () => setSettings(true));
  for (const id of ['settingsClose', 'settingsOverlay']) $(id).addEventListener('click', () => setSettings(false));
  $('runtimeRefresh').addEventListener('click', () => loadRuntime(true));
  $('trainingForm').addEventListener('submit', async event => {
    event.preventDefault();
    const training = { device: $('deviceInput').value, amp: $('ampInput').checked,
      external_ai_enabled: $('externalAIEnabled').checked, external_ai_save_teacher: $('teacherSaveInput').checked };
    for (const input of document.querySelectorAll('[data-setting]')) training[input.dataset.setting] = Number(input.value) / (input.dataset.setting === 'external_ai_fraction' ? 100 : 1);
    $('saveSettings').disabled = true; $('settingsError').textContent = '';
    try { await request('/api/settings', { training }); await refresh(); setSettings(false); toast('設定を保存しました。次回の開始・再開から反映します。'); }
    catch (error) { $('settingsError').textContent = error.message; }
    finally { $('saveSettings').disabled = false; }
  });
  $('benchmarkButton').addEventListener('click', () => action('/api/benchmark', {}, '同じ局面群で、既存方式と高速版を計測します。'));
  $('evalOpponent').addEventListener('change', updateRuntime);
  $('evaluateForm').addEventListener('submit', event => { event.preventDefault(); action('/api/evaluate', { run: selectedRun, opponent: $('evalOpponent').value, pairs: Number($('evalPairs').value), nodes: Number($('evalNodes').value) }, 'ローカルでの対戦評価を開始しました。'); });
  $('refreshTeachers').addEventListener('click', refresh);
  $('setupExternalAI').addEventListener('click', () => action('/api/external/setup', {}, '公開エンジンと評価関数の準備を開始しました。'));
  $('distillSource').addEventListener('change', renderDistillation);
  $('distillDataset').addEventListener('change', renderDistillation);
  $('distillForm').addEventListener('submit', event => {
    event.preventDefault();
    action('/api/distill', { run: $('distillSource').value, dataset: $('distillDataset').value,
      checkpoint: $('distillCheckpoint').value === '' ? 'latest' : Number($('distillCheckpoint').value),
      updates: Number($('distillUpdates').value), device: $('distillDevice').value }, '教師データから別モデルへの蒸留を開始しました。');
  });
  $('sourceForm').addEventListener('submit', async event => { event.preventDefault(); await action('/api/settings', { source_dir: $('sourceDir').value }, '同期フォルダーを保存しました。'); });
  $('importZip').addEventListener('change', async () => {
    const file = $('importZip').files[0];
    if (!file) return;
    $('importState').textContent = '結果を読み込んでいます…';
    try {
      if (file.size > 256 * 1024 ** 2) throw new Error('256 MB以下のZIPを選択してください。');
      const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      selectedRun = ''; selectedGeneration = null; $('importState').textContent = '取り込みました。実行選択から確認できます。';
      await refresh(); toast('Colabの学習結果を取り込みました。');
    } catch (error) { $('importState').textContent = error.message; toast(error.message, true); }
    $('importZip').value = '';
  });
  $('replaySelect').addEventListener('change', () => { $('replayRound').value = '1'; loadReplay(); });
  $('replayRound').addEventListener('change', loadReplay);
  $('prevRound').addEventListener('click', () => { if (Number($('replayRound').value) > 1) { $('replayRound').value = String(Number($('replayRound').value) - 1); loadReplay(); } });
  $('nextRound').addEventListener('click', () => { if (replay && Number($('replayRound').value) < replay.rounds) { $('replayRound').value = String(Number($('replayRound').value) + 1); loadReplay(); } });
  $('stageSelect').addEventListener('change', renderBoard);
  $('probeSelect').addEventListener('change', loadProbe);
  $('probeButton').addEventListener('click', () => action('/api/probe', { run: selectedRun, file: $('replaySelect').value, round: Number($('replayRound').value) }, '検証した局面を、16×16候補で再分析します。'));
  $('compareRun').addEventListener('change', compare);
  $('balanceExperiment').addEventListener('change', renderBalance);
  $('balanceInitForm').addEventListener('submit', event => {
    event.preventDefault();
    let grid;
    try { grid = $('balanceGrid').value.trim() ? JSON.parse($('balanceGrid').value) : undefined; }
    catch { toast('D+の設定値はJSONのオブジェクトで指定してください。', true); return; }
    action('/api/experiment/init', {run:$('balanceSource').value,pairs:Number($('balancePairs').value),parallel:Number($('balanceParallel').value),grid}, '同じ確定済みモデルから各ルールを準備します。');
  });
  for (const [id,stage] of [['balanceShort','short'],['balanceTrain','train'],['balanceLong','long']]) $(id).addEventListener('click', () => action('/api/experiment/run', {experiment:$('balanceExperiment').value,stage,generations:Number($('balanceGenerations').value),rule:stage==='train'?$('balanceRule').value:'all'}, stage === 'train' ? '選んだ条件の学習を開始します。' : '陣営を交換した対戦でルールを比較します。'));
  $('comparison').innerHTML = empty('別の実行を選ぶと、条件と結果を並べて表示します。');
  await refresh(); await Promise.all([research(), loadRuntime()]);
  if (pollMilliseconds > 0) polling = setInterval(refresh, pollMilliseconds);
}

await mount();
