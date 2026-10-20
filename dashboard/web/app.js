const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value, decimals = 0) => Number.isFinite(value) ? value.toLocaleString('ja-JP', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) : '—';
const percent = value => Number.isFinite(value) ? `${number(value * 100, 1)}%` : '—';
const empty = text => `<div class="empty">${escapeHTML(text)}</div>`;
const tag = (text, kind = '') => `<span class="tag ${kind}">${escapeHTML(text)}</span>`;
const when = stamp => stamp ? new Date(stamp * 1000).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const decisions = { better: ['優位', ''], worse: ['劣位', 'red'], inconclusive: ['判定保留', 'amber'] };
const phases = { initializing: '初期化中', self_play: '自己対戦中', optimizing: 'ネットワーク更新中', evaluating: '棋力を評価中', generation_complete: '世代の保存完了', complete: '学習完了', stopped: '中断・保存済み', failed: '処理を確認してください' };
const titles = { overview: ['学習の概要', '一手ずつ、強くする。', '自己対戦、学習効率、棋力の変化をひとつの場所で。'], evaluation: ['棋力の評価・比較', '強さを、対戦で確かめる。', '同じルールと探索予算で、過去モデルや固定方策と比較します。'], analysis: ['棋譜・原因分析', '強い一手の、理由を探る。', '段階ごとの衝突・捕獲と、候補手の評価から局面を読み解きます。'], colab: ['Colab・データ連携', '学習はColab、確認は手元で。', 'ソースと結果の受け渡し、同期、再開をここから。'], research: ['研究と実装方針', '研究を、実測できる仕組みへ。', '既存の成果を比較し、このルールで効果を確かめながら育てます。'] };
const eventNames = { capture: '捕獲', contact: '同段階の接触', move: '移動', move_reached: '目的地に到着', move_captured: '移動駒が被捕獲', move_partial: '途中位置で停止', move_zero: '移動不成立', blocked: '味方障害による待機', drop_failure: '打ち込み不成立', drop: '打ち込み成立', drop_duel: '同時打ち', drop_wait: '打ち込み待機', drop_failed: '打ち込み不成立', change: '成り・昇格', promote: '成り', promotion: '成り', equal_drop_failure: '同格の同時打ち不成立', upgrade: '昇格', forced_promotion: '強制成り', wait: '味方障害による待機', mutual_capture: '相討ち', round_end: 'ラウンド終了' };
const reasonNames = { static: '非選択の停止駒への通常捕獲', chain: '連戦（除去後の反撃）', stopped: '移動後に停止した駒への通常捕獲', unmoved: '移動していない駒への通常捕獲', king_captured: '王の捕獲', king_captor_lost: '王捕獲者が後続に取られた', both_kings: '双方の王捕獲・捕獲時の格で比較', mutual: '同格の相討ち', stationary: '停止駒への通常捕獲', rank: '格比較', counter: '連戦', drop: '打ち駒との競合', repetition: '同一局面の反復', round_limit: 'ラウンド上限', king_capture: '王捕獲', king_captor_recaptured: '王捕獲者の後続被捕獲' };
const pieces = { K: '王', P: '歩', L: '香', N: '桂', S: '銀', G: '金', R: '飛', B: '角' };
const promoted = { P: 'と', L: '杏', N: '圭', S: '全', R: '龍', B: '馬' };
const opponentName = name => ({ champion: '基準モデル', hunter: 'hunter', defense: 'defense', upgrade: 'upgrade', random: 'random' }[name] || name);
let state = null, selectedRun = new URLSearchParams(location.search).get('run') || '', selectedGeneration = null;
let replay = null, renderedRun = null, currentView = 'overview', polling = null, requests = 0, toastTimer;

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
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  [$('pageCrumb').textContent, $('pageTitle').textContent, $('pageSubtitle').textContent] = titles[view];
}
function selectedRecord() {
  const history = state?.selected?.history || [];
  return history.find(r => r.generation === selectedGeneration) || history.at(-1);
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
  const values = series.flatMap(s => s.points).filter(p => Number.isFinite(p.y));
  if (!values.length) { container.innerHTML = empty('確定した世代の記録が集まると表示します。'); return; }
  const w = 500, h = 190, left = 38, right = 15, top = 12, bottom = 26;
  const maxX = Math.max(1, ...values.map(p => p.x)), minX = Math.min(1, ...values.map(p => p.x));
  const maxY = score ? 1 : Math.max(.01, ...values.map(p => p.y)) * 1.15;
  const x = v => left + (v - minX) / Math.max(1, maxX - minX) * (w - left - right);
  const y = v => top + (1 - v / maxY) * (h - top - bottom);
  const ticks = [0, .25, .5, .75, 1];
  let content = ticks.map(t => `<line x1="${left}" y1="${y(t * maxY)}" x2="${w - right}" y2="${y(t * maxY)}" stroke="#edf0e7" ${score && t === .5 ? 'stroke-dasharray="4 4"' : ''}/><text x="${left - 9}" y="${y(t * maxY) + 3}" class="chart-label" text-anchor="end">${score ? `${t * 100}%` : number(t * maxY, 1)}</text>`).join('');
  const tickX = [...new Set([minX, Math.round((minX + maxX) / 2), maxX])];
  content += tickX.map(g => `<text x="${x(g)}" y="${h - 6}" class="chart-label" text-anchor="middle">G${g}</text>`).join('');
  for (const s of series) {
    const points = s.points.filter(p => Number.isFinite(p.y));
    content += `<polyline class="chart-line" stroke="${s.color}" points="${points.map(p => `${x(p.x)},${y(p.y)}`).join(' ')}"/>`;
    content += points.map(p => `<g data-gen="${p.x}" role="button" tabindex="0" aria-label="世代${p.x}を選択"><circle cx="${x(p.x)}" cy="${y(p.y)}" r="8" fill="transparent"/><circle cx="${x(p.x)}" cy="${y(p.y)}" r="3" fill="${s.color}" stroke="#fff" stroke-width="1.5"/><title>${escapeHTML(s.name)} G${p.x}: ${score ? percent(p.y) : number(p.y, 3)}</title></g>`).join('');
  }
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${score ? '固定相手への得点率の推移' : '方策損失と価値損失の推移'}">${content}</svg><div class="chart-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${escapeHTML(s.name)}</span>`).join('')}</div>`;
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
  $('welcome').hidden = history.length > 0;
  $('statusUpdated').textContent = status.updated ? `最終記録 ${when(status.updated)} JST` : '記録待ち';
  const phase = phases[status.phase] || '学習記録の準備ができています';
  const progress = status.phase === 'complete' ? 100 : (status.generation || 0) / Math.max(1, status.target_generations || 1) * 100;
  const runningText = status.phase === 'self_play' || status.phase === 'evaluating' ? `${number(status.completed_games || 0)} / ${number(status.target_games)}局 ${status.opponent ? `· ${opponentName(status.opponent)}` : ''}` : status.phase === 'optimizing' ? `${status.update || 0} / ${status.target_updates} 更新` : manifest ? `${manifest.config.workers} worker · ${manifest.config.environments} environments · ${status.device || manifest.hardware.device}` : 'ColabまたはローカルCPUで最初の実行を開始';
  $('liveStatus').innerHTML = `<div class="status-symbol">${status.phase === 'complete' ? '✓' : '◈'}</div><div class="status-description"><h3>${escapeHTML(run ? phase : '学習を始める準備ができています')}${smoke ? tag('動作テスト', 'amber') : ''}</h3><p>${escapeHTML(runningText)}</p></div><div class="status-progress"><div class="progress-label"><span>${manifest ? `G${status.generation ?? manifest.generation} / ${manifest.config.generations} 世代` : '初回セットアップ待ち'}</span><span>${number(progress)}%</span></div><div class="progress-track"><span style="width:${Math.min(100, progress)}%"></span></div></div>`;
  const totalGames = history.reduce((n, r) => n + r.self_play.games, 0), totalSamples = history.reduce((n, r) => n + r.self_play.new_samples, 0);
  const cps = record ? record.self_play.rounds / record.self_play.seconds : null;
  const gateRecord = history.filter(r => r.generation <= (record?.generation || 0) && r.evaluation.some(e => e.opponent === 'champion')).at(-1);
  const gate = gateRecord?.evaluation.find(e => e.opponent === 'champion');
  const cards = [
    ['完了した世代', number(manifest?.generation), '世代', manifest ? `${manifest.config.generations}世代まで計画 / 基準 G${manifest.champion_generation}` : '世代ごとに再開可能な状態を保存'],
    ['自己対戦の対局数', run ? number(totalGames) : '—', '局', run ? `${number(totalSamples)} 新規サンプルを収集` : '途中の対局は完了後に記録'],
    ['自己対戦スループット', number(cps, 1), 'round / 秒', record ? `G${record.generation} / 推論・探索・転送を含む` : '実行環境と一緒に実測値を保存'],
    ['対・基準モデルの得点率', percent(gate?.score), '', gate ? `G${gateRecord.generation} / 区間 ${percent(gate.interval[0])}–${percent(gate.interval[1])}` : '陣営交換・固定予算で比較']
  ];
  $('kpis').innerHTML = cards.map(([label, value, unit, note]) => `<article class="kpi"><div class="kpi-label">${label}<span>↗</span></div><div class="kpi-value">${value}<small>${unit}</small></div><p class="kpi-foot">${escapeHTML(note)}</p></article>`).join('');
  plot($('strengthChart'), ['hunter', 'defense', 'upgrade'].map((name, i) => ({ name, color: ['#638567', '#baaa7a', '#879bc1'][i], points: history.map(r => ({ x: r.generation, y: r.evaluation.find(e => e.opponent === name)?.score })) })), true);
  plot($('lossChart'), [{ name: '方策損失', color: '#638567', points: history.map(r => ({ x: r.generation, y: r.optimization.policy_loss })) }, { name: '価値損失', color: '#baaa7a', points: history.map(r => ({ x: r.generation, y: r.optimization.value_loss })) }]);
  if (record) {
    const search = record.self_play.search, total = record.self_play.seconds;
    const timings = [['方策・特徴量', search.policy_seconds], ['Rust局面探索・転送', search.preview_seconds], ['局面のバッチ推論', search.value_seconds], ['混合戦略の計算', search.solver_seconds]];
    timings.push(['実着手・記録など', Math.max(0, total - timings.reduce((s, r) => s + r[1], 0))]);
    $('efficiency').innerHTML = timings.map(([label, seconds]) => `<div class="timing-row"><span>${label}</span><div class="timing-track"><i style="width:${seconds / Math.max(total, .001) * 100}%"></i></div><b>${number(seconds, 2)} 秒</b></div>`).join('') + `<div class="mini-stat-grid"><span>重複局面の推論削減<b>${percent(1 - search.unique_leaves / Math.max(1, search.cells))}</b></span><span>サンプル再利用<b>${number(record.optimization.presentations / Math.max(1, record.self_play.new_samples), 1)} 回</b></span><span>過去モデルとの対局<b>${record.self_play.history_games} / ${record.self_play.games}</b></span></div>`;
  } else $('efficiency').innerHTML = empty('実行後に、時間の内訳と再利用率を表示します。');
  $('gateSummary').innerHTML = gateMarkup(gate, smoke) + (gate && gateRecord.generation !== record.generation ? `<p class="hint">直近の評価 G${gateRecord.generation} を表示。この世代は学習を優先し、対戦評価を省略しています。</p>` : '');
  $('generationTable').innerHTML = history.length ? history.slice().reverse().map(r => {
    const g = r.evaluation.find(e => e.opponent === 'champion');
    return `<tr class="${r.generation === record?.generation ? 'selected' : ''}"><td><button class="generation-link" data-gen="${r.generation}">G${r.generation.toString().padStart(3, '0')}</button></td><td>${number(r.self_play.games)} 局</td><td>${number(r.self_play.new_samples)}</td><td>${number(r.self_play.rounds / r.self_play.seconds, 1)}</td><td>${number(r.optimization.policy_loss, 3)}</td><td class="score-cell">${percent(g?.score)}</td><td>${tag(smoke ? '動作テスト' : r.promoted ? '昇格' : r.evaluation.length ? '継続評価' : '学習更新', smoke || !r.promoted && r.evaluation.length ? 'amber' : '')}</td></tr>`;
  }).join('') : '<tr><td colspan="7">確定した世代はまだありません。</td></tr>';
}
function renderEvaluation() {
  const run = state.selected, record = selectedRecord(), manifest = run?.manifest;
  $('evalGeneration').textContent = record ? `G${record.generation} / ${manifest.rules.profile} / 上限${manifest.rules.roundLimit}ラウンド` : '評価結果がまだありません';
  $('evaluationTable').innerHTML = record?.evaluation.length ? record.evaluation.map(e => {
    const [label, kind] = decisions[e.decision] || decisions.inconclusive;
    return `<tr><td>${escapeHTML(opponentName(e.opponent))}</td><td>${e.wins} / ${e.draws} / ${e.losses}</td><td class="score-cell">${percent(e.score)}</td><td>${percent(e.interval[0])}–${percent(e.interval[1])}<span class="confidence">${number(e.confidence * 100, 1)}%</span></td><td>${e.games} 局</td><td>${tag(manifest.rules.roundLimit !== 200 ? '動作テスト' : label, kind)}</td></tr>`;
  }).join('') : '<tr><td colspan="6">この世代の対戦評価はありません。評価した世代を概要の表から選択できます。</td></tr>';
  $('championInfo').innerHTML = manifest ? `<div class="meta-grid"><span>基準モデル</span><b>G${manifest.champion_generation}</b><span>最終モデル</span><b>G${manifest.generation}</b><span>探索予算</span><b>最大 ${manifest.config.candidates} × ${manifest.config.candidates} 候補 / ${manifest.config.regret_iterations} 反復</b><span>昇格の基準</span><b>対・基準モデルの補正済み区間の下限 &gt; 50%</b><span>条件</span><b>${manifest.rules.roundLimit === 200 ? '正式上限200ラウンド' : '短縮テスト・昇格対象外'} / ${manifest.planned_gates}回の判定を事前計画</b></div>` : empty('モデルを読み込むと、基準と条件を表示します。');
  const evaluations = run?.local_evaluations?.filter(Boolean) || [];
  $('localEvaluations').innerHTML = evaluations.length ? evaluations.map(e => `<div class="evaluation-entry"><span>対・${escapeHTML(opponentName(e.opponent))}</span><b>${percent(e.score)}</b><span>${e.games}局 / ${percent(e.interval[0])}–${percent(e.interval[1])}</span>${tag((decisions[e.decision] || decisions.inconclusive)[0], (decisions[e.decision] || decisions.inconclusive)[1])}</div>`).join('') : empty('上のフォームから、読み込んだモデルを追加評価できます。');
}
function renderAnalysis() {
  const run = state.selected;
  const files = run?.artifacts || [];
  options($('replaySelect'), [{ value: '', label: '棋譜を選択' }, ...files.filter(p => p.startsWith('games/') || p.includes('-replay-')).map(file => ({ value: file, label: file.replace('.json', '') }))]);
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
function render() {
  const run = state.selected, busy = !!state.job;
  $('rulesVersion').textContent = state.rules_version ? `v${state.rules_version}` : '—';
  if (run && renderedRun !== run.id) {
    renderedRun = run.id; selectedRun = run.id; selectedGeneration = null; replay = null;
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
  $('connectionText').textContent = 'ローカル接続'; $('connectionDot').style.background = '#66876b';
  const notices = [...state.warnings];
  if (run && !run.compatible) notices.push('学習時と現在のソースが異なります。記録は閲覧できます。再評価・学習再開には学習時のソースを使用してください。');
  if (run?.status.phase === 'failed') notices.push(`前回の処理が失敗しました: ${run.status.error || '実行ログを確認してください。'}`);
  if (run && ['self_play', 'evaluating', 'optimizing'].includes(run.status.phase) && Date.now() / 1000 - run.status.updated > 180) notices.push('進捗の最終記録から3分以上経過しています。ColabとDriveの同期状況を確認してください。');
  if (state.last_job?.code && !state.job) notices.push('ローカル処理が失敗しました。「Colab・データ連携」の実行ログを確認してください。');
  $('globalNotice').textContent = notices.join(' '); $('globalNotice').hidden = !notices.length;
  $('localStart').disabled = busy; $('stopJob').disabled = !busy; $('benchmarkButton').disabled = busy;
  $('evaluateButton').disabled = busy || !run?.compatible;
  $('resumeButton').disabled = busy || !run?.compatible || run.manifest.generation >= run.manifest.config.generations;
  $('probeButton').disabled = busy || !run?.compatible || !replay;
  if (document.activeElement !== $('sourceDir')) $('sourceDir').value = state.settings.source_dir;
  $('jobLabel').textContent = state.job ? ({ training: 'ローカル学習中', evaluation: 'ローカル評価中', probe: '局面を再分析中', benchmark: '計測中' }[state.job.kind] || state.job.kind) : state.last_job ? (state.last_job.code === 0 ? '処理完了' : 'エラー') : '待機中';
  $('jobLogs').textContent = state.logs.join('\n') || 'ローカル処理のログがここに表示されます。';
  $('exportRun').hidden = !run;
  $('exportRun').href = `/api/export?run=${encodeURIComponent(selectedRun)}`;
  $('sourceSnapshot').hidden = !run?.source_snapshot;
  $('sourceSnapshot').href = `/api/source-snapshot?run=${encodeURIComponent(selectedRun)}`;
  renderOverview(); renderEvaluation(); renderAnalysis(); renderBenchmark();
}
export async function refresh() {
  const id = ++requests;
  try {
    const next = await request(`/api/state${selectedRun ? `?run=${encodeURIComponent(selectedRun)}` : ''}`);
    if (id !== requests) return;
    state = next; render();
  } catch (error) {
    $('connectionText').textContent = '接続を確認してください'; $('connectionDot').style.background = '#b17c61';
    $('globalNotice').textContent = error.message; $('globalNotice').hidden = false;
  }
}
async function action(endpoint, data, message) {
  try { await request(endpoint, data); toast(message); await refresh(); } catch (error) { toast(error.message, true); }
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
    const p = map.get(`${x},${y}`), rank = p ? ({ K: 0, P: 1, L: 2, N: 3, S: 4, G: 5, R: 6, B: 6 }[p.kind] + Number(p.upgraded)) : 0;
    cells += `<div class="board-cell" aria-label="${x},${y}${p ? ` ${p.side} ${p.promoted ? promoted[p.kind] : pieces[p.kind]} 格${rank}` : ' 空き'}">${p ? `<span class="piece ${p.side === 'B' ? 'enemy' : ''} ${p.promoted ? 'promoted' : ''} ${p.upgraded ? 'upgraded' : ''}" title="${escapeHTML(p.id)}">${p.promoted ? promoted[p.kind] || pieces[p.kind] : pieces[p.kind]}<small>${rank}</small></span>` : ''}</div>`;
  }
  $('board').innerHTML = `<div class="shogi-board" role="img" aria-label="ラウンド${$('replayRound').value} ${frame >= 0 ? `段階${r.frames[frame].stage}` : '最終局面'}の盤面">${cells}</div>`;
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
    $('probeDetails').innerHTML = `<div class="probe-meta">${tag(`G${probe.generation} / ラウンド${probe.round}`)}<span>候補内の最適応答差：${number(probe.restricted_gap, 4)}</span><span>${probe.matrix.length} × ${probe.matrix[0].length} 候補</span></div><p class="hint">評価値はA側の視点（−1〜+1）。見出しの割合は、候補内で求めた混合戦略です。</p><div class="matrix-wrap"><table class="payoff-matrix"><thead><tr><th>A ↓ / B →</th>${labels[1].map((label, i) => `<th>${escapeHTML(label)}<br>${percent(probe.strategies[1][i])}</th>`).join('')}</tr></thead><tbody>${probe.matrix.map((row, i) => `<tr><th>${escapeHTML(labels[0][i])}<br>${percent(probe.strategies[0][i])}</th>${row.map(v => `<td style="background:${v > 0 ? `rgba(116,151,99,${Math.abs(v) * .3})` : `rgba(190,143,116,${Math.abs(v) * .3})`}">${number(v, 2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="hint">候補外の反撃や深い変化はこの評価に含みません。元の棋譜と合わせて確認してください。</p>`;
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
  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]');
    if (view) { showView(view.dataset.view); return; }
    const generation = event.target.closest('[data-gen]');
    if (generation && state) { selectedGeneration = Number(generation.dataset.gen); render(); }
  });
  document.addEventListener('keydown', event => { if (event.target.matches('[data-gen]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); } });
  $('refresh').addEventListener('click', refresh);
  $('runSelect').addEventListener('change', async () => { selectedRun = $('runSelect').value; selectedGeneration = null; replay = null; history.replaceState(null, '', `?run=${encodeURIComponent(selectedRun)}`); await refresh(); });
  $('localStart').addEventListener('click', () => action('/api/start', { mode: 'smoke' }, 'CPUで短い動作確認を開始しました。実行記録が数秒後に現れます。'));
  $('stopJob').addEventListener('click', () => action('/api/stop', {}, '停止を依頼しました。学習は最後に確定した世代から再開できます。'));
  $('resumeButton').addEventListener('click', () => action('/api/resume', { run: selectedRun }, '最後に保存した世代からCPUで再開します。'));
  $('benchmarkButton').addEventListener('click', () => action('/api/benchmark', {}, '同じ局面群で、既存方式と高速版を計測します。'));
  $('evaluateForm').addEventListener('submit', event => { event.preventDefault(); action('/api/evaluate', { run: selectedRun, opponent: $('evalOpponent').value, pairs: Number($('evalPairs').value) }, 'ローカルでの対戦評価を開始しました。'); });
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
  $('comparison').innerHTML = empty('別の実行を選ぶと、条件と結果を並べて表示します。');
  await refresh(); await research();
  if (pollMilliseconds > 0) polling = setInterval(refresh, pollMilliseconds);
}

await mount();
