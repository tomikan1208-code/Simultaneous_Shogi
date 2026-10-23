import { Effects } from './effects.js';
import { escape, icon, pieceMarkup, square, symbols } from './presentation.js';
import { demoPosition, demoScenes } from './rule-demo-scenes.js';
import type { DemoScene, DemoVariant } from './rule-demo-scenes.js';
import { PLAY_RULES } from './rules.js';
import type { Action, Piece, Position, Resolution, Side, Square } from './types.js';

type Pointer = Square | 'hand-A' | 'hand-B' | 'promote' | 'upgrade';
type Phase = 'intro'|'select'|'ready'|'move'|'clash'|'result'|'rewind';
interface Plan { side:Side; from?:Square; to:Square; label:string }
export interface DemoStep {
  position:Position;
  caption:string;
  phase:Phase;
  duration:number;
  variant:number;
  round:number;
  plans:Plan[];
  pointer?:Pointer;
  pointerSide?:Side;
  click?:boolean;
  selected?:string;
  candidate?:Square;
  choices?:boolean;
  choice?:'promote'|'upgrade';
  moving?:string[];
  impact?:Square;
  sound?:'select'|'move'|'clash';
}
type Resolve = (position:Position,actions:Action[])=>Promise<Resolution>;
const nextPosition = (result:Resolution):Position => ({
  pieces:result.pieces,hands:result.hands,dropBans:result.dropBans,
  moveBans:result.moveBans,nextPieceId:result.nextPieceId,activity:result.activity,
});
function stageHands(start:Position,result:Resolution,stage:number):Position['hands'] {
  if (stage>=result.frames[result.frames.length-1].stage) return result.hands;
  const hands = {A:{...start.hands.A},B:{...start.hands.B}};
  for (const event of result.events) if (event.stage<=stage && event.type==='drop') {
    const dropped = result.frames.flatMap(frame => frame.pieces).find(p => p.id===event.actor);
    if (dropped) hands[dropped.side][dropped.kind] = (hands[dropped.side][dropped.kind] ?? 0)-1;
  }
  for (const capture of result.captures) if (capture.stage<=stage && capture.kind!=='K') {
    hands[capture.captorSide][capture.kind] = (hands[capture.captorSide][capture.kind] ?? 0)+1;
  }
  return hands;
}
const visible = (at:Square,variant:DemoVariant):boolean => at[0]>=3 && at[0]<=7 && at[1]>=(variant.top ?? 3) && at[1]<(variant.top ?? 3)+5;
const phaseLabels:Record<Phase,string> = {intro:'初期配置',select:'一手を選ぶ',ready:'双方の一手が確定',move:'同時に移動',clash:'接触を判定',result:'結果',rewind:'巻き戻し'};

/** Every movement, capture and status change comes from the gameplay resolver.
 * The additional steps only demonstrate input, slow down contact and rewind. */
export async function buildDemoTimeline(scene:DemoScene,resolve:Resolve):Promise<DemoStep[]> {
  const timeline:DemoStep[] = [];
  for (let variantIndex=0;variantIndex<scene.variants.length;variantIndex++) {
    const variant = scene.variants[variantIndex];
    let position = demoPosition(variant);
    const rewind:DemoStep[] = [];
    for (let roundIndex=0;roundIndex<variant.rounds.length;roundIndex++) {
      const round = variant.rounds[roundIndex], plans:Plan[] = [];
      const base = {variant:variantIndex,round:roundIndex,plans};
      const add = (step:Omit<DemoStep,'variant'|'round'|'plans'> & {plans?:Plan[]}):DemoStep => {
        const complete:DemoStep = {...base,...step,plans:[...(step.plans ?? plans)]};
        timeline.push(complete); return complete;
      };
      rewind.push(add({position,caption:round.intro,phase:'intro',duration:1500}));
      const result = await resolve(position,round.actions);
      for (const action of round.actions) {
        const actor = action.type === 'move' ? position.pieces.find(p => p.id === action.piece) : undefined;
        if (!visible(action.to,variant) || actor && !visible(actor.at,variant)) continue;
        const name = actor ? symbols[actor.kind] : action.type === 'drop' ? symbols[action.kind] : '駒';
        const who = action.side === 'A' ? 'あなた' : '相手';
        const pointer:Pointer = actor?.at ?? (action.side === 'A' ? 'hand-A' : 'hand-B');
        const selected = actor?.id;
        const caption = `${who}：${actor ? name : '持ち駒の'+name}をクリック。`;
        add({position,caption,phase:'select',pointer,pointerSide:action.side,duration:850});
        add({position,caption,phase:'select',pointer,pointerSide:action.side,click:true,selected,candidate:action.to,sound:'select',duration:650});
        add({position,caption:`${who}：${square(action.to)}のマスを選びます。`,phase:'select',pointer:action.to,pointerSide:action.side,selected,candidate:action.to,duration:1000});
        plans.push({side:action.side,from:actor?.at,to:action.to,label:`${square(action.to)} ${name}${action.type === 'drop' ? '打' : ''}`});
        add({position,caption:`${who}の移動先は、${square(action.to)}。`,phase:'select',pointer:action.to,pointerSide:action.side,click:true,selected,sound:'select',duration:800});
        if (action.type === 'move' && action.choice !== 'none') {
          const choice = action.choice;
          add({position,caption:'ここでは「成り」と「昇格」を選べます。',phase:'select',choices:true,pointer:choice,pointerSide:action.side,duration:1100});
          add({position,caption:choice === 'promote' ? '「成る」を選択。' : '「昇格 +1」を選択。',phase:'select',choices:true,choice,pointer:choice,pointerSide:action.side,click:true,sound:'select',duration:900});
        }
      }
      add({position,caption:plans.length===2 ? '双方の一手が揃いました。同時に動き始めます。' : '一手が確定。選んだ駒が動きます。',phase:'ready',duration:1150});
      const moving = round.actions.flatMap(action => action.type === 'move' ? [action.piece] : []);
      for (let frameIndex=1;frameIndex<result.frames.length;frameIndex++) {
        const frame = result.frames[frameIndex], previous = result.frames[frameIndex-1];
        const events = result.events.filter(event => event.stage===frame.stage);
        const contact = events.find(event => event.type==='contact');
        const capture = events.find(event => event.type==='capture');
        const equalDrop = events.find(event => event.type==='equal_drop_failure');
        const dropDuel = events.find(event => event.type==='drop_duel');
        const caption = round.captions?.[frame.stage];
        const state:Position = {...position,pieces:frame.pieces,hands:stageHands(position,result,frame.stage)};
        if (contact || capture || equalDrop || dropDuel) {
          const approaching = previous.pieces.map(p => {
            const plan = frame.plans.find(plan => plan.actor===p.id && plan.advance);
            return plan ? {...p,at:plan.next} : p;
          });
          const approachHands = stageHands(position,result,frame.stage-1);
          const held = {A:{...approachHands.A},B:{...approachHands.B}};
          // A drop can be captured immediately after a board piece moves. The
          // engine records that capture without retaining the dropped piece in
          // a frame; briefly show the recorded victim to explain that contact.
          for (const taken of result.captures.filter(c => c.stage===frame.stage && c.reason==='drop')) {
            if (!approaching.some(p => p.id===taken.victim)) {
              approaching.push({id:taken.victim,side:taken.victimSide,kind:taken.kind,at:taken.at,promoted:false,upgraded:false});
              held[taken.victimSide][taken.kind] = Math.max(0,(held[taken.victimSide][taken.kind] ?? 0)-1);
            }
          }
          const at = capture?.at ?? equalDrop?.to ?? dropDuel?.to ?? contact?.at;
          const impact:Square|undefined = at ? typeof at[0] === 'number' ? at as Square : (at as Square[])[0] : undefined;
          const approach = {...position,pieces:approaching,hands:held};
          add({position:approach,caption:caption ?? '選んだ先へ、同時に駒が進みます。',phase:'move',moving,sound:equalDrop || dropDuel ? undefined : 'move',duration:850});
          const collisionCaption = contact?.reason==='chain' ? '味方が取られたマスで、取り返し！'
            : contact?.reason==='rank' ? `格 ${contact.ranks?.join(' 対 ')}。${contact.mode==='swap' ? 'すれ違いも' : '動く駒同士で'}衝突。`
            : equalDrop ? '同じマスへ、同じ格の駒を同時打ち。'
            : dropDuel ? '同じマスへの同時打ち。格の高い方だけが残ります。'
            : capture?.reason==='drop' ? '打ち駒より、盤上から動いた駒を優先。' : '止まっている敵駒を取ります。';
          add({position:approach,caption:collisionCaption,phase:'clash',moving,impact,sound:contact?.reason==='rank' || contact?.reason==='chain' || equalDrop || dropDuel ? 'clash' : 'move',duration:950});
          rewind.push(add({position:state,caption:caption ?? (frameIndex===result.frames.length-1 ? round.result : '取られた駒が盤上から消えます。'),phase:'move',moving,duration:1450}));
        } else {
          rewind.push(add({position:state,caption:caption ?? '同じ段階に、それぞれ次のマスへ進みます。',phase:'move',moving,sound:events.some(event => event.type==='move' || event.type==='drop') ? 'move' : undefined,duration:1400}));
        }
      }
      position = nextPosition(result);
      rewind.push(add({position,caption:round.result,phase:'result',duration:2900}));
    }
    // Reverse the actual board states without replaying the input clicks.
    for (const step of rewind.slice(0,-1).reverse()) timeline.push({
      ...step,phase:'rewind',plans:[],moving:undefined,duration:500,
      caption:scene.variants.length>1 ? '初期配置へ戻して、次の例を見比べます。' : '最初の配置へ巻き戻します。',
    });
  }
  return timeline;
}

interface DemoHooks {
  resolve:Resolve;
  sound:()=>boolean;
  reduced:()=>boolean;
  toggleSound:()=>void;
  speed:()=>DemoSpeed;
  setSpeed:(speed:DemoSpeed)=>void;
}
export type DemoSpeed = 1|2|4;
interface DemoView {
  root:HTMLElement;
  stage:HTMLElement;
  board:HTMLElement;
  pieces:HTMLElement;
  cursor:HTMLElement;
  click:HTMLElement;
  paths:SVGSVGElement;
  impact:HTMLElement;
  caption:HTMLElement;
  phase:HTMLElement;
  progress:HTMLElement;
  play:HTMLButtonElement;
  variant:HTMLElement;
  actions:HTMLElement;
  choices:HTMLElement;
  tokens:Map<string,HTMLElement>;
}
const cursorMarkup = '<svg viewBox="0 0 28 34" preserveAspectRatio="none" aria-hidden="true"><path d="M3 2v25l6-6 5 10 5-2-5-10h9Z" fill="currentColor" stroke="#26312b" stroke-width="1.8" stroke-linejoin="round"/></svg>';

export class RuleDemos {
  private active:DemoScene|null = null;
  private views = new Map<string,DemoView>();
  private cache = new Map<string,Promise<DemoStep[]>>();
  private steps:DemoStep[] = [];
  private index = 0;
  private paused = false;
  private inView = true;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private deadline = 0;
  private remaining:number|null = null;
  private running = false;
  private speed:DemoSpeed = 1;
  private reducedMotion = false;
  private animations:Animation[] = [];
  private serial = 0;
  private observer:IntersectionObserver|null = null;
  private effects:Effects;

  constructor(private dialog:HTMLDialogElement,private hooks:DemoHooks) {
    this.effects = new Effects(hooks.reduced,() => hooks.sound() && dialog.open && !document.hidden);
    const list = dialog.querySelector<HTMLElement>('#rule-demos')!;
    list.innerHTML = demoScenes.map((scene,index) => `<details class="rule-item" data-rule="${scene.id}"><summary><span>${scene.title}</span><svg class="rule-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg></summary><div class="rule-content"><p class="rule-description">${scene.description}</p><div class="rule-demo" id="rule-demo-${scene.id}" role="group" aria-label="${escape(scene.title)}の実演"><div class="demo-heading"><span><i></i>5 × 5 の実演</span><span class="demo-variant">${scene.variants[0].label ?? 'ゆっくりループ再生'}</span></div><div class="demo-body"><div class="demo-stage"><div class="demo-hands"><span class="demo-hand" data-demo-hand="A"></span><span class="demo-hand" data-demo-hand="B"></span></div><div class="demo-files" aria-hidden="true">${[7,6,5,4,3].map(file=>`<span>${file}</span>`).join('')}</div><div class="demo-board-row"><div class="demo-board" role="img" aria-label="5×5の実演盤面"><div class="demo-cells" aria-hidden="true">${Array.from({length:25},(_,i)=>`<span data-demo-x="${7-i%5}" data-demo-row="${Math.floor(i/5)}"></span>`).join('')}</div><svg class="demo-paths" viewBox="0 0 100 100" aria-hidden="true"><defs><marker id="demo-arrow-${index}" markerWidth="5" markerHeight="5" refX="3" refY="2.5" orient="auto"><path d="M0 0 4 2.5 0 5" fill="none" stroke="context-stroke" stroke-width="1"/></marker></defs><g></g></svg><div class="demo-pieces" aria-hidden="true"></div><div class="demo-impact" aria-hidden="true"></div><div class="demo-choices" hidden><span data-demo-choice="promote">成る</span><span data-demo-choice="upgrade">昇格 +1</span></div></div><div class="demo-ranks" aria-hidden="true"></div></div><div class="demo-click" aria-hidden="true"></div><div class="demo-cursor" aria-hidden="true">${cursorMarkup}</div></div><div class="demo-explanation"><span class="demo-phase">初期配置</span><p class="demo-caption" role="status" aria-live="off"></p><div class="demo-actions"></div><div class="demo-legend"><span>▲ あなた</span><span>▼ 相手</span></div></div></div><div class="demo-footer"><div class="demo-buttons"><button type="button" data-demo-play aria-label="実演を一時停止">Ⅱ <span>一時停止</span></button><button type="button" data-demo-reset aria-label="実演を最初から再生">${icon('replay')}<span>最初から</span></button></div><button type="button" class="demo-sound" data-demo-sound></button></div><div class="demo-progress" aria-hidden="true"><span></span></div></div>${scene.note ? `<p class="rule-note">${scene.note}</p>` : ''}</div></details>`).join('');
    for (const scene of demoScenes) {
      const details = list.querySelector<HTMLDetailsElement>(`[data-rule="${scene.id}"]`)!;
      details.addEventListener('toggle',() => {
        if (details.open) {
          for (const other of list.querySelectorAll<HTMLDetailsElement>('details')) if (other!==details) other.open = false;
          void this.open(scene);
        } else if (this.active?.id===scene.id) this.deactivate();
      });
      const root = details.querySelector<HTMLElement>('.rule-demo')!;
      const get = <T extends Element = HTMLElement>(selector:string):T => root.querySelector<T>(selector)!;
      const view:DemoView = {
        root,stage:get('.demo-stage'),board:get('.demo-board'),pieces:get('.demo-pieces'),
        cursor:get('.demo-cursor'),click:get('.demo-click'),paths:get('.demo-paths'),impact:get('.demo-impact'),
        caption:get('.demo-caption'),phase:get('.demo-phase'),progress:get('.demo-progress > span'),
        play:get('[data-demo-play]'),variant:get('.demo-variant'),actions:get('.demo-actions'),choices:get('.demo-choices'),tokens:new Map(),
      };
      this.views.set(scene.id,view);
      view.play.addEventListener('click',() => {
        this.paused = !this.paused;
        if (this.paused) this.suspend(); else { this.effects.unlockAudio(); this.resume(); }
        this.updateControls();
      });
      get('[data-demo-reset]').addEventListener('click',() => {
        this.suspend(); this.clearAnimations(); this.index = 0; this.remaining = null; this.render(); this.resume();
      });
      get('[data-demo-sound]').addEventListener('click',() => {
        hooks.toggleSound(); this.syncPreferences(); this.effects.unlockAudio();
        if (hooks.sound()) this.effects.sound('select');
      });
    }
    dialog.addEventListener('pointerdown',() => this.effects.unlockAudio(),{passive:true});
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-demo-speed]')) button.addEventListener('click',() => {
      hooks.setSpeed(Number(button.dataset.demoSpeed) as DemoSpeed);
    });
    dialog.addEventListener('keydown',() => this.effects.unlockAudio());
    dialog.addEventListener('close',() => this.deactivate());
    new window.MutationObserver(() => {
      if (!dialog.open) this.deactivate();
      else if (!this.active) {
        const id = list.querySelector<HTMLDetailsElement>('details[open]')?.dataset.rule;
        const scene = demoScenes.find(scene => scene.id===id);
        if (scene) void this.open(scene);
      }
    }).observe(dialog,{attributes:true,attributeFilter:['open']});
    document.addEventListener('visibilitychange',() => { if (document.hidden) this.suspend(); else this.resume(); });
    window.addEventListener('resize',() => this.render());
    this.syncPreferences();
  }

  syncPreferences():void {
    const speed = this.hooks.speed();
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-demo-speed]')) {
      button.setAttribute('aria-pressed',String(Number(button.dataset.demoSpeed)===speed));
    }
    if (speed!==this.speed) {
      const wasRunning = this.running;
      // Preserve the unplayed portion in normal-speed milliseconds before
      // changing the clock rate, including while a scene is paused.
      this.suspend(); this.speed = speed; this.render();
      if (this.active) this.retimeAnimations(this.views.get(this.active.id)!);
      if (wasRunning) this.resume();
    }
    for (const view of this.views.values()) {
      const button = view.root.querySelector<HTMLButtonElement>('[data-demo-sound]')!;
      button.innerHTML = `${icon(this.hooks.sound() ? 'sound' : 'muted')}<span>音 ${this.hooks.sound() ? 'オン' : 'オフ'}</span>`;
      button.setAttribute('aria-pressed',String(this.hooks.sound()));
      button.setAttribute('aria-label','実演の効果音を'+(this.hooks.sound() ? 'オフ' : 'オン')+'にする');
    }
    this.effects.syncAudio();
    const reduced = this.hooks.reduced();
    if (this.active && reduced && !this.reducedMotion && !this.paused) { this.paused = true; this.suspend(); }
    this.reducedMotion = reduced;
    this.updateControls();
  }

  private async open(scene:DemoScene):Promise<void> {
    this.deactivate(); this.active = scene;
    const serial = this.serial, view = this.views.get(scene.id)!;
    this.paused = this.hooks.reduced(); this.inView = true;
    this.index = 0; this.remaining = null;
    view.caption.textContent = '実演を準備しています…';
    let loading = this.cache.get(scene.id);
    if (!loading) { loading = buildDemoTimeline(scene,this.hooks.resolve); this.cache.set(scene.id,loading); }
    try {
      const steps = await loading;
      if (serial!==this.serial || !this.dialog.open) return;
      this.steps = steps; this.render(); this.updateControls();
      if (typeof IntersectionObserver!=='undefined') {
        this.observer = new IntersectionObserver(entries => {
          if (serial!==this.serial) return;
          this.inView = entries[0].isIntersecting;
          if (this.inView) this.resume(); else this.suspend();
        },{root:this.dialog,threshold:0});
        this.observer.observe(view.root);
      }
      this.resume();
    } catch {
      if (serial!==this.serial) return;
      this.cache.delete(scene.id); view.caption.textContent = '実演を読み込めませんでした。項目を開き直すと再試行できます。';
      view.play.disabled = true;
    }
  }

  private deactivate():void {
    this.suspend(); this.clearAnimations(); this.observer?.disconnect(); this.observer = null;
    this.serial++; this.active = null; this.steps = [];
  }
  private suspend():void {
    if (this.timer!==undefined) {
      this.remaining = Math.max(0,(this.deadline-performance.now())*this.speed); clearTimeout(this.timer); this.timer = undefined;
    }
    if (this.running && this.active) {
      this.animations = this.views.get(this.active.id)!.root.getAnimations?.({subtree:true}).filter(animation => animation.playState==='running') ?? [];
      for (const animation of this.animations) animation.pause();
    }
    this.running = false; this.effects.stopAudio();
  }
  private clearAnimations():void { for (const animation of this.animations) animation.cancel(); this.animations = []; }
  private resume():void {
    if (this.running || this.paused || !this.inView || !this.dialog.open || document.hidden || !this.steps.length || !this.active) return;
    for (const animation of this.animations) animation.play(); this.animations = [];
    this.running = true; this.schedule(this.remaining ?? this.steps[this.index].duration);
  }
  private schedule(duration:number):void {
    const delay = duration/this.speed;
    this.remaining = null; this.deadline = performance.now()+delay;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      this.index = (this.index+1)%this.steps.length;
      this.render();
      const step = this.steps[this.index];
      if (step.sound) this.effects.sound(step.sound);
      this.schedule(step.duration);
    },delay);
  }
  private retimeAnimations(view:DemoView):void {
    for (const animation of view.root.getAnimations?.({subtree:true}) ?? []) animation.updatePlaybackRate(this.speed);
  }
  private updateControls():void {
    if (!this.active) return;
    const view = this.views.get(this.active.id)!;
    view.play.disabled = !this.steps.length;
    view.play.innerHTML = this.paused ? '▶ <span>再生</span>' : 'Ⅱ <span>一時停止</span>';
    view.play.setAttribute('aria-label',this.paused ? '実演を再生' : '実演を一時停止');
    view.play.setAttribute('aria-pressed',String(!this.paused));
    view.root.classList.toggle('demo-reduced',this.hooks.reduced());
  }

  private render():void {
    const scene = this.active, step = this.steps[this.index];
    if (!scene || !step) return;
    const view = this.views.get(scene.id)!, variant = scene.variants[step.variant], top = variant.top ?? 3;
    view.root.dataset.phase = step.phase; view.root.dataset.step = String(this.index);
    view.root.dataset.speed = String(this.speed);
    const point = (at:Square):[number,number] => [(7-at[0])*20+10,(at[1]-top)*20+10];
    view.root.querySelector('.demo-ranks')!.innerHTML = Array.from({length:5},(_,i)=>`<span>${'一二三四五六七八九'[top+i-1]}</span>`).join('');
    const living = new Set<string>();
    for (const p of step.position.pieces.filter(p => visible(p.at,variant))) {
      living.add(p.id);
      let token = view.tokens.get(p.id);
      if (!token) { token = document.createElement('span'); token.className = 'demo-token'; view.tokens.set(p.id,token); view.pieces.append(token); }
      token.dataset.demoPiece = p.id;
      const [x,y] = point(p.at);
      token.style.left = `${x}%`; token.style.top = `${y}%`;
      token.classList.toggle('demo-selected',step.selected===p.id);
      token.classList.toggle('demo-meeting',step.phase==='clash' && step.position.pieces.some(other => other.id!==p.id && other.at[0]===p.at[0] && other.at[1]===p.at[1]));
      token.style.setProperty('--meeting-shift',p.side==='A' ? '-12%' : '12%');
      token.classList.remove('demo-removed');
      const markup = pieceMarkup(p,p.side==='B',{rules:PLAY_RULES,activity:step.position.activity?.[p.id],moving:step.moving?.includes(p.id)});
      const content = markup+(p.upgraded && !p.promoted ? '<span class="demo-upgrade">+1</span>' : '');
      if (token.innerHTML!==content) token.innerHTML = content;
    }
    for (const [id,token] of view.tokens) if (!living.has(id)) token.classList.add('demo-removed');
    for (const cell of view.board.querySelectorAll<HTMLElement>('[data-demo-x]')) {
      const at:Square = [Number(cell.dataset.demoX),top+Number(cell.dataset.demoRow)];
      cell.classList.toggle('demo-target-a',step.plans.some(plan => plan.side==='A' && plan.to[0]===at[0] && plan.to[1]===at[1]));
      cell.classList.toggle('demo-target-b',step.plans.some(plan => plan.side==='B' && plan.to[0]===at[0] && plan.to[1]===at[1]));
      cell.classList.toggle('demo-candidate',step.candidate?.[0]===at[0] && step.candidate?.[1]===at[1]);
      cell.classList.toggle('demo-zone-edge',scene.id==='promotion' && at[1]===3 || scene.id==='defense' && at[1]===6);
    }
    view.paths.querySelector('g')!.innerHTML = step.plans.flatMap(plan => {
      if (!plan.from) return [];
      const [x1,y1] = point(plan.from), [x2,y2] = point(plan.to);
      return [`<path class="demo-route-${plan.side.toLowerCase()}" d="M${x1} ${y1}L${x2} ${y2}" marker-end="url(#${view.paths.querySelector('marker')!.id})"/>`];
    }).join('');
    view.phase.textContent = phaseLabels[step.phase]+(variant.rounds.length>1 ? ` · ${step.round+1}ラウンド目` : '');
    view.caption.textContent = step.caption;
    view.variant.textContent = variant.label ? `${step.variant+1} / ${scene.variants.length}　${variant.label}` : this.speed===1 ? 'ゆっくりループ再生' : `${this.speed}倍速でループ再生`;
    view.actions.innerHTML = (['A','B'] as const).map(side => {
      const plan = step.plans.find(plan => plan.side===side);
      const hidden = variant.rounds[step.round].actions.some(action => action.side===side && !visible(action.to,variant));
      return `<div class="demo-action demo-action-${side.toLowerCase()}"><span>${side==='A' ? '▲ あなた' : '▼ 相手'}</span><strong>${plan ? plan.label : hidden ? '別の駒を操作' : '選択待ち'}</strong></div>`;
    }).join('');
    for (const side of ['A','B'] as const) {
      const hand = view.root.querySelector<HTMLElement>(`[data-demo-hand="${side}"]`)!;
      const entries = Object.entries(step.position.hands[side]).filter(([,count]) => count);
      hand.innerHTML = entries.length ? `<span>${side==='A' ? '▲' : '▼'} 持ち駒</span> `+entries.map(([kind,count])=>`<b>${symbols[kind as Piece['kind']]}<small>${count}</small></b>`).join(' ') : '';
    }
    view.choices.hidden = !step.choices;
    for (const choice of view.choices.querySelectorAll<HTMLElement>('[data-demo-choice]')) choice.classList.toggle('demo-choice-selected',choice.dataset.demoChoice===step.choice);
    const target = Array.isArray(step.pointer)
      ? view.board.querySelector<HTMLElement>(`[data-demo-x="${step.pointer[0]}"][data-demo-row="${step.pointer[1]-top}"]`)
      : step.pointer?.startsWith('hand-') ? view.root.querySelector<HTMLElement>(`[data-demo-hand="${step.pointer.slice(-1)}"]`)
      : step.pointer ? view.choices.querySelector<HTMLElement>(`[data-demo-choice="${step.pointer}"]`) : null;
    view.cursor.classList.toggle('demo-pointer-visible',!!target);
    view.cursor.classList.toggle('demo-opponent',step.pointerSide==='B');
    view.click.classList.toggle('demo-opponent',step.pointerSide==='B');
    view.click.classList.toggle('demo-click-active',!!target && !!step.click);
    if (target) {
      const box = target.getBoundingClientRect(), stage = view.stage.getBoundingClientRect();
      for (const element of [view.cursor,view.click]) { element.style.left = `${box.left-stage.left+box.width/2}px`; element.style.top = `${box.top-stage.top+box.height/2}px`; }
    }
    view.impact.hidden = !step.impact;
    if (step.impact) { const [x,y] = point(step.impact); view.impact.style.left = `${x}%`; view.impact.style.top = `${y}%`; }
    view.progress.style.width = `${(this.index+1)/this.steps.length*100}%`;
    const onBoard = step.position.pieces.filter(p => visible(p.at,variant)).map(p => `${p.side==='A' ? 'あなた' : '相手'}の${p.promoted ? '成り' : ''}${symbols[p.kind]}が${square(p.at)}`).join('、');
    view.board.setAttribute('aria-label',`5×5の実演盤面。${onBoard || '盤上に駒はありません'}。${step.caption}`);
    this.retimeAnimations(view);
  }
}
